// Reads that may give undefined as Kotlin: maybeUndefined, optional chains' ends and undefined converted to a type.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { isLibGlobal } from '../semantics/globals.ts';
import { cast, earlyBacking, ident, isFunctionType, isNullable, kotlinString, optionalType, safeCast, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { elementReceiverCell, keyName, isEnumObject, receiverCell, receiverSlot } from '../semantics/placement.ts';
import { nullableTypeNode, uncheckedMatch } from '../semantics/lang.ts';
import { isLibDeclaration, isWriteTarget } from '../semantics/ast.ts';
import { isKit, isNamed, isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';

export const optionalChainsMethods = {
	maybeUndefined(this: Translator, e: ts.Expression): string | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		// `a ?? b` of objects where `b` may be missing too: missing then.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && !this.library && this.isObjectRef(e) && !isNullable(this.typeOf(e))) {
			if (this.states.missingObject(e)) {
				const code = this.expr(e);
				if (this.isAsserted(code)) return this.unasserted(code);
			}
			const rightMaybe = this.maybeUndefined(e.right);
			if (rightMaybe) return `(${this.coerce(e.left, optionalType(this.typeOf(e)))} ?: ${rightMaybe})`;
		}
		// A kit method whose Kotlin signature returns nullable (`ViewBase.getViewById`: `ViewBase?`) though core's typings say present.
		if (ts.isCallExpression(e) && !this.library && !this.nullOk.has(e) && !isNullable(this.typeOf(e)) && this.isObjectRef(e) && !isFunctionType(this.typeOf(e)) && this.core?.kitNil?.(e)) {
			this.nullOk.add(e);
			try {
				return this.expr(e);
			} finally {
				this.nullOk.delete(e);
			}
		}
		// `x as T | undefined` / `x as T | null` where non-strictNullChecks stripped the union: safe cast returning nullable.
		if ((ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) && !this.library && !isNullable(this.typeOf(e)) && this.isObjectRef(e) && this.isObjectRef(e.expression) && nullableTypeNode(e.type)) {
			return safeCast(this.expr(e.expression), this.typeOf(e));
		}
		const assertion = this.assertedUntyped(e);
		if (assertion) return this.assertedOptional(assertion);
		// A non-strict app's optional member, as its shape holds it.
		const shapeOptSym = ts.isPropertyAccessExpression(e) && !e.questionDotToken && !(e.flags & ts.NodeFlags.OptionalChain) ? this.checker.getSymbolAtLocation(e.name) : undefined;
		const shapeOpt = !!shapeOptSym && this.states.shapeFieldOptional(shapeOptSym) && (['String', 'Double', 'Boolean'].includes(this.typeOf(e)) || this.states.unsetMember(shapeOptSym.valueDeclaration ?? shapeOptSym.declarations?.[0]));
		if (ts.isPropertyAccessExpression(e) && ((this.isLenientOptionalMember(e) && ['String', 'Double', 'Boolean'].includes(this.typeOf(e))) || shapeOpt)) {
			const untyped = this.untypedMemberRead(e);
			if (untyped) return untyped;
			this.nullOk.add(e);
			try {
				return this.expr(e);
			} finally {
				this.nullOk.delete(e);
			}
		}
		// Library mode: `<T[]>record[key]`, an assertion of the type the read has: the read.
		if (this.library && (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) && !this.subst.has(e) && this.typeOf(e) === this.typeOf(e.expression)) return this.maybeUndefined(e.expression);
		const awaited = this.awaited(e);
		if (awaited) return awaited.raw;
		if (this.subst.has(e)) return null;
		// No match, which code checked without strictNullChecks types as one: the null Kotlin's match gives.
		if (uncheckedMatch(e, this.checker)) return this.expr(e);
		// A call of a function Kotlin declares to give a nullable string, number or boolean (`'dark' | 'light' | null`): as it gives it.
		if (ts.isCallExpression(e) && (['String', 'Double', 'Boolean'].includes(this.typeOf(e)) || this.widenedObjectCall(e)) && this.unwrapsResult(e)) {
			this.rawResults.add(e);
			try {
				return this.expr(e);
			} finally {
				this.rawResults.delete(e);
			}
		}
		if (this.library && this.untypedAssertion(e)) return this.fromAny(this.expr((e as ts.AsExpression).expression), optionalType(this.typeOf(e)));
		// `a?.b as T` from an untyped value: undefined where the chain stops, whatever the assertion says.
		if (ts.isAsExpression(e) && ts.isOptionalChain(e.expression) && this.isAny(e.expression) && !isNullable(this.typeOf(e))) {
			return this.fromAny(this.expr(e.expression), optionalType(this.typeOf(e)));
		}
		if (ts.isPropertyAccessExpression(e) && !isWriteTarget(e) && this.augmentedMember(e) && !this.isAny(e) && !this.typeOf(e).endsWith('?')) {
			return this.fromAny(this.augmentedRead(e)!, optionalType(this.typeOf(e)));
		}
		// `Enum[value]` of a value no member has: undefined, though TypeScript types it a string.
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && !ts.isStringLiteral(e.argumentExpression) && isEnumObject(this.placement, e.expression) && !this.typeOf(e).endsWith('?')) {
			const code = `${this.expr(e.expression)}.jsEnumObject.jsGet(${this.propertyKey(e.argumentExpression)})`;
			return this.isAny(e) ? code : this.fromAny(code, optionalType(this.typeOf(e)));
		}
		// A key of a dictionary-typed object, read before its type's zero stands in for a missing one.
		if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && !e.questionDotToken && !isWriteTarget(e) && (this.library ? /^JSRecord<.*>\??$/ : /^JSRecord<.*>$/).test(this.typeOf(e.expression)) && !this.typeOf(e).endsWith('?')) {
			const key = ts.isPropertyAccessExpression(e) ? kotlinString(e.name.text) : this.str(e.argumentExpression);
			const record = this.expr(e.expression);
			// Library mode: a record field core declares and sets (`this._observers`), read as script reads it.
			const read = `${this.typeOf(e.expression).endsWith('?') || this.isAsserted(record) ? this.present(record, ts.isPropertyAccessExpression(e) ? e.name.text : e.argumentExpression, e.expression) : record}[${key}]`;
			// Library mode: an untyped value narrowed where it is read.
			return this.library && isNamed(spelledType(this.typeOf(e.expression)), 'JSRecord<Any?>', false) && !this.isAny(e) ? this.fromAnyCode(read, optionalType(this.typeOf(e)), true) : read;
		}
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && this.typeOf(e.expression) === 'String' && !ts.isStringLiteral(e.argumentExpression) && this.typeOf(e.argumentExpression) === 'Double') {
			const k = e.argumentExpression;
			return `${RT.jsCharAtOrUndefined}(${this.receiver(e.expression, ts.isNumericLiteral(k) || ts.isStringLiteral(k) ? k.text : k.getText()) ?? this.expr(e.expression)}, ${this.toNumber(k)})`;
		}
		// A match's group that took no part in it: undefined, though TypeScript types every element a string.
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && isNamed(spelledType(this.typeOf(e.expression)), 'JSMatch', false) && !this.typeOf(e).endsWith('?')) {
			const q = e.questionDotToken || this.typeOf(e.expression).endsWith('?') ? '?' : '';
			const match = uncheckedMatch(e.expression, this.checker) ? `(${this.expr(e.expression)} ?: ${RT.jsCannotReadNull}(${this.keyText(e.argumentExpression)}))` : this.expr(e.expression);
			return `${match}${q}.get(${this.toNumber(e.argumentExpression)})`;
		}
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && isKit(spelledType(this.typeOf(e.expression).replace(/\?$/, '')), 'JSArray')) {
			// App code's array Kotlin holds nullable, read by index outside an optional chain: JavaScript's TypeError where it is missing.
			const missing = !this.library && !e.questionDotToken && !(e.flags & ts.NodeFlags.OptionalChain) && this.typeOf(e.expression).endsWith('?');
			const q = !missing && (e.questionDotToken || this.typeOf(e.expression).endsWith('?') || (e.flags & ts.NodeFlags.OptionalChain && ts.isPropertyAccessExpression(e.expression) && e.expression.questionDotToken)) ? '?' : '';
			const array = this.expr(e.expression);
			// A chain's element that may be missing, indexed (`g?.[1][0]`): checked inside the chain.
			const linked = !e.questionDotToken && ts.isOptionalChain(e) ? receiverCell(this.receivers, receiverSlot(e.expression, keyName(e.argumentExpression))) : null;
			const cell = linked?.cell === 'chained' ? linked : elementReceiverCell(this.receivers, e);
			const receiver = cell.cell === 'present' || cell.cell === 'chained' ? this.receiverCode(cell, keyName(e.argumentExpression))! : missing || this.isAsserted(array) ? this.present(array, e.argumentExpression, e.expression) : array;
			const read = `${receiver}${q}.element(${this.toNumber(e.argumentExpression)})`;
			// A package's untyped element TypeScript narrows (`Array.isArray(args[0])`, a type guard), or a tuple's element where the
			// tuple is held as an untyped array: read as typed.
			const narrowed = this.typeOf(e);
			const tupleHeld = this.checker.isTupleType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression)));
			if (/^JSArray<Any\?>\??$/.test(this.typeOf(e.expression)) && !isUntyped(spelledType(narrowed)) && !/^(String|Double|Boolean)\??$/.test(narrowed) && !this.library && (tupleHeld || this.pluginFiles.has(e.getSourceFile().fileName))) return this.fromAny(read, optionalType(narrowed));
			return read;
		}
		if (ts.isIdentifier(e)) {
			const sym = this.resolve(e);
			if (sym && this.undefinedVars.has(sym)) return ident(e.text);
			if (this.states.narrowedMissing(e) && !this.rawNames.has(e)) {
				this.rawNames.add(e);
				try {
					return this.expr(e);
				} finally {
					this.rawNames.delete(e);
				}
			}
		}
		if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword && !isWriteTarget(e)) {
			const d = this.resolve(e.name)?.valueDeclaration;
			if (d && ts.isPropertyDeclaration(d) && this.earlyField(d)) return `${this.expr(e.expression)}.${earlyBacking(e.name.text)}`;
		}
		// Library mode: an optional chain's string, number or boolean (`bundle?.getString(key)`) is undefined where the chain stops.
		// Library mode: `<View>view.parent`, cast where a nullable slot takes it: missing as null.
		if (this.library && (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) && this.isObjectType(this.typeOf(e)) && !isNullable(this.typeOf(e)) && !this.native?.type(this.checker.getTypeAtLocation(e))) {
			let inner = e.expression;
			while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
			if ((ts.isPropertyAccessExpression(inner) || ts.isIdentifier(inner)) && !this.isAny(inner) && isNullable(this.declaredTypeOf(inner) ?? '')) {
				this.nullOk.add(inner);
				try {
					const target = optionalType(this.typeOf(e));
					return this.isClassDowncast(e) ? safeCast(this.expr(inner), target.slice(0, -1)) : cast(this.expr(inner), target);
				} finally {
					this.nullOk.delete(inner);
				}
			}
		}
		// `a && a.b()` of objects: missing where `a` is.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && this.isObjectType(this.typeOf(e)) && !isNullable(this.typeOf(e)) && !isFunctionType(this.typeOf(e)) && (this.isObjectType(this.typeOf(e.left)) || ['String', 'Double', 'Boolean'].includes(this.typeOf(e.left).replace(/\?$/, ''))) && this.typeOf(e.left).replace(/\?$/, '') !== this.typeOf(e).replace(/\?$/, '')) {
			return `(if (${this.cond(e.left)}) ${this.coerce(e.right, optionalType(this.typeOf(e)))} else null)`;
		}
		// `a || b` of objects: missing where both are.
		if (!this.library && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken && this.isObjectType(this.typeOf(e)) && !isNullable(this.typeOf(e)) && !isFunctionType(this.typeOf(e)) && this.typeOf(e.left) === this.typeOf(e)) {
			const v = this.fresh('__v');
			return `run { val ${v} = ${this.maybeUndefined(e.left) ?? this.expr(e.left)}; if (${RT.jsTruthy}(${v})) ${v} else ${this.coerce(e.right, optionalType(this.typeOf(e)))} }`;
		}
		// An optional chain's object (`this.owner?.get()`, typed present where null checks are off) is missing where the chain stops.
		if (!this.library && (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) && e.flags & ts.NodeFlags.OptionalChain && !this.optionalReads.has(e) && this.isObjectType(this.typeOf(e)) && !isNullable(this.typeOf(e)) && !isFunctionType(this.typeOf(e))) {
			this.optionalReads.add(e);
			try {
				const code = this.expr(e);
				return this.unasserted(code);
			} finally {
				this.optionalReads.delete(e);
			}
		}
		// So is a map's `get` of a key it may lack.
		const mapGet = (this.library || this.lenientApp) && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'get' && /^JS(Weak)?Map</.test(this.typeOf(e.expression.expression));
		if ((this.library || mapGet) && ts.isCallExpression(e) && (e.flags & ts.NodeFlags.OptionalChain || mapGet) && !this.optionalReads.has(e) && (mapGet || ['String', 'Double', 'Boolean'].includes(this.typeOf(e)))) {
			this.optionalReads.add(e);
			try {
				const code = this.expr(e);
				if (this.isAsserted(code)) return this.unasserted(code);
				const m = this.marks.markOf(code);
				// An entry read, or that read converted (`(m.get(k) ?: false)`).
				const entry = m?.op === 'entry' || (m?.op === 'undefinedAs' && m.of.mark?.op === 'entry');
				if (mapGet && entry) return code;
			} finally {
				this.optionalReads.delete(e);
			}
		}
		// Library mode: a member of an untyped object, where a nullable slot takes it: missing as null.
		if (
			this.library &&
			ts.isPropertyAccessExpression(e) &&
			!isWriteTarget(e) &&
			e.name.text !== 'prototype' &&
			this.isAny(e.expression) &&
			!this.staticOwnRead(e) &&
			(['String', 'Double', 'Boolean'].includes(this.typeOf(e)) || ((this.isObjectType(this.typeOf(e)) || isFunctionType(this.typeOf(e))) && !isNullable(this.typeOf(e)))) &&
			!(ts.isCallExpression(e.parent) && e.parent.expression === e) &&
			!((ts.isPropertyAccessExpression(e.parent) || ts.isElementAccessExpression(e.parent)) && e.parent.expression === e) &&
			!(ts.isIdentifier(e.expression) && (isLibGlobal(this, e.expression) || this.namesClass(e.expression)))
		) {
			return this.fromAny(`${e.questionDotToken ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(e.expression)}, ${kotlinString(e.name.text)})`, optionalType(this.typeOf(e)));
		}
		// So is an element of one (`this._gestureObservers[type]`), an array or object it may not have.
		if (this.library && ts.isElementAccessExpression(e) && !e.questionDotToken && !isWriteTarget(e) && this.isAny(e.expression) && this.isObjectType(this.typeOf(e)) && !isNullable(this.typeOf(e)) && !(ts.isCallExpression(e.parent) && e.parent.expression === e) && !((ts.isPropertyAccessExpression(e.parent) || ts.isElementAccessExpression(e.parent)) && e.parent.expression === e)) {
			return this.fromAny(`${RT.jsGet}(${this.expr(e.expression)}, ${this.propertyKey(e.argumentExpression)})`, optionalType(this.typeOf(e)));
		}
		// Library mode: a member core's declarations type that its compiled class holds untyped (`Style.fontStyle`): missing as null.
		if (this.library && ts.isPropertyAccessExpression(e) && !e.questionDotToken && !isWriteTarget(e) && !this.isAny(e)) {
			const sym = this.checker.getSymbolAtLocation(e.name);
			const d = sym?.valueDeclaration;
			const own = d && ts.isPropertyDeclaration(d) && !d.getSourceFile().isDeclarationFile && ts.isClassLike(d.parent) ? d : d && d.getSourceFile().isDeclarationFile && !isLibDeclaration(d) && !this.native?.isNativeDeclaration(d) ? this.compiledField(this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression)), e.name.text) : undefined;
			if (own && this.isAny(own.name)) return this.fromAny(`${this.typeOf(e.expression).endsWith('?') ? this.present(this.expr(e.expression), e.name.text, e.expression) : this.expr(e.expression)}.${ident(e.name.text)}`, optionalType(this.typeOf(e)));
		}
		// Lenient code: `list.pop()`, `list.shift()`, `list.find(…)` give undefined when there is none, whatever the type says.
		if ((this.lenient || this.lenientApp) && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['pop', 'shift', 'find', 'findLast'].includes(e.expression.name.text) && isKit(spelledType(this.typeOf(e.expression.expression).replace(/\?$/, '')), 'JSArray') && !isNullable(this.typeOf(e)) && !this.isAny(e)) return this.expr(e);
		if (ts.isPropertyAccessExpression(e) && e.questionDotToken && !this.typeOf(e.expression).endsWith('?')) {
			const target = this.maybeUndefined(e.expression);
			if (target) return this.native?.methodValue?.(e, target) ?? `${target}?.${ident(e.name.text)}`;
		}
		return null;
	},

	/** `a?.b`, `a?.b()`, `a?.[k]` (in parentheses or not): Kotlin's chain gives a nullable whatever TypeScript's type says. */
	optionalChainEnd(this: Translator, e: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		return (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e)) && !!(e.flags & ts.NodeFlags.OptionalChain);
	},

	/**
	 * A member read or call that continues an optional chain (`items?.getItems().forEach(…)`) past a link Kotlin holds
	 * nullable though TypeScript types it present: where the chain stopped nothing more of it runs, as in JavaScript.
	 */
	continuedChain(this: Translator, e: ts.Expression, target: ts.Expression, translate: () => string): string | null {
		if (this.subst.has(target) || !ts.isOptionalChain(target) || !(e.flags & ts.NodeFlags.OptionalChain)) return null;
		const read = ts.isCallExpression(e) ? e.expression : e;
		const key = ts.isPropertyAccessExpression(read) ? read.name.text : ts.isElementAccessExpression(read) ? keyName(read.argumentExpression) : null;
		const cell = key === null ? null : receiverCell(this.receivers, receiverSlot(target, key));
		const code = cell?.cell === 'chained' ? this.receiverCode(cell, key!)! : this.expr(target);
		if (cell?.cell !== 'chained' && !this.isAsserted(code)) return null;
		const v = this.fresh('__c');
		this.subst.set(target, v);
		let inner: string;
		try {
			inner = translate();
		} finally {
			this.subst.delete(target);
		}
		// Nullable, as the end of any optional chain is (`optionalChainEnd`).
		return `${cell?.cell === 'chained' ? code : this.unasserted(code)}?.let { ${v} -> ${inner} }`;
	},

	/**
	 * A string, number or boolean read `e` of type `t` as the optional it holds, where it converts undefined (a read, or
	 * a choice one of whose branches does); null where it converts nothing.
	 */
	/* convertedOptional is installed from semantics/lowering-methods.ts */

	/**
	 * App and plugin code's string, number or boolean read that converts undefined (`(x ?: "undefined")`): the nullable it
	 * converts, for a use that takes undefined as it is (a comparison, a receiver's TypeError). Null for any other code.
	 */
	undefinedConverted(this: Translator, code: string): string | null {
		const m = this.marks.markOf(code);
		return !this.library && m?.op === 'undefinedAs' && !m.to.optional && ['String', 'Double', 'Boolean'].includes(m.to.name) ? m.of.code : null;
	},

	/** An undefined-or-value as the TypeScript type reads it: NaN, "undefined" and false are what undefined converts to. */
	undefinedAs(this: Translator, code: string, type: string): string {
		if (isNullable(type) || isUntyped(spelledType(type))) return code;
		const zero = type === 'Double' ? 'Double.NaN' : type === 'String' ? '"undefined"' : type === 'Boolean' ? 'false' : null;
		if (zero) heldLoss('undefinedAs', zero);
		return zero ? this.marks.marked(`(${code} ?: ${zero})`, { op: 'undefinedAs', to: parseNativeType(type), of: this.marks.valueOf(code) }) : this.asserted(code);
	},
};
