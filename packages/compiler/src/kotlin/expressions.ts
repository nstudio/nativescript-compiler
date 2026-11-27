// Expressions and access as Kotlin: dispatch, identifiers, properties, elements.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { propertyKeyCode, templateSubstitution } from '../semantics/apis/operators.ts';
import { BUFFER_TYPES } from '../semantics/globals.ts';
import { branch, cast, escapeText, functionTypeParts, ident, isFunctionType, isNullable, kotlinString, numberLiteral, optionalType, safeCast, RT, assertedReader } from './syntax.ts';
import type { Translator } from './translator.ts';
import { awaitedCell, isEnumObject, nullishField } from '../semantics/placement.ts';
import { globalProxyUse, isStringRaw, readWrite, statementLevel, templateParts } from '../semantics/lang.ts';
import { readKeyOf } from '../semantics/nullish.ts';
import { convertedRead, onlyNull } from '../semantics/states/predicates.ts';
import { isLibDeclaration, isWriteTarget } from '../semantics/ast.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { notedField } from '../semantics/shapes.ts';
import { optionalContext } from '../semantics/spelled.ts';
import { atLossSite, HELD_LOSS } from '../semantics/losses.ts';

/** A string, number or boolean's null as JavaScript converts it: 0, "null", false. */
export const nullAs = (code: string, type: string): string => {
	const zero = type === 'Double' ? '0.0' : type === 'String' ? '"null"' : 'false';
	heldLoss('nullAs', zero);
	return `(${code} ?: ${zero})`;
};

export const expressionsMethods = {
	expr(this: Translator, e: ts.Expression): string {
		const at = this.translating;
		this.translating = e;
		try {
			return HELD_LOSS ? atLossSite('kotlin', this, e, () => this.exprCode(e)) : this.exprCode(e);
		} finally {
			this.translating = at;
		}
	},

	exprCode(this: Translator, e: ts.Expression): string {
		this.refuseScopedExpr(e);
		if (this.heldParts.has(e)) return this.subst.get(e)!;
		if (globalProxyUse(e, this.checker)) throw this.limit(e, 'proxy', '`Proxy`');
		if (ts.isCallExpression(e) && !this.nullishCalls.has(e) && !this.subst.has(e) && this.states.nullishRead(e)) return `${this.nullishCode(e)}${this.lenientApp ? '.jsAny' : '.optional'}`;
		if (nullishField(this, e) && !this.nullishCalls.has(e) && !this.subst.has(e)) {
			const use = this.states.nullishFieldUse(e);
			const m = use === 'member' && this.states.nullishMemberKey(e);
			return m ? `${this.nullishCode(e)}.${m.set ? 'presentToSet' : 'present'}(${kotlinString(m.key)})` : `${this.nullishCode(e)}${use === 'converted' ? '.jsAny' : '.optional'}`;
		}
		if (!this.nullishReceivers.has(e) && this.states.nullishElementReceiver(e)) {
			this.nullishReceivers.add(e);
			try {
				return `${this.expr(e)}?.optional`;
			} finally {
				this.nullishReceivers.delete(e);
			}
		}
		const awaited = this.awaitSlots.get(e),
			key = awaited ? readKeyOf(e) : null;
		if (awaited && key !== null) return this.receiverCode(awaitedCell(awaited), key)!;
		const s = this.subst.get(e);
		if (s) return s;
		const narrowed = this.narrowedHeld(e);
		if (narrowed) {
			this.rawHeld.add(e);
			try {
				const raw = this.expr(e);
				return this.checkedConvert(raw, narrowed, e) ?? this.checkedCast(raw, this.type(narrowed.type, e));
			} finally {
				this.rawHeld.delete(e);
			}
		}
		if (ts.isParenthesizedExpression(e)) return `(${this.expr(e.expression)})`;
		const rw = readWrite(e, this.checker);
		if (rw && ((rw.value && !rw.stored) || rw.held.length) && !rw.held.some((h) => this.subst.has(h))) return this.readWriteCode(e, rw);
		// An accessor's getter need not give back what its setter took, so the value is the one read or the one assigned.
		const logical = ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(e.operatorToken.kind);
		if (logical && ts.isPropertyAccessExpression(e.left) && !statementLevel(e) && (this.checker.getSymbolAtLocation(e.left.name)?.flags ?? 0) & ts.SymbolFlags.Accessor) {
			const read = this.fresh('__read'),
				value = this.fresh('__value');
			const op = e.operatorToken.kind;
			const test = op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ? `${RT.jsTruthy}(${read})` : op === ts.SyntaxKind.BarBarEqualsToken ? `!${RT.jsTruthy}(${read})` : `${RT.jsIsNullish}(${read})`;
			const target = this.declaredTypeOf(e.left) ?? this.typeOf(e.left);
			const assigned = `val ${value} = ${this.stored(e.right, e.left, target)}`;
			const kept = isNullable(target) ? this.undefinedAs(read, this.typeOf(e)) : read;
			this.subst.set(e.right, value);
			try {
				return `run { val ${read} = ${this.expr(e.left)}; if (${test}) { ${assigned}; ${this.assignment(e.left, e.right)}; ${value} } else ${kept} }`;
			} finally {
				this.subst.delete(e.right);
			}
		}
		// `return (s += x)`: a compound assignment's value is its target after it (Kotlin's assignment has none).
		if (ts.isBinaryExpression(e) && e.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment && e.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment && !statementLevel(e)) {
			// `(slot ??= new Map()).set(…)`: the target as the expression's type, which the target itself may hold untyped.
			const after = this.expr(e.left);
			const t = this.typeOf(e);
			const untyped = this.isAny(e.left) || after.startsWith(`${RT.jsGet}(`);
			// A record's entry reads back nullable, though TypeScript types it as the value.
			const entry = ts.isElementAccessExpression(e.left) && isKit(spelledType(this.typeOf(e.left.expression).replace(/\?$/, '')), 'JSRecord') && t !== 'Unit' && !isNullable(t);
			// `x ??= v` is never nullish after it where null checks are strict (lenient code may assign a missing value).
			const assigned = !this.lenient && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken && !isUntyped(spelledType(t)) && !isNullable(t) && isNullable(this.shapes.question(() => this.declaredTypeOf(e.left) ?? this.typeOf(e.left)));
			return `run { ${this.binary(e)}; ${untyped && !isUntyped(spelledType(t)) && t !== 'Unit' ? this.checkedCast(after, t) : entry || assigned ? this.asserted(after) : after} }`;
		}
		// `x = ([a, b] = [b, a])`: the right side's value.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && !statementLevel(e) && (ts.isArrayLiteralExpression(e.left) || ts.isObjectLiteralExpression(e.left)) && !this.subst.has(e.right)) {
			const tmp = this.fresh('__swap');
			const assigns: string[] = [];
			this.assignPattern(e.left, tmp, this.untypedSource(e.right) ? null : this.checker.getTypeAtLocation(e.right), assigns);
			return `run { val ${tmp} = ${this.expr(e.right)}; ${assigns.join('; ')}; ${tmp} }`;
		}
		// `(info.name = v)` as a value: the value assigned, evaluated once (Kotlin's assignment has none).
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && !statementLevel(e) && !ts.isArrayLiteralExpression(e.left) && !this.subst.has(e.right)) {
			// An object literal is held as the script object it is made as (`a = b = { value: 10, unit: 'px' }`).
			let last: ts.Expression = e.right;
			while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.EqualsToken) last = last.right;
			const target = (this.declaredTypeOf(e.left) ?? this.typeOf(e.left)).replace(/\?$/, '');
			// A literal stored into a typed target is made as that target's shape.
			const shaped = !this.library && ts.isObjectLiteralExpression(last) && !isUntyped(spelledType(target)) && target !== 'Unit' && !isKit(spelledType(target), 'JSObject') ? (ts.isIdentifier(e.left) ? (this.declaredTypeOf(e.left) ?? target) : target) : null;
			let t = shaped ?? (this.typeOf(e.right) === 'Unit' || (!this.library && ts.isObjectLiteralExpression(last)) ? 'Any?' : this.typeOf(e.right));
			// `a = b = null`: null of the target's type.
			const unset = e.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e.right) && e.right.text === 'undefined');
			if (this.library && unset && !this.isAny(e.left)) t = optionalType(this.typeOf(e.left));
			// App mode: `(action = actions.shift()!)`, `(action = actions[0])` or `(x = y = null!)` of a target held nullable: the
			// value as it is, which neither `!` nor an element read checks.
			const asserted = (x: ts.Expression): boolean => {
				const b = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
				return ts.isNonNullExpression(b) || ts.isElementAccessExpression(b) || (ts.isBinaryExpression(b) && b.operatorToken.kind === ts.SyntaxKind.EqualsToken && asserted(b.right));
			};
			const held = !this.library && asserted(e.right) ? (this.declaredTypeOf(e.left) ?? this.typeOf(e.left)) : null;
			if (held && isNullable(held)) t = held;
			// App mode: `a = b = undefined` of targets of other types: undefined, which each holds.
			else if (!this.library && ts.isIdentifier(e.right) && e.right.text === 'undefined' && ts.isBinaryExpression(e.parent) && e.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && e.parent.right === e) t = 'Nothing?';
			// Library mode: a target declared nullable (`let match: RegExpExecArray` set from `exec`) holds what may be missing.
			if (this.library && this.isObjectType(t) && this.declaredTypeOf(e.left) === optionalType(t) && this.nullTolerant(e)) t = optionalType(t);
			// `(map[k] = [])`: TypeScript types the empty literal `never[]`; it is made as the target's array, the one stored.
			if (ts.isArrayLiteralExpression(last) && !last.elements.length && t === 'JSArray<Any?>' && isKit(spelledType(target), 'JSArray')) t = target;
			const v = this.fresh('__assigned');
			const value = this.stored(e.right, e.left, t);
			this.subst.set(e.right, v);
			try {
				return `run { val ${v}: ${t} = ${value}; ${this.binary(e)}; ${v} }`;
			} finally {
				this.subst.delete(e.right);
			}
		}
		if (ts.isNumericLiteral(e)) return this.marks.pureCode(numberLiteral(e.text));
		if (ts.isBigIntLiteral(e)) return `JSBigInt.literal(${kotlinString(e.text.replace(/n$/, ''))})`;
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return this.marks.pureCode(kotlinString(e.text));
		if (e.kind === ts.SyntaxKind.TrueKeyword) return this.marks.pureCode('true');
		if (e.kind === ts.SyntaxKind.FalseKeyword) return this.marks.pureCode('false');
		if (e.kind === ts.SyntaxKind.NullKeyword) return this.marks.pureCode(this.isAny(e) && !optionalContext(this, e) ? 'jsNull' : 'null');
		if (e.kind === ts.SyntaxKind.ThisKeyword) {
			// App mode: a function expression called plainly, as module code (strict) calls it, has no `this`.
			if (!this.library && !this.thisAlias && ts.findAncestor(e.parent, (n) => ts.isFunctionLike(n) && !ts.isArrowFunction(n))?.kind === ts.SyntaxKind.FunctionExpression) {
				this.refuseStoredThis(e);
				return this.marks.pureCode('null');
			}
			return this.marks.pureCode(this.thisAlias ?? 'this');
		}
		// `import.meta` of the bundled app's module, in the app's files.
		if (ts.isMetaProperty(e) && e.keywordToken === ts.SyntaxKind.ImportKeyword) return 'jsImportMeta';
		if (e.kind === ts.SyntaxKind.SuperKeyword) return 'super';
		if (ts.isIdentifier(e)) {
			if (this.states.nullishRead(e)) {
				if (isWriteTarget(e)) throw this.error(e, 'a compound assignment to a slot that may be null or undefined both');
				if (this.lenientApp) return `${this.refName(e)}.jsAny`;
				return this.narrowed(e, `${this.refName(e)}.optional`);
			}
			return this.identifier(e);
		}
		if (ts.isTemplateExpression(e)) {
			const piece = (span: ts.TemplateSpan) => templateSubstitution(this, span);
			// `${x}` alone: the conversion itself, where it gives a string (a String value may still hold null, which the template prints).
			if (!e.head.text && e.templateSpans.length === 1 && !e.templateSpans[0].literal.text) {
				const only = piece(e.templateSpans[0]);
				if (/^js(ToString(Throwing)?)?\(/.test(only)) return only;
			}
			let out = escapeText(e.head.text);
			for (const span of e.templateSpans) out += `\${${piece(span)}}` + escapeText(span.literal.text);
			return `"${out}"`;
		}
		// `{ … } satisfies T`: the literal's own type, which `satisfies` only checks against T.
		if (ts.isSatisfiesExpression(e) && ts.isObjectLiteralExpression(e.expression)) return this.coerce(e.expression, this.typeOf(e));
		if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
			// `x as never`, which script writes to pass anything: the value as it is.
			if (this.library && this.isAny(e) && this.checker.getTypeAtLocation(e).flags & ts.TypeFlags.Never) return this.coerce(e.expression, 'Any?');
			const from = this.typeOf(e.expression);
			const to = this.typeOf(e);
			// A declared function asserted a function type (`identity as UnaryFunction<any, any>`): placed as its reference.
			const named = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.valueDeclaration : undefined;
			if (named && ts.isFunctionDeclaration(named) && !named.getSourceFile().isDeclarationFile && (isFunctionType(to.replace(/^\((.*)\)\?$/, '$1')) || (isUntyped(spelledType(to)) && !this.library))) return this.coerce(e.expression, to);
			// A function of a rest parameter asserted untyped: held as script calls it, its arguments packed.
			const rest = isUntyped(spelledType(to)) && !this.library ? this.restCallable(e.expression) : null;
			if (rest) return rest;
			const iterated = this.iterableCast(e);
			if (iterated) return iterated;
			const shared = this.uncheckedCast(e);
			if (shared) return cast(this.expr(e.expression), shared);
			const wider = isUntyped(spelledType(from)) ? this.widenedAssertion(e) : null;
			if (wider) return this.fromAny(this.expr(e.expression), isNullable(to) ? optionalType(wider) : wider);
			// The assertion is erased in JavaScript: where Kotlin needs the type, the value is converted as script converts it there.
			const entry = isUntyped(spelledType(from)) && !this.library && !this.lenient ? this.states.foreignEntry(e) : null;
			const checked = entry && this.type(entry.type, e) === to ? this.checkedConvert(this.expr(e.expression), entry, e) : null;
			if (checked) return checked;
			if (!this.library && isUntyped(spelledType(from)) && ['String', 'Double', 'Boolean'].includes(to)) return `${assertedReader(to)}(${this.expr(e.expression)})`;
			if (isUntyped(spelledType(from)) && !isUntyped(spelledType(to))) {
				// A script function asserted to a function type taking a rest (`as (...a: unknown[]) => unknown`): the rest is spread
				// into its arguments, as JavaScript calls it.
				const g = functionTypeParts(to.replace(/^\((.*)\)\?$/, '$1'));
				const sig = this.checker.getTypeAtLocation(e).getNonNullableType().getCallSignatures()[0]?.getDeclaration();
				const rest = g && sig && !ts.isJSDocSignature(sig) && sig.parameters.at(-1)?.dotDotDotToken ? sig.parameters.length - 1 : -1;
				if (g && rest >= 0 && rest === g.params.length - 1) {
					const names = g.params.map((_, k) => this.marks.pureCode(`__c${k}`));
					const call = `${RT.jsCall}(__f, ${[...names.slice(0, rest), `*${names[rest]}.toList().toTypedArray()`].join(', ')})`;
					const lam = `{ ${g.params.map((t, k) => `${names[k]}: ${t}`).join(', ')} -> ${g.ret === 'Unit' ? `${call}; Unit` : this.fromAny(call, g.ret)} }`;
					return `run { val __f = ${this.expr(e.expression)}; ${/\)\?$/.test(to) ? `if (${RT.jsIsNullish}(__f)) null else ${lam}` : lam} }`;
				}
				return this.fromAny(this.expr(e.expression), to);
			}
			// `<androidx.fragment.app.Fragment>object` of a `java.lang.Object`.
			if (from === 'Any' && to !== 'Any' && !isUntyped(spelledType(to))) return this.fromAny(this.expr(e.expression), to);
			// `x as string` of a string that may be undefined: the value as JavaScript then reads it as one.
			if (['String', 'Double', 'Boolean'].includes(to) && from === `${to}?`) return this.undefinedAs(this.expr(e.expression), to);
			// An object of one shape asserted another's (`cur as ICalEvent` of a `Partial<ICalEvent> & {…}`): Kotlin's classes are apart, so
			// the object is read as the asserted interface's, by its keys.
			const [fromName, toName] = [from.replace(/\?$/, ''), to.replace(/\?$/, '')];
			const fieldClass = (n: string) => (this.facts.hasInterface(this, this.interfaces, (d, s) => this.topName(d, s), n) && !this.protocols.has(n)) || !!this.shapes.named(n);
			if (!this.library && fromName !== toName && fieldClass(fromName) && this.facts.hasInterface(this, this.interfaces, (d, s) => this.topName(d, s), toName) && !this.protocols.has(toName)) {
				return from.endsWith('?') ? `${this.expr(e.expression)}?.let { ${this.viewOf(toName, 'it')} }` : this.viewOf(toName, this.expr(e.expression));
			}
			if (from !== to && from.replace(/\?$/, '') !== to.replace(/\?$/, '') && this.isObjectRef(e) && this.isObjectRef(e.expression)) {
				// Library mode: a script assertion never fails, so a value of another class (a TabViewItem walked up to as a parent)
				// or a null Java result (`dlg.findViewById(id) as TextView`) reads as null instead of throwing ClassCastException/NPE.
				if (this.library && this.isClassDowncast(e) && (isNullable(to) || this.functionLiteralArgument(e))) return safeCast(this.expr(e.expression), to.replace(/\?$/, ''));
				if (this.library && this.native?.type(this.checker.getNonNullableType(this.checker.getTypeAtLocation(e))) && this.native?.type(this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression)))) {
					const safe = safeCast(this.expr(e.expression), to.replace(/\?$/, ''));
					return isNullable(to) || this.nullOk.has(e) ? safe : this.unchecked(to, safe);
				}
				return this.classCast(this.expr(e.expression), from, to);
			}
			if (from.endsWith('?') && !to.endsWith('?') && from.replace(/\?$/, '') === to) return this.asserted(this.expr(e.expression));
			// A function asserted to a function type of other parameter or result types: adapted, each value converted.
			const fnOf = (t: string) => t.replace(/^\((.*)\)\?$/, '$1');
			const f = from !== to ? functionTypeParts(fnOf(from)) : null,
				g = f ? functionTypeParts(fnOf(to)) : null;
			if (f && g && f.params.length === g.params.length) {
				const names = g.params.map((_, k) => this.marks.pureCode(`__c${k}`));
				const call = `__f(${f.params.map((p, k) => this.convert(names[k], g.params[k], p)).join(', ')})`;
				const result = g.ret !== 'Unit' ? this.convert(call, f.ret, g.ret) : f.ret === 'Unit' ? call : `${call}; Unit`;
				return `${this.expr(e.expression)}${from.endsWith('?') ? '?' : ''}.let { __f -> { ${g.params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> ${result} } }`;
			}
			return this.expr(e.expression);
		}
		// `f<T>`: the function, its type arguments only TypeScript's.
		if (ts.isExpressionWithTypeArguments(e)) return this.functionValue(e.expression);
		if (ts.isNonNullExpression(e)) {
			const maybe = this.maybeUndefined(e.expression);
			// `!` asserts nothing at run time: a missing string, number or boolean converts as JavaScript converts undefined.
			const primitive = !this.library && !this.lenient && ['String', 'Double', 'Boolean'].includes(this.typeOf(e)) && convertedRead(e);
			if (maybe) return primitive ? this.undefinedAs(this.unasserted(maybe), this.typeOf(e)) : this.asserted(maybe);
			const inner = this.expr(e.expression);
			const optional = this.typeOf(e.expression).endsWith('?') || this.declaredTypeOf(e.expression)?.endsWith('?');
			return optional ? (primitive ? this.undefinedAs(this.unasserted(inner), this.typeOf(e)) : this.asserted(inner)) : inner;
		}
		if (ts.isPropertyAccessExpression(e) && this.isAmbient(e)) return `${RT.jsGetIfPresent}(${this.expr(e.expression)}, ${kotlinString(e.name.text)})`;
		// `ArrayBuffer.prototype`: the runtime class's.
		if (ts.isPropertyAccessExpression(e) && e.name.text === 'prototype' && ts.isIdentifier(e.expression) && BUFFER_TYPES.has(e.expression.text) && isLibDeclaration(this.resolve(e.expression)?.declarations?.[0])) {
			this.refuseBufferPrototype(e);
			return `JS${e.expression.text}.jsPrototype`;
		}
		if (ts.isPropertyAccessExpression(e)) {
			const member = this.namespaceMember(e);
			// A namespace's class as a value: the class.
			const decl = member ? this.resolve(e.name)?.valueDeclaration : undefined;
			if (decl && ts.isClassDeclaration(decl)) return (ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) || (ts.isNewExpression(e.parent) && e.parent.expression === e) ? member! : `${member}::class.java`;
			// A namespace's enum as a value (`Object.keys(Shapes.Kind)`): the object JavaScript makes of it.
			const p0 = e.parent;
			if (!this.library && decl && ts.isEnumDeclaration(decl) && isEnumObject(this.placement, e) && !((ts.isPropertyAccessExpression(p0) || ts.isElementAccessExpression(p0)) && p0.expression === e) && !ts.isTypeOfExpression(p0)) return `${member}.jsEnumObject`;
			// A namespace's function as a value (`valueConverter: Length.parse`): a reference to it.
			if (member && this.library && decl && ts.isFunctionDeclaration(decl) && !(ts.isCallExpression(e.parent) && e.parent.expression === e)) {
				const dot = member.lastIndexOf('.');
				return dot < 0 ? `::${member}` : `${member.slice(0, dot)}::${member.slice(dot + 1)}`;
			}
			return member ? this.narrowed(e, member) : this.property(e);
		}
		if (ts.isElementAccessExpression(e)) return this.elementAccess(e);
		if (ts.isCallExpression(e)) {
			const p = ts.walkUpParenthesizedExpressions(e.parent);
			if (this.lenientApp && !ts.isAwaitExpression(p) && !ts.isExpressionStatement(p) && !this.states.returnedAsIs(e) && this.states.lenientAsyncCall(e)) throw this.error(e, 'the promise of a non-strict async function that may give null or undefined, used other than by `await`,');
			return this.erasedResult(e, this.call(e));
		}
		if (ts.isNewExpression(e)) return this.newExpr(e);
		if (ts.isBinaryExpression(e)) return this.binary(e);
		if (ts.isPrefixUnaryExpression(e)) return this.prefix(e);
		if (ts.isPostfixUnaryExpression(e)) {
			const place = this.untypedPlace(e.operand);
			if (place) return this.keyedStep(place, e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-', true);
			const held = this.heldNumberStep(e);
			if (held) return held;
			const target = this.lvalue(e.operand);
			return `${target}.also { ${target} = it ${e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-'} ${this.one(e.operand)} }`;
		}
		if (ts.isConditionalExpression(e)) {
			const t = this.typeOf(e);
			const fixed = this.staticTruth(e.condition);
			if (fixed !== undefined) return this.coerce(fixed ? e.whenTrue : e.whenFalse, t);
			return `(if (${this.cond(e.condition)}) ${branch(this.coerce(e.whenTrue, t))} else ${branch(this.coerce(e.whenFalse, t))})`;
		}
		// Library mode: `class { [property: string]: string }`, a constructor of plain objects.
		if (this.library && ts.isClassExpression(e) && !e.heritageClauses && e.members.every(ts.isIndexSignatureDeclaration)) return 'JSObject::class.java';
		if (ts.isArrayLiteralExpression(e)) return this.array(e);
		if (ts.isObjectLiteralExpression(e)) return this.object(e);
		if (ts.isTaggedTemplateExpression(e)) return this.taggedTemplate(e);
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.closure(e);
		if (ts.isTypeOfExpression(e)) return this.typeofExpr(e);
		if (ts.isAwaitExpression(e)) throw this.error(e, 'await outside a statement of an async function');
		if (ts.isDeleteExpression(e)) {
			const target = e.expression;
			if (ts.isElementAccessExpression(target) && isKit(spelledType(this.typeOf(target.expression)), 'JSRecord')) return `${this.expr(target.expression)}.delete(${this.str(target.argumentExpression)})`;
			if (ts.isElementAccessExpression(target) && (this.isAny(target.expression) || this.isObjectRef(target.expression))) return `${RT.jsDelete}(${this.expr(target.expression)}, ${this.propertyKey(target.argumentExpression)})`;
			if (ts.isPropertyAccessExpression(target) && this.isAny(target.expression)) return `${RT.jsDelete}(${this.expr(target.expression)}, ${kotlinString(target.name.text)})`;
			if (ts.isPropertyAccessExpression(target) && isKit(spelledType(this.typeOf(target.expression)), 'JSRecord')) return `${this.expr(target.expression)}.delete(${kotlinString(target.name.text)})`;
			if (ts.isPropertyAccessExpression(target) && this.typeOf(target.expression) === 'JSObject') return `${this.expr(target.expression)}.delete(${kotlinString(target.name.text)})`;
			// A field of a program class some code deletes: its flag (`keyPlan`).
			const decl = ts.isPropertyAccessExpression(target) ? this.checker.getSymbolAtLocation(target.name)?.valueDeclaration : undefined;
			if (decl && ts.isPropertyDeclaration(decl) && ts.isClassLike(decl.parent) && this.keyPlan(decl.parent)?.flagged.has((target as ts.PropertyAccessExpression).name.text)) {
				const t = target as ts.PropertyAccessExpression;
				if (!ts.isIdentifier(t.expression) && t.expression.kind !== ts.SyntaxKind.ThisKeyword) throw this.error(e, 'delete of a field of an object this expression makes', 'delete-member');
				const o = this.expr(t.expression),
					n = t.name.text;
				return `run { if (${o}.__has_${n}) { ${o}.${ident(n)} = null; ${o}.__has_${n} = false }; true }`;
			}
			throw this.error(e, 'delete of this member', 'delete-member');
		}
		if (ts.isVoidExpression(e)) {
			const code = this.exprStatement(e.expression);
			return this.marks.isPure(code) ? 'null' : `run { ${code}; null }`;
		}
		if (ts.isRegularExpressionLiteral(e)) {
			const text = e.text;
			const end = text.lastIndexOf('/');
			return `${RT.jsRegExpLiteral}(${kotlinString(text.slice(1, end))}, ${kotlinString(text.slice(end + 1))})`;
		}
		if (ts.isClassExpression(e)) return `${this.emitClassExprCode(e)}::class.java`;
		throw this.error(e, 'expression', 'unhandled');
	},

	/** ``tag`a${x}b` ``: the tag called with the site's strings (cooked, and raw as `strings.raw`), then the values. */
	taggedTemplate(this: Translator, e: ts.TaggedTemplateExpression): string {
		const { cooked, raw, values } = templateParts(e.template);
		if (isStringRaw(e.tag, this.checker)) return `(${raw.map((r, k) => kotlinString(r) + (k < values.length ? ` + ${this.str(values[k])}` : '')).join(' + ')})`;
		const site = `__template${this.templateObjects.length}`;
		this.templateObjects.push(`val ${site} = ${RT.jsTemplateObject}(listOf(${cooked.map(kotlinString).join(', ')}), listOf(${raw.map(kotlinString).join(', ')}))`);
		if (this.isAny(e.tag)) {
			const call = `${RT.jsCall}(${[this.expr(e.tag), site, ...values.map((v) => this.coerce(v, 'Any?'))].join(', ')})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || rt === 'Unit' ? call : this.fromAnyCode(call, rt, true);
		}
		const params = this.checker.getResolvedSignature(e)?.getParameters() ?? [];
		const restAt = params.findIndex((p) => p.valueDeclaration && ts.isParameter(p.valueDeclaration) && !!p.valueDeclaration.dotDotDotToken);
		const restType = () => this.typeOf((params[restAt].valueDeclaration as ts.ParameterDeclaration).name);
		const args = [site];
		for (let k = 0; k < values.length; k++) {
			if (restAt >= 0 && k + 1 >= restAt) {
				args.push(this.packed(values.slice(k), restType()));
				break;
			}
			const p = params[k + 1];
			args.push(p ? this.coerce(values[k], this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e)) : this.expr(values[k]));
		}
		if (restAt > values.length) args.push(`${restType()}()`);
		return `${this.expr(e.tag)}(${args.join(', ')})`;
	},

	/** A property key: a symbol's own key, anything else as a string. */
	propertyKey(this: Translator, e: ts.Expression): string {
		return propertyKeyCode(this, e, () => this.symbolKey(this.expr(e)));
	},

	/** A value as JavaScript converts it to a string (`String(x)`, `${x}`, `'' + x`). */
	str(this: Translator, e: ts.Expression): string {
		if (notedField(this.states, e) || this.states.nullDistinct(e)) return `${RT.jsToString}(${this.coerce(e, 'Any?')})`;
		const maybe = this.maybeUndefined(e);
		if (maybe) return `${RT.jsToString}(${maybe})`;
		// An app's `a?.b` typed present: Kotlin's chain gives a nullable, undefined where it stops.
		if (!this.library && ['String', 'Double', 'Boolean'].includes(this.typeOf(e)) && this.optionalChainEnd(e)) return `${RT.jsToString}(${this.expr(e)})`;
		const t = this.typeOf(e);
		// A number or boolean an untrusted value was placed in converts as JavaScript converts undefined.
		if (!this.library && (t === 'Double' || t === 'Boolean') && this.heldNullable(e, t)) {
			this.nullOk.add(e);
			return `${RT.jsToString}(${this.expr(e)})`;
		}
		// A string declared nullable converts as JavaScript converts undefined.
		if (t === 'String') {
			const code = this.expr(e);
			// A string the code asserts present (a call declared `string` returning null) converts as JavaScript converts null.
			if (this.isAsserted(code)) return `${RT.jsToString}(${this.unasserted(code)})`;
			return this.declaredTypeOf(e)?.endsWith('?') ? `${RT.jsToString}(${code})` : code;
		}
		if (t === 'Double' || t === 'Boolean') {
			const code = this.expr(e),
				held = this.undefinedConverted(code);
			return held ? `${RT.jsToString}(${held})` : `${RT.js}(${code})`;
		}
		// A value read as present (`${savedInstanceState}` of a Bundle that may be null): converted as it is.
		const code = this.expr(e);
		// A string only null may be missing from (`string | null`): null, as Kotlin holds both as one.
		if (t === 'String?' && onlyNull(this.checker.getTypeAtLocation(e))) return `(${code} ?: "null")`;
		return `${RT.jsToString}(${this.isAsserted(code) && this.marks.isPath(this.unasserted(code)) ? this.unasserted(code) : code})`;
	},
};
