// Expression statements as Kotlin, with the assignments of patterns and iterated values.
import ts from 'typescript';
import { nullishPart, nullishWrite } from '../semantics/placement.ts';
import { ident, isNullable, kotlinString, oneExpression, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { reassignedBase } from '../semantics/ast.ts';
import { readWrite, unsafeReceiver } from '../semantics/lang.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const exprStatementsMethods = {
	assignIterated(this: Translator, target: ts.Expression, item: string, part: ts.Type | null, _of: ts.Expression): string[] {
		const assigns: string[] = [];
		const to = ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses);
		if (ts.isArrayLiteralExpression(to) || ts.isObjectLiteralExpression(to)) this.assignPattern(to, item, part, assigns);
		else {
			const want = this.typeOf(to);
			const from = part ? this.type(part, to) : 'Any?';
			assigns.push(`${this.lvalue(to)} = ${isUntyped(spelledType(from)) ? (this.checkedBinding(to, item, want) ?? this.fromAnyCode(item, want, true)) : this.convert(item, from, want)}`);
		}
		return assigns;
	},

	exprStatement(this: Translator, e: ts.Expression): string {
		const base = reassignedBase(e, this.checker);
		if (base && !this.subst.has(base)) {
			const held = this.fresh('__base');
			const code = this.expr(base);
			this.subst.set(base, held);
			try {
				return `run { val ${held} = ${code}; ${this.exprStatement(e)} }`;
			} finally {
				this.subst.delete(base);
			}
		}
		const rw = readWrite(e, this.checker);
		if (rw?.held.length && !rw.held.some((h) => this.subst.has(h))) return this.readWriteCode(e, rw);
		const replaced = this.patterns.prototypeMethod(e);
		if (replaced) {
			// A Page's native view made by a plugin (gesturehandler's PageLayout): the kit's factory hook, `this` the page.
			if (replaced.target === 'Page' && replaced.method === 'createNativeView') {
				const ret = this.returnTypeOf(replaced.fn);
				return `Page.nativeViewFactory = fun Page.(): ${ret} ${this.functionBody(replaced.fn, ret, this.indent)}`;
			}
			return `JSPrototypes.of(${replaced.target}::class.java)[${kotlinString(replaced.method)}] = ${this.coerce(replaced.fn, 'Any?')}`;
		}
		// Assigning a class alias its class (`PageLayout = com.….PageLayout`): its uses already name the class.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(e.left)) {
			const decl = this.resolve(e.left)?.valueDeclaration;
			if (decl && ts.isVariableDeclaration(decl) && this.native?.isClassAlias(decl)) return '';
		}
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(e.left) || ts.isArrayLiteralExpression(e.left))) {
			// The right side is evaluated before any target is written (`[a, b] = [b, a]`).
			const tmp = this.fresh('__swap');
			const assigns: string[] = [];
			this.assignPattern(e.left, tmp, this.untypedSource(e.right) ? null : this.checker.getTypeAtLocation(e.right), assigns);
			return `run { val ${tmp} = ${this.expr(e.right)}; ${assigns.join('; ')} }`;
		}
		if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(e.operator)) {
			if (ts.isElementAccessExpression(e.operand) && isKit(spelledType(this.typeOf(e.operand.expression).replace(/\?$/, '')), 'JSRecord')) return this.readWriteValue(e);
			const place = this.untypedPlace(e.operand);
			if (place) return `${RT.jsSet}(${place.obj}, ${place.key}, ${RT.jsToNumber}(${RT.jsGet}(${place.obj}, ${place.key})) ${e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-'} 1.0)`;
			if (this.heldOptionalNumber(e.operand)) return `${this.lvalue(e.operand)} = ${this.heldNumber(e.operand)} ${e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-'} 1.0`;
		}
		if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
			// An untyped variable (`let i = recursiveIndex`) holds the number the operation gives.
			if (this.isAny(e.operand) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(e.operator)) return `${this.lvalue(e.operand)} = ${this.toNumber(e.operand)} ${e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-'} 1.0`;
			if (e.operator === ts.SyntaxKind.PlusPlusToken) return `${this.lvalue(e.operand)} += ${this.one(e.operand)}`;
			if (e.operator === ts.SyntaxKind.MinusMinusToken) return `${this.lvalue(e.operand)} -= ${this.one(e.operand)}`;
		}
		if (ts.isAwaitExpression(e) && this.subst.has(e)) return this.subst.get(e)!;
		if (ts.isParenthesizedExpression(e)) return this.exprStatement(e.expression);
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) return `${this.exprStatement(e.left)}; ${this.exprStatement(e.right)}`;
		if (ts.isVoidExpression(e)) return this.exprStatement(e.expression);
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && !this.subst.has(e)) return this.binary(e);
		if (
			ts.isBinaryExpression(e) &&
			e.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
			!this.subst.has(e) &&
			ts.isElementAccessExpression(e.left) &&
			!e.left.questionDotToken &&
			!(e.left.flags & ts.NodeFlags.OptionalChain) &&
			this.typeOf(e.left.expression) === 'JSArray<Double>' &&
			!this.states.heldOptional(e.left.expression) &&
			!unsafeReceiver(e.left.expression, this.checker) &&
			!this.isAny(e.right)
		) {
			return `${this.expr(e.left.expression)}.addDoubleAt(${this.toNumber(e.left.argumentExpression)}, ${this.toNumber(e.right)})`;
		}
		const code = this.expr(e);
		// A value converted to nothing (`run { call(); Unit }`) where nothing reads it: what gives the value, alone.
		const m = ts.isCallExpression(e) ? this.marks.markOf(code) : undefined;
		const inner = m?.op === 'discarded' ? m.of.code : null;
		return inner && oneExpression(inner) ? inner : code;
	},

	/** Whether a destructuring assignment's source is read by key, as script holds it. */
	untypedSource(this: Translator, e: ts.Expression): boolean {
		return this.isAny(e) || this.isAny(e);
	},

	/**
	 * Statements assigning `value` to a destructuring assignment's target: a variable or member, or a nested array or
	 * object pattern whose elements take their defaults where the value reads undefined. `source` is the value's
	 * TypeScript type, which decides how Kotlin holds it (a Pair or Triple for a short tuple); null where it is untyped.
	 */
	assignPattern(this: Translator, target: ts.Expression, value: string, source: ts.Type | null, out: string[]): void {
		type Read = { code: string; type: string; ts: ts.Type | null };
		const held = source ? this.type(source, target).replace(/\?$/, '') : 'Any?';
		const untyped = !source || held === 'Any' || held === 'JSObject';
		const fields = ['first', 'second', 'third'];
		const tupleArgs = source && this.checker.isTupleType(source) ? this.checker.getTypeArguments(source as ts.TypeReference) : null;
		const pairLike = /^(Pair|Triple)</.test(held) && !!tupleArgs;
		const element = (k: number): Read => {
			if (untyped) return { code: `${RT.jsField}(${value}, "${k}")`, type: 'Any?', ts: null };
			if (pairLike) return { code: `${value}.${fields[k]}`, type: this.type(tupleArgs![k], target), ts: tupleArgs![k] };
			const array = /^JSArray<(.*)>$/.exec(held);
			if (!array) throw this.error(target, `destructuring a ${held}`);
			// Past the end reads undefined.
			const el = tupleArgs ? (tupleArgs[k] ?? null) : this.checker.isArrayType(source!) ? this.checker.getTypeArguments(source as ts.TypeReference)[0] : null;
			return { code: `${value}.element(${k}.0)`, type: optionalType(array[1]), ts: isUntyped(spelledType(array[1])) ? null : el };
		};
		const property = (key: string, at: ts.Node): Read => {
			const record = /^JSRecord<(.*)>$/.exec(held);
			if (record) return { code: `${value}[${kotlinString(key)}]`, type: optionalType(record[1]), ts: source!.getStringIndexType() ?? null };
			const prop = untyped ? undefined : source!.getProperty(key);
			if (!prop) return { code: `${RT.jsGet}(${value}, ${kotlinString(key)})`, type: 'Any?', ts: null };
			const t = this.checker.getTypeOfSymbolAtLocation(prop, at);
			const pt = this.type(t, at);
			const d = prop.valueDeclaration ?? prop.declarations?.[0];
			const opt = !isNullable(pt) && !isUntyped(spelledType(pt)) && (((['String', 'Double', 'Boolean'].includes(pt) || this.states.unsetMember(d)) && this.states.shapeFieldOptional(prop)) || (!!d && this.states.widenedField(d)));
			return { code: `${value}.${ident(key)}`, type: opt ? optionalType(pt) : pt, ts: t };
		};
		const assign = (to: ts.Expression, read: Read, init?: ts.Expression, key: string | number | null = null) => {
			const reads = nullishPart(this.placement, to, target, source, key);
			if (reads) {
				const write = reads === 'keyed' ? { code: `${RT.jsGet}(${value}, ${kotlinString(String(key))})`, type: 'Any?' } : reads === 'element' ? { code: `${RT.jsNulledElement}(${value}, ${key}.0)`, type: 'Any?' } : { ...read };
				if (init && reads !== 'null') {
					write.code = `(${this.convert(write.code, write.type, 'Any?')} ?: ${this.coerce(init, 'Any?')})`;
					write.type = 'Any?';
				}
				out.push(`${this.lvalue(ts.skipOuterExpressions(to, ts.OuterExpressionKinds.Parentheses))} = ${nullishWrite(this.placement, to, write.code, write.type, reads === 'null')}`);
				return;
			}
			const meets = init && !untyped ? this.states.partDefault(target, source!, key) : 'empty';
			if (meets === 'never') init = undefined;
			else if (meets === 'keyed') read = { code: `${RT.jsField}(${value}, ${kotlinString(String(key))})`, type: 'Any?', ts: null };
			else if (meets === 'element' && init) {
				read = { ...read, code: `(if (${key}.0 < ${value}.length) ${value}[${key}] else ${this.coerce(init, read.type)})` };
				init = undefined;
			}
			to = ts.skipOuterExpressions(to, ts.OuterExpressionKinds.Parentheses);
			if (ts.isArrayLiteralExpression(to) || ts.isObjectLiteralExpression(to)) {
				const inner = read.ts && !isUntyped(spelledType(read.type)) ? this.checker.getNonNullableType(read.ts) : null;
				const want = inner ? this.type(inner, to) : 'Any?';
				// A nested pattern of undefined throws, as JavaScript's destructuring does.
				const code = !inner ? (init ? `(${read.code} ?: ${this.coerce(init, 'Any?')})` : read.code) : !isNullable(read.type) ? read.code : init ? `(${read.code} ?: ${this.coerce(init, want)})` : this.asserted(read.code);
				const tmp = this.fresh('__d');
				out.push(`val ${tmp} = ${code}`);
				this.assignPattern(to, tmp, inner, out);
				return;
			}
			const want = this.typeOf(to);
			let code: string;
			const untypedRead = (c: string) => (['String', 'Double', 'Boolean'].includes(want) ? this.fromAnyCode(c, want, true) : this.fromAny(c, want));
			if (isUntyped(spelledType(read.type))) {
				const c = init ? `(${read.code} ?: ${this.coerce(init, 'Any?')})` : read.code;
				code = this.checkedBinding(to, c, want) ?? untypedRead(c);
			} else if (init && isNullable(read.type)) code = `(${this.convert(read.code, read.type, optionalType(want))} ?: ${this.coerce(init, want)})`;
			else if (read.type === optionalType(want) && read.type !== want) code = this.undefinedAs(read.code, want);
			else code = this.convert(read.code, read.type, want);
			const place = this.untypedPlace(to);
			out.push(place ? `${RT.jsSet}(${place.obj}, ${place.key}, ${code})` : `${this.lvalue(to)} = ${code}`);
		};
		const withDefault = (x: ts.Expression): [ts.Expression, ts.Expression | undefined] => (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken ? [x.left, x.right] : [x, undefined]);
		if (ts.isArrayLiteralExpression(target)) {
			target.elements.forEach((x, k) => {
				if (ts.isOmittedExpression(x)) return;
				if (!ts.isSpreadElement(x)) {
					const [to, init] = withDefault(x);
					assign(to, element(k), init, k);
					return;
				}
				const want = this.typeOf(x.expression);
				let rest: string;
				if (untyped) rest = this.fromAnyCode(`${RT.jsCallMethod}(${value}, "slice", ${k}.0)`, want, true);
				else if (pairLike) {
					// A Pair's or Triple's fields from here on, as an array.
					const el = want.replace(/\?$/, '').replace(/^JSArray<(.*)>$/, '$1');
					rest = `${RT.jsArrayOf}<${el}>(${tupleArgs!
						.slice(k)
						.map((a, j) => this.convert(`${value}.${fields[k + j]}`, this.type(a, x), el))
						.join(', ')})`;
				} else rest = this.convert(`${value}.slice(${k}.0)`, held, want);
				out.push(`${this.lvalue(x.expression)} = ${rest}`);
			});
			return;
		}
		if (!ts.isObjectLiteralExpression(target)) throw this.error(target, 'this destructuring target');
		const keys: string[] = [];
		for (const p of target.properties) {
			if (ts.isShorthandPropertyAssignment(p)) {
				keys.push(p.name.text);
				assign(p.name, property(p.name.text, p), p.objectAssignmentInitializer, p.name.text);
			} else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name))) {
				keys.push(p.name.text);
				const [to, init] = withDefault(p.initializer);
				assign(to, property(p.name.text, p), init, p.name.text);
			} else if (ts.isSpreadAssignment(p)) {
				out.push(`${this.lvalue(p.expression)} = ${this.fromAny(`${RT.jsObjectRest}(${value}, listOf(${keys.map(kotlinString).join(', ')}))`, this.typeOf(p.expression))}`);
			} else throw this.error(p, 'this member of a destructuring assignment');
		}
	},
};
