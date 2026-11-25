// Assignment as Swift: prefix and postfix updates, compound assignment and the reads and writes they make.
import ts from 'typescript';
import { ident, isNullish, negation, swiftString, throwingSetter, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { asOperation, assignmentOf, type ReadWrite } from '../semantics/lang.ts';
import { assignedTo, negatedCell } from '../semantics/placement.ts';
import { notedField } from '../semantics/shapes.ts';
import { isArrayLengthWrite } from '../semantics/throws.ts';
import { byKey } from '../semantics/spelled.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { untypedUnary } from '../semantics/apis/operators.ts';

export const assignmentMethods = {
	prefix(this: Translator, e: ts.PrefixUnaryExpression): string {
		const K = ts.SyntaxKind;
		const thrown = untypedUnary(this, e);
		if (thrown) return thrown;
		switch (e.operator) {
			case K.ExclamationToken: {
				const cell = negatedCell(this.conditions, e.operand);
				const operand = cell.step === 'bool' ? this.expr(cell.e) : this.cond(e.operand, cell);
				return negation(operand);
			}
			// `-0` is negative zero; Swift reads the literal `-0` as an integer zero.
			case K.MinusToken:
				if (this.typeOf(e.operand) === 'JSBigInt') return `(-${this.expr(e.operand)})`;
				return ts.isNumericLiteral(e.operand) ? (Number(e.operand.text) === 0 ? '-0.0' : `-${this.expr(e.operand)}`) : `-${this.toNumber(e.operand)}`;
			case K.PlusToken:
				return this.toNumber(e.operand);
			case K.TildeToken:
				return this.typeOf(e.operand) === 'JSBigInt' ? `(~${this.expr(e.operand)})` : `${RT.jsBitNot}(${this.toNumber(e.operand)})`;
			case K.PlusPlusToken:
			case K.MinusMinusToken: {
				const member = this.untypedMember(e.operand);
				const step = e.operator === K.PlusPlusToken ? '+' : '-';
				if (member) return `${RT.jsToNumber}(${this.untypedUpdate(member, `${RT.jsToNumber}(__old) ${step} 1`, false)})`;
				return this.optionalNumberUpdate(e) ?? `${step === '+' ? RT.jsPreIncrement : RT.jsPreDecrement}(&${this.lvalue(e.operand)})`;
			}
		}
		throw this.error(e, 'prefix operator');
	},

	/** A member's compound, logical or update assignment (`readWrite`): its held parts evaluated once, its value the one computed. */
	readWriteCode(this: Translator, e: ts.Expression, rw: ReadWrite): string {
		const names = rw.held.map((h) => this.fresh(h === rw.target.expression ? '__o' : '__k'));
		// A loose receiver's unwrap throws though the receiver alone may not.
		const binds = rw.held.map((h, k) => {
			const code = this.expr(h);
			const m = this.marks.markOf(code);
			return `let ${names[k]} = ${this.tryPrefix(h) || (m?.op === 'helper' && m.name === 'jsUnwrap' ? 'try ' : '')}${code}`;
		});
		rw.held.forEach((h, k) => {
			this.subst.set(h, names[k]);
			this.heldParts.add(h);
		});
		try {
			const body = rw.value ? this.readWriteValue(e) : null;
			const code = body ? body.code : this.exprStatement(e);
			const lost = names.find((n) => !new RegExp(`\\b${n}\\b`).test(code));
			if (lost) throw this.error(e, `a compound assignment whose target the translation evaluates apart from its parts (${lost})`);
			if (!body) return this.marks.blockCode(`do { ${[...binds, this.marks.triedStatement(this.tryPrefix(e), code)].join('; ')} }`);
			const tp = this.tryPrefix(e);
			return `({ () ${tp ? 'throws ' : ''}-> ${body.type} in ${[...binds, code].join('; ')} }())`;
		} finally {
			rw.held.forEach((h) => {
				this.subst.delete(h);
				this.heldParts.delete(h);
			});
		}
	},

	/** A member's compound, logical or update assignment as a value: one read, the write, and the value computed or kept (statements ending in a return, and their type). */
	readWriteValue(this: Translator, e: ts.Expression): { code: string; type: string } {
		const K = ts.SyntaxKind;
		if (ts.isBinaryExpression(e) && [K.AmpersandAmpersandEqualsToken, K.BarBarEqualsToken, K.QuestionQuestionEqualsToken].includes(e.operatorToken.kind)) {
			const read = this.fresh('__read'),
				value = this.fresh('__value');
			const op = e.operatorToken.kind;
			const declared = this.declaredTypeOf(e.left) ?? this.typeOf(e.left);
			const t = isUntyped(spelledType(declared)) || op !== K.QuestionQuestionEqualsToken ? declared : declared.replace(/\?$/, '');
			const test = op === K.AmpersandAmpersandEqualsToken ? `${RT.jsTruthy}(${read})` : op === K.BarBarEqualsToken ? `!${RT.jsTruthy}(${read})` : `${RT.jsIsNullish}(${read})`;
			const kept = t !== declared || this.recordEntry(e.left) ? this.marks.unwrappedCode(read) : read;
			// Held as the right side's own type where the target is untyped: the write converts it as `=` does.
			const vt = isUntyped(spelledType(t)) && !['Void', 'Any?'].includes(this.typeOf(e.right)) ? this.typeOf(e.right) : t;
			const given = `${this.marks.tryBefore(this.tryPrefix(e.right), this.stored(e.right, e.left, vt))}`,
				current = `${this.marks.tryBefore(this.tryPrefix(e.left), this.expr(e.left))}`;
			this.subst.set(e.right, value);
			this.heldValues.set(e.right, vt);
			try {
				const assign = this.assignment(assignmentOf(e, e.left, e.right));
				return { type: t, code: `let ${read} = ${current}; if ${test} { let ${value}: ${vt} = ${given}; ${this.tryPrefix(e)}${assign}; return ${value} }; return ${kept}` };
			} finally {
				this.subst.delete(e.right);
				this.heldValues.delete(e.right);
			}
		}
		const value = this.fresh('__value');
		const left = ts.isBinaryExpression(e) ? e.left : (e as ts.PrefixUnaryExpression).operand;
		const t = this.typeOf(e);
		let computed: string,
			given = value,
			old = '';
		if (ts.isBinaryExpression(e)) computed = this.entryRead(left, () => this.binary(asOperation(e)));
		else {
			const u = e as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
			const o = this.fresh('__old');
			computed = `${o} ${u.operator === K.PlusPlusToken ? '+' : '-'} 1`;
			old = `let ${o}: ${t} = ${this.tryPrefix(left)}${this.entryRead(left, () => (this.typeOf(left) === 'JSBigInt' ? this.expr(left) : this.toNumber(left)))}; `;
			if (ts.isPostfixUnaryExpression(e)) given = o;
		}
		this.subst.set(e, value);
		try {
			return { type: t, code: `${old}let ${value}: ${t} = ${this.tryPrefix(e)}${computed}; ${this.tryPrefix(e)}${this.assignment(assignmentOf(e, left, e))}; return ${given}` };
		} finally {
			this.subst.delete(e);
		}
	},

	entryRead(this: Translator, e: ts.Expression, f: () => string): string {
		const target = this.recordEntry(e);
		if (!target) return f();
		this.subst.set(target, this.marks.unwrappedCode(ts.isElementAccessExpression(target) ? this.expr(target) : this.lvalue(target)));
		try {
			return f();
		} finally {
			this.subst.delete(target);
		}
	},

	/** A member of an untyped object as an update's target: the object and the key, each evaluated once. */
	untypedMember(this: Translator, x: ts.Expression): { object: string; key: string } | null {
		while (ts.isParenthesizedExpression(x)) x = x.expression;
		if (ts.isPropertyAccessExpression(x) && (this.isAny(x.expression) || this.isExpando(x))) return { object: this.expr(x.expression), key: swiftString(x.name.text) };
		if (ts.isElementAccessExpression(x) && this.isAny(x.expression)) return { object: this.expr(x.expression), key: this.propertyKey(x.argumentExpression) };
		return null;
	},

	/** `o.k op= v` on an untyped object: `value` makes the new value of the old one (`__old`). */
	untypedUpdate(this: Translator, member: { object: string; key: string }, value: string, throws = true): string {
		return `${RT.jsUpdate}(${member.object}, ${member.key}) { (__old: Any?) throws -> Any? in ${throws ? 'try ' : ''}${value} }`;
	},

	/** A write of `value` to a setter with a throwing body (`throwingWrite`): a call of that body. */
	throwingWriteCode(this: Translator, left: ts.Expression, value: string): string | null {
		if (!ts.isPropertyAccessExpression(left) || !this.throwingWrite(left)) return null;
		const place = this.lvalue(left);
		const member = `.${this.memberName(left)}`;
		return place.endsWith(member) ? `${place.slice(0, -member.length)}.${throwingSetter(left.name.text)}(${value})` : null;
	},

	/** `left = right` (also the assignment `??=` and `||=` make). */
	assignment(this: Translator, e: ts.BinaryExpression): string {
		const left = e.left,
			right = e.right;
		// A right side the translation converted already (`subst`) is not given again.
		const checks = assignedTo(left, right) && !this.subst.has(right);
		const fnObject = ts.isPropertyAccessExpression(left) ? this.functionObjectOf(left) : null;
		if (fnObject && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return `${fnObject}[jsKey: ${swiftString((left as ts.PropertyAccessExpression).name.text)}] = ${this.stored(right, left, 'Any?', checks)}`;
		if (fnObject) throw this.error(e, `${ts.tokenToString(e.operatorToken.kind)} on a function's property`);
		if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(left)) {
			const decl = this.resolve(left)?.valueDeclaration;
			if (decl && ts.isVariableDeclaration(decl) && this.facts.tdzBindings().has(decl) && !(decl.parent.flags & ts.NodeFlags.Const)) {
				const raw = this.refName(left).replace(/`/g, '');
				return `__tdz_set_${raw}(${this.stored(right, left, this.declaredTypeOf(left) ?? this.typeOf(left), checks)})`;
			}
		}
		const nullish = e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(left) ? this.states.nullishRead(left) : null;
		if (nullish) return this.marks.assignedCode(this.refName(left as ts.Identifier), this.stored(right, left, this.nullishSlotType(nullish), checks));
		const field = ts.isPropertyAccessExpression(left) && left.expression.kind !== ts.SyntaxKind.SuperKeyword ? this.states.nullishRead(left) : this.states.nullishKeyedField(left);
		if (field) {
			if (e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) throw this.error(e, 'a compound assignment to a slot that may be null or undefined both');
			if (this.throwingWrite(left)) {
				const call = this.throwingWriteCode(left, this.stored(right, left, this.nullishSlotType(field), checks));
				if (call) return call;
			}
			const place = this.place(left);
			return this.marks.assignedCode(place.code, this.stored(right, left, this.nullishSlotType(field), checks), place.throws);
		}
		// App mode: `Button.prototype.recycleNativeView = 'never'`: the class's prototype object's, which script reads through.
		if (!this.library && ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === 'prototype') {
			const sym = this.resolve(left.expression.expression);
			if (sym && sym.flags & ts.SymbolFlags.Class) {
				const cls = this.type(this.checker.getDeclaredTypeOfSymbol(sym), e).replace(/<.*$/, '');
				return `JSPrototypes.of(${cls}.self)[${swiftString(left.name.text)}] = ${this.stored(right, left, 'Any?', checks)}`;
			}
		}
		if (ts.isPropertyAccessExpression(left) && this.framework.signalKind(this.symbolName(left.expression)) === 'ref' && left.name.text === 'value') {
			const place = this.place(left);
			return this.marks.assignedCode(place.code, this.signalWrite(left.expression, right, this.typeOf(left), checks, left), place.throws);
		}
		const takesAny = ts.isPropertyAccessExpression(left) && (this.checker.getSymbolAtLocation(left.name)?.declarations ?? []).some((d) => ts.isSetAccessorDeclaration(d) && !d.getSourceFile().isDeclarationFile && this.setterTakesAny(d));
		// `super.style = value` over the kit's `__set_style`: the kit's body, since its property calls this class's override.
		const enclosing = ts.findAncestor(left, ts.isClassLike);
		const overKitSetter = !takesAny && !this.library && !!enclosing && ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.SuperKeyword && (this.checker.getSymbolAtLocation(left.name)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile) && this.baseSetterMethod(enclosing, left.name.text);
		if (takesAny || overKitSetter) {
			const place = this.lvalue(left);
			const member = `.${ident(left.name.text)}`;
			if (place.endsWith(member)) return `${place.slice(0, -member.length)}.__set_${left.name.text.replace(/\W/g, '_')}(${this.stored(right, left, 'Any?', checks)})`;
		}
		const throwing = this.throwingWrite(left) && this.throwingWriteCode(left, this.stored(right, left, this.declaredTypeOf(left) ?? this.typeOf(left), checks));
		if (throwing) return throwing;
		if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) {
			// Its value is the value assigned from (`result = [a, b] = list`).
			let bare = right;
			while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
			if (ts.isObjectLiteralExpression(bare)) throw this.error(left, 'a destructuring assignment of an object literal used as a value');
			return this.patternAssignment(left, right, true, this.throwsInfo.expr(e));
		}
		// Lenient code: null assigned to a local of a native struct declared without a value, which Swift holds implicitly unwrapped, is no struct.
		if (this.lenient && isNullish(right) && ts.isIdentifier(left) && this.native.isStructType(this.typeOf(left))) {
			const d = this.resolve(left)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && !d.initializer && !ts.isSourceFile(d.parent.parent.parent)) return this.marks.assignedCode(this.expr(left), 'nil');
		}
		if (ts.isPropertyAccessExpression(left) && this.isAddedMember(left)) return `(${this.expr(left.expression)} as JSDynamic)[jsKey: ${swiftString(left.name.text)}] = ${this.stored(right, left, 'Any?', checks)}`;
		if (ts.isPropertyAccessExpression(left) && this.isNativeExpando(left)) return `${RT.jsSetNativeExpando}(${this.expr(left.expression)}, ${swiftString(left.name.text)}, ${this.stored(right, left, 'Any?', checks)})`;
		if (ts.isPropertyAccessExpression(left) && this.isExpando(left)) return `${RT.jsSet}(${this.expr(left.expression)}, ${swiftString(left.name.text)}, ${this.stored(right, left, 'Any?', checks)})`;
		if (ts.isPropertyAccessExpression(left)) {
			const special = this.core.assign(left, right) ?? this.native.assign(left, right);
			if (special) return special;
			if (left.expression.kind !== ts.SyntaxKind.SuperKeyword && this.isInstanceMethod(left.name)) return `${RT.jsExpandoSet}(${this.expr(left.expression)}, ${swiftString(left.name.text)}, ${this.stored(right, left, 'Any?', checks)})`;
		}
		if (ts.isPropertyAccessExpression(left) && this.isAny(left.expression)) return `${RT.jsSet}(${this.expr(left.expression)}, ${swiftString(left.name.text)}, ${this.stored(right, left, 'Any?', checks)})`;
		// An array written at a key that may be no index (`frames[time]`, time untyped): as script writes it.
		if (ts.isElementAccessExpression(left) && isKit(spelledType(this.typeOf(left.expression).replace(/[?!]$/, '')), 'JSArray') && this.typeOf(left.argumentExpression) !== 'Double') return `${RT.jsSet}(${this.expr(left.expression)}, ${this.propertyKey(left.argumentExpression)}, ${this.stored(right, left, 'Any?', checks)})`;
		if (ts.isElementAccessExpression(left) && this.isAny(left.expression)) return `${RT.jsSet}(${this.expr(left.expression)}, ${this.propertyKey(left.argumentExpression)}, ${this.stored(right, left, 'Any?', checks)})`;
		if (this.library && this.holdsMethods(left) && this.carriesMethod(right)) {
			const place = this.place(left);
			return this.marks.assignedCode(place.code, this.expr(right), place.throws);
		}
		if (ts.isPropertyAccessExpression(left) && this.untypedWrite(left, right)) return `${RT.jsSet}(${this.expr(left.expression)}, ${swiftString(left.name.text)}, ${notedField(this.states, left) ? this.stored(right, left, 'Any?', checks) : this.expr(right)})`;
		const keyed = ts.isPropertyAccessExpression(left) && !this.lenient && !this.library ? this.states.nullishShapeField(left, true) : null;
		if (keyed) return `${RT.jsSet}(${this.expr((left as ts.PropertyAccessExpression).expression)}, ${swiftString(keyed)}, ${this.stored(right, left, 'Any?', checks)})`;
		if (isArrayLengthWrite(left, right, this.checker)) return `${this.expr(left.expression)}.jsSetLength(checked: ${this.toNumber(right)})`;
		const element = ts.isElementAccessExpression(left) && this.states.nullishElements(left.expression) ? this.elementTypeOf(left.expression) : null;
		// `record.k = v` writes the record's entry, of the type the record holds (a function held untyped, as `record['k']` holds it).
		const entry = ts.isPropertyAccessExpression(left) && byKey(this, left) ? /^JSRecord<(.*)>\??$/.exec(this.typeOf(left.expression))?.[1] : undefined;
		const place = this.place(left);
		return this.marks.assignedCode(place.code, this.stored(right, left, element ?? entry ?? this.declaredTypeOf(left) ?? this.typeOf(left), checks), place.throws);
	},
};
