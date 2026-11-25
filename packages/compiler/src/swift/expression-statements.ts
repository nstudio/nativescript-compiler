// Expression statements as Swift, with the assignments of patterns and iterated values.
import ts from 'typescript';
import { ident, isOptional, optionalType, splitTopLevel, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { nullishPart, nullishWrite } from '../semantics/placement.ts';
import { iteratedType, literalKey, readWrite } from '../semantics/lang.ts';
import { reassignedBase } from '../semantics/ast.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const exprStatementsMethods = {
	/** `ready && log()` of a call giving nothing, as a statement or a void callback's body: the call where the test holds, as there is no value to choose. */
	voidLogical(this: Translator, x: ts.Expression): string | null {
		while (ts.isParenthesizedExpression(x)) x = x.expression;
		if (!ts.isBinaryExpression(x) || (x.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken && x.operatorToken.kind !== ts.SyntaxKind.BarBarToken) || this.typeOf(x.right) !== 'Void') return null;
		const test = this.cond(x.left);
		return this.marks.blockCode(`if ${this.tryPrefix(x.left)}${x.operatorToken.kind === ts.SyntaxKind.BarBarToken ? `!(${test})` : test} { ${this.tryPrefix(x.right)}${this.exprStatement(x.right)} }`);
	},

	/** `for (x of list)`, `for ([key, value] of entries)`: each value assigned to existing targets, as `x = value` would. */
	forOfAssigning(this: Translator, s: ts.ForOfStatement, target: ts.Expression): string {
		if (this.forOfSteps(s.expression)) return this.steppedLoop(s);
		const i = this.indent;
		const item = this.fresh('__item');
		const part = iteratedType(this.checker.getTypeAtLocation(s.expression), this.checker, s.expression) ?? this.checker.getTypeAtLocation(target);
		const iterable = this.iterable(s.expression);
		const seq = (this.tryPrefix(s.expression) || (this.isAny(s.expression) ? 'try ' : '')) + (/^\{/.test(iterable) ? `(${iterable})` : iterable);
		const lines = this.assignIterated(target, item, this.isAny(s.expression) ? null : part, s.expression);
		return this.loopBody(() => {
			const label = this.takeLabel();
			const body = this.block(s.statement);
			return `${i}${label}for ${item} in ${seq} {\n${lines.map((l) => `${i}    ${l}`).join('\n')}\n${body.slice(2)}`;
		});
	},

	assignIterated(this: Translator, target: ts.Expression, item: string, part: ts.Type | null, of: ts.Expression): string[] {
		const itemType = part ? this.type(part, of) : 'Any?';
		let bare = target;
		while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
		const lines: string[] = [];
		if (ts.isArrayLiteralExpression(bare) || ts.isObjectLiteralExpression(bare)) this.assignParts(bare, item, itemType, part ?? this.checker.getTypeAtLocation(bare), lines);
		else {
			const want = this.declaredTypeOf(bare) ?? this.typeOf(bare);
			lines.push(`${this.lvalue(bare)} = ${isUntyped(spelledType(itemType)) && !isUntyped(spelledType(want)) ? (this.checkedBinding(bare, item, want) ?? this.fromAnyCode(item, want, true)) : this.convert(item, itemType, want)}`);
		}
		return lines;
	},

	/**
	 * `[a, b] = [b, a]`, `({ x, y = 1 } = o)`, `[first, ...rest] = list`: the value read once, then each target written in order from
	 * what it names, a default where that is undefined, nested patterns each from their part.
	 */
	patternAssignment(this: Translator, pattern: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression, right: ts.Expression, asValue = false, throws = false): string {
		const value = this.fresh('__v');
		let bare = right;
		while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
		// An object literal is its own shape's object, whatever shape the pattern gives the assignment's type.
		const literal = ts.isObjectLiteralExpression(bare);
		// A rest (`({ a, ...others } = { a: 1, b: 2 })`) takes the literal's keys the pattern doesn't name, which its shape would drop.
		const untyped = literal && ts.isObjectLiteralExpression(pattern) && pattern.properties.some(ts.isSpreadAssignment);
		const type = untyped ? 'Any?' : literal ? this.typeOf(bare) : this.typeOf(right);
		const lines = [untyped ? `let ${value}: Any? = ${this.tryPrefix(right)}${this.dynamicObject(bare as ts.ObjectLiteralExpression)}` : literal ? `let ${value} = ${this.marks.tryBefore(this.tryPrefix(right), this.expr(bare))}` : `let ${value}: ${type} = ${this.marks.tryBefore(this.tryPrefix(right), this.coerce(right, type))}`];
		this.assignParts(pattern, value, type, this.checker.getTypeAtLocation(right), lines);
		return asValue ? `{ () ${throws ? 'throws ' : ''}-> ${type} in ${lines.join('; ')}; return ${value} }()` : this.marks.blockCode(`do { ${lines.join('; ')} }`);
	},

	assignParts(this: Translator, pattern: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression, value: string, type: string, source: ts.Type, lines: string[]): void {
		const untyped = isUntyped(spelledType(type));
		const write = (target: ts.Expression, read: string, readType: string, part: ts.Type | undefined, key: string | number | null = null) => {
			let dflt: ts.Expression | undefined;
			if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				dflt = target.right;
				target = target.left;
			}
			while (ts.isParenthesizedExpression(target)) target = target.expression;
			const reads = nullishPart(this.placement, target, pattern, source, key);
			if (reads) {
				let code = reads === 'keyed' ? this.marks.ownTried(`${RT.jsGet}(${value}, ${swiftString(String(key))})`) : reads === 'element' ? `${RT.jsNulledEntry}(${this.marks.elementOf(value, key!)})` : read;
				let from = reads === 'keyed' || reads === 'element' ? 'Any?' : readType;
				if (dflt && reads !== 'null') {
					code = `(${this.convert(code, from, 'Any?')} ?? ${this.coerce(dflt, 'Any?')})`;
					from = 'Any?';
				}
				lines.push(`${this.lvalue(target)} = ${nullishWrite(this.placement, target, code, from, reads === 'null')}`);
				return;
			}
			const meets = dflt && !untyped ? this.states.partDefault(pattern, source, key) : 'empty';
			if (meets === 'never') dflt = undefined;
			else if (meets === 'keyed') {
				read = `${RT.jsField}(${value}, ${swiftString(String(key))})`;
				readType = 'Any?';
			} else if (meets === 'element' && dflt) {
				read = this.marks.leading(`(${read} ?? ${this.coerce(dflt, readType)})`, read);
				dflt = undefined;
			}
			if (dflt) {
				const base = isUntyped(spelledType(readType)) ? 'Any?' : readType.replace(/\?$/, '');
				read = readType === base && !isUntyped(spelledType(base)) ? read : this.marks.leading(`(${read} ?? ${this.coerce(dflt, base)})`, read);
				readType = base;
			}
			if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
				const tmp = this.fresh('__d');
				lines.push(`let ${tmp}: ${readType} = ${read}`);
				this.assignParts(target, tmp, readType, part ?? this.checker.getTypeAtLocation(target), lines);
				return;
			}
			const member = this.untypedMember(target);
			if (member) {
				lines.push(this.marks.tryCode(`${RT.jsSet}(${member.object}, ${member.key}, ${this.convert(read, readType, 'Any?')})`));
				return;
			}
			const want = this.declaredTypeOf(target) ?? this.typeOf(target);
			const code = readType === want ? read : isUntyped(spelledType(readType)) ? (this.checkedBinding(target, read, want) ?? this.fromAnyCode(read, want, true)) : readType === optionalType(want) && !isOptional(want) ? this.undefinedAs(read, want) : this.convert(read, readType, want);
			lines.push(`${this.lvalue(target)} = ${code}`);
		};
		if (ts.isArrayLiteralExpression(pattern)) {
			const tuple = this.checker.isTupleType(source) && !isKit(spelledType(type), 'JSArray') ? splitTopLevel(type.replace(/\?$/, '').slice(1, -1)) : null;
			const element = /^JSArray<(.*)>\??$/.exec(type)?.[1];
			if (!untyped && !tuple && element === undefined) throw this.error(pattern, `a destructuring assignment from ${type}`);
			const parts = tuple ? this.checker.getTypeArguments(source as ts.TypeReference) : undefined;
			const elementPart = !tuple && this.checker.isArrayType(source) ? this.checker.getTypeArguments(source as ts.TypeReference)[0] : undefined;
			pattern.elements.forEach((target, k) => {
				if (ts.isOmittedExpression(target)) return;
				if (ts.isSpreadElement(target)) {
					if (tuple) {
						const restType = (this.declaredTypeOf(target.expression) ?? this.typeOf(target.expression)).replace(/[?!]$/, '');
						const each = /^JSArray<(.*)>$/.exec(restType)?.[1];
						if (each === undefined) throw this.error(target, `a rest element assigned to ${restType}`);
						write(
							target.expression,
							`${restType}([${tuple
								.slice(k)
								.map((t, n) => this.convert(`${value}.${k + n}`, t, each))
								.join(', ')}])`,
							restType,
							undefined,
						);
						return;
					}
					write(target.expression, untyped ? this.marks.ownTried(`${RT.jsCallMethod}(${value}, "slice", Double(${k}))`) : `${value}.slice(${k})`, untyped ? 'Any?' : type.replace(/\?$/, ''), source);
					return;
				}
				if (untyped) write(target, this.marks.ownTried(`${RT.jsGet}(${value}, "${k}")`), 'Any?', undefined);
				else if (tuple) write(target, `${value}.${k}`, tuple[k], parts?.[k], k);
				else write(target, isUntyped(spelledType(element)) ? this.marks.orNil(this.marks.elementOf(value, k)) : this.marks.elementOf(value, k), isUntyped(spelledType(element)) ? 'Any?' : optionalType(element!), elementPart, k);
			});
			return;
		}
		const named: string[] = [];
		for (const p of pattern.properties) {
			if (ts.isSpreadAssignment(p)) {
				const restType = this.typeOf(p.expression);
				write(p.expression, this.fromAny(`${RT.jsObjectRest}(${value}, [${named.join(', ')}])`, restType), restType, undefined);
				continue;
			}
			if (!ts.isShorthandPropertyAssignment(p) && !ts.isPropertyAssignment(p)) throw this.error(p, 'this member of a destructuring assignment');
			const key = ts.isComputedPropertyName(p.name) ? null : (literalKey(p.name, this.checker) ?? p.name.getText());
			if (key === null) throw this.error(p, 'a computed key in a destructuring assignment');
			named.push(swiftString(key));
			const target: ts.Expression = ts.isShorthandPropertyAssignment(p) ? (p.objectAssignmentInitializer ? ts.factory.createBinaryExpression(p.name, ts.SyntaxKind.EqualsToken, p.objectAssignmentInitializer) : p.name) : p.initializer;
			const prop = source.getProperty(key);
			const part = prop && this.checker.getTypeOfSymbolAtLocation(prop, pattern);
			const record = /^JSRecord<(.*)>\??$/.exec(type)?.[1];
			if (untyped || !part) write(target, this.marks.ownTried(`${RT.jsGet}(${value}, ${swiftString(key)})`), 'Any?', part);
			else if (record) write(target, `${value}[${swiftString(key)}]`, optionalType(record), part);
			else {
				const pt = this.type(part, pattern);
				const d = prop!.valueDeclaration ?? prop!.declarations?.[0];
				const opt = !isOptional(pt) && !isUntyped(spelledType(pt)) && (((['String', 'Double', 'Bool'].includes(pt) || this.states.unsetMember(d)) && this.states.shapeFieldOptional(prop!)) || (!!d && this.states.widenedField(d)));
				write(target, this.marks.tryIf(this.getterThrows(source, key), `${value}.${ident(key)}`), opt ? optionalType(pt) : pt, part, key);
			}
		}
	},

	exprStatement(this: Translator, e: ts.Expression): string {
		const base = reassignedBase(e, this.checker);
		if (base && !this.subst.has(base)) {
			const held = this.fresh('__base');
			const code = this.expr(base);
			this.subst.set(base, held);
			try {
				return this.marks.blockCode(`do { let ${held} = ${code}; ${this.marks.triedStatement(this.tryPrefix(e), this.exprStatement(e))} }`);
			} finally {
				this.subst.delete(base);
			}
		}
		const rw = readWrite(e, this.checker);
		if (rw?.held.length && !rw.held.some((h) => this.subst.has(h))) return this.readWriteCode(e, rw);
		// A setter with a throwing body is a method call: the read, the operation and the write each made apart.
		if (rw && this.throwingWrite(rw.target)) {
			const v = this.readWriteValue(e),
				tp = this.tryPrefix(e);
			const call = `({ () ${tp ? 'throws ' : ''}-> ${v.type} in ${v.code} }())`;
			return this.marks.assignedCode('_', tp ? this.marks.tryCode(call) : call);
		}
		{
			let x = e;
			while (ts.isParenthesizedExpression(x)) x = x.expression;
			if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(x.left) || (ts.isArrayLiteralExpression(x.left) && this.isAny(x.right)) || (ts.isArrayLiteralExpression(x.left) && x.left.elements.some((t) => !ts.isIdentifier(t) && !ts.isPropertyAccessExpression(t) && !ts.isElementAccessExpression(t) && !ts.isOmittedExpression(t))))) {
				return this.patternAssignment(x.left, x.right);
			}
		}
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(e.left)) {
			// `[a, b] = [b, a]`: the right side is evaluated before any target is written.
			const tmp = this.fresh('__swap');
			const tuple = this.checker.isTupleType(this.checker.getTypeAtLocation(e.right));
			const elementType = tuple
				? null
				: this.typeOf(e.right)
						.replace(/[?!]$/, '')
						.replace(/^JSArray<(.*)>$/, '$1');
			const assigns = e.left.elements
				.map((target, k) => {
					if (ts.isOmittedExpression(target)) return '';
					// An untyped element (`[x, y] = args.slice(1)`) as the variable's type.
					const value = tuple ? `${tmp}.${k}` : isUntyped(spelledType(elementType)) ? (!this.isAny(target) ? this.fromAnyCode(this.marks.elementOf(tmp, k), this.typeOf(target), true) : `(${this.marks.elementOf(tmp, k)} ?? nil)`) : `${tmp}[${k}]`;
					const member = this.untypedMember(target);
					if (member) return this.marks.tryCode(`${RT.jsSet}(${member.object}, ${member.key}, ${value})`);
					// An element past the array's end is undefined, which a target held optional takes.
					const read = tuple || isUntyped(spelledType(elementType)) ? value : this.marks.orNil(this.marks.elementOf(tmp, k));
					const readType = tuple ? splitTopLevel(this.typeOf(e.right).replace(/\?$/, '').slice(1, -1))[k] : isUntyped(spelledType(elementType)) ? 'Any?' : optionalType(elementType!);
					const want = this.declaredTypeOf(target) ?? this.typeOf(target);
					const reads = nullishPart(this.placement, target, e.left, this.checker.getTypeAtLocation(e.right), k);
					const nullish = reads === 'element' ? nullishWrite(this.placement, target, `${RT.jsNulledEntry}(${this.marks.elementOf(tmp, k)})`, 'Any?') : nullishWrite(this.placement, target, read, readType, reads === 'null');
					// A variable's write cannot throw; the conversion `castThrows` counts at it is the value's own `try`.
					return this.marks.tryBefore(ts.isIdentifier(target) ? '' : this.tryPrefix(target), `${this.lvalue(target)} = ${nullish ?? (read !== value && isOptional(want) ? this.convert(read, readType, want) : value)}`);
				})
				.filter(Boolean);
			// Typed as the tuple, so a literal takes its element's type (`[start, length] = [center, 0]`: 0 as a Double, not an Int).
			return this.marks.blockCode(`do { let ${tmp}${tuple ? `: ${this.typeOf(e.right)}` : ''} = ${this.marks.tryBefore(this.tryPrefix(e.right), this.expr(e.right))}; ${assigns.join('; ')} }`);
		}
		if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
			const step = e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : e.operator === ts.SyntaxKind.MinusMinusToken ? '-' : null;
			// An untyped variable counts as a number (`let i; … i++`).
			const member = step ? this.untypedMember(e.operand) : null;
			if (member) return `${RT.jsPostUpdate}(${member.object}, ${member.key}, ${step}1)`;
			if (step && this.recordEntry(e.operand)) {
				const v = this.readWriteValue(e),
					tp = this.tryPrefix(e);
				const call = `({ () ${tp ? 'throws ' : ''}-> ${v.type} in ${v.code} }())`;
				return this.marks.assignedCode('_', tp ? this.marks.tryCode(call) : call);
			}
			if (step && (this.isAny(e.operand) || isUntyped(spelledType(this.declaredTypeOf(e.operand))))) return `${this.lvalue(e.operand)} = ${RT.jsToNumber}(${this.expr(e.operand)}) ${step} 1`;
			const held = step ? this.optionalNumberOperand(e.operand) : null;
			if (held !== null) return `${this.lvalue(e.operand)} = ${held} ${step} 1`;
			if (step) return `${this.lvalue(e.operand)} ${step}= 1`;
		}
		// `a = b = value`: the value once, then each target from the innermost out.
		const assignment = (x: ts.Expression): ts.BinaryExpression | null => {
			while (ts.isParenthesizedExpression(x)) x = x.expression;
			return ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken ? x : null;
		};
		if (assignment(e) && assignment(assignment(e)!.right)) {
			const chain: ts.BinaryExpression[] = [];
			for (let a = assignment(e); a; a = assignment(a.right)) chain.push(a);
			let value = chain.at(-1)!.right;
			while (ts.isParenthesizedExpression(value)) value = value.expression;
			const tmp = this.fresh('__assigned');
			// A value with no effects is read where it is assigned; any other once, held. An object literal is made as its context has it (a kit property's untyped object): held as made.
			const held = !this.pure(value) || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value);
			const out = !held ? [] : [ts.isObjectLiteralExpression(value) ? `let ${tmp} = ${this.marks.tryBefore(this.tryPrefix(value), this.expr(value))}` : `let ${tmp}: ${this.typeOf(value)} = ${this.marks.tryBefore(this.tryPrefix(value), this.expr(value))}`];
			const read = [value, ...chain.slice(1)];
			this.subst.set(value, held ? tmp : this.expr(value));
			try {
				for (const a of [...chain].reverse()) {
					// The value is read once, before: only what this target's own write does can throw.
					const code = this.expr(a);
					out.push(this.marks.tryIf(this.throwsInfo.expr(a.left) || this.throwsInfo.own(a) || this.castThrows(a.right) || this.checkedThrows(a.right), `${code}`));
					// The next target reads what this one now holds, as its own type has it (`x = elem = opened`).
					this.subst.set(a, ts.isIdentifier(a.left) ? this.expr(a.left) : held ? tmp : this.expr(value));
				}
			} finally {
				for (const r of [...read, ...chain]) this.subst.delete(r);
			}
			return this.marks.blockCode(`do { ${out.join('; ')} }`);
		}
		// `i = 0, l = n`: each in turn.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) return `${this.exprStatement(e.left)}; ${this.tryPrefix(e.right)}${this.exprStatement(e.right)}`;
		if (ts.isAwaitExpression(e) && this.subst.has(e)) return this.marks.assignedCode('_', this.subst.get(e)!);
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && !this.subst.has(e)) return this.binary(e);
		const code = this.expr(e);
		if (ts.isBinaryExpression(e) && e.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return code;
		// A call whose result is unused (`arr.push(x)` returns the length in JavaScript), as Swift types it where the program declares the function.
		if (ts.isCallExpression(e)) {
			const declared = this.calledType(e);
			return (declared ?? this.typeOf(e)) === 'Void' || this.typeOf(e) === 'Never' ? code : this.marks.assignedCode('_', code);
		}
		return this.marks.assignedCode('_', code);
	},
};
