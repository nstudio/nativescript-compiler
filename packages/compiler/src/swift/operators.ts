// Operators and literals as Swift: new, typeof, prefix, assignment, binary, equality, array and object literals.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { BUILTIN_CLASSES } from './library.ts';
import { ERRORS } from '../semantics/globals.ts';
import { balanced, inOptionalChain, isCompoundAssignment, isFunctionType, isNullish, isOptional, isStringType, numericLiteralOnly, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { asOperation, assignmentOf, readWrite } from '../semantics/lang.ts';
import { assertedFrom, emptyComparison, scriptComparison } from '../semantics/placement.ts';
import { notedField } from '../semantics/shapes.ts';
import { isLibDeclaration } from '../semantics/ast.ts';
import { constClassExpr } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { bigIntArithmetic, bigIntCompare, bigIntPlan, type BigIntInfix } from '../semantics/apis/bigint.ts';
import { BIT_ASSIGNMENTS, addCall, bitOperation, concatOperand, numericThrowing, untypedBinary, untypedConversion } from '../semantics/apis/operators.ts';

/** BigInt's operations the backend spells as an operator. */
const BIGINT_INFIX: { readonly [Op in BigIntInfix]: string } = { add: '+', subtract: '-', multiply: '*', and: '&', or: '|', xor: '^' };

export const operatorsMethods = {
	binary(this: Translator, e: ts.BinaryExpression): string {
		const op = e.operatorToken.kind;
		const K = ts.SyntaxKind;
		const l = () => this.expr(e.left);
		const r = () => this.expr(e.right);
		const target = () => this.lvalue(e.left);
		const assigned = (value: () => string) => {
			const place = this.place(e.left);
			return this.marks.assignedCode(place.code, value(), place.throws);
		};
		const big = this.bigIntBinary(e);
		if (big) return big;
		const untyped = this.untypedOperation(e);
		const thrown = untypedBinary(this, untyped, e);
		if (thrown) return thrown;
		const bit = !BIT_ASSIGNMENTS[op] && bitOperation(op, RT);
		if (bit) return `${bit}(${this.toNumber(e.left)}, ${this.toNumber(e.right)})`;
		// A record's entry, read back optional: the operation's value, assigned as `=` assigns it.
		if (isCompoundAssignment(op) && ![K.QuestionQuestionEqualsToken, K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken].includes(op) && this.recordEntry(e.left)) {
			this.subst.set(
				e,
				this.entryRead(e.left, () => this.binary(asOperation(e))),
			);
			try {
				return this.assignment(assignmentOf(e, e.left, e));
			} finally {
				this.subst.delete(e);
			}
		}
		const member = this.untypedMember(e.left);
		if (member && untyped?.kind === 'numeric' && untyped.assigns) return this.untypedUpdate(member, numericThrowing(this, untyped, '__old', e.right));
		if (member && untyped?.kind === 'add' && untyped.assigns) return this.untypedUpdate(member, `${RT.jsAddThrowing}(__old, ${this.coerce(e.right, 'Any?')})`);
		if (member) {
			const n = (x: string) => `${RT.jsToNumber}(${x})`;
			const arithmetic: Partial<Record<ts.SyntaxKind, (old: string, v: string) => string>> = {
				[K.PlusEqualsToken]: (o) => `${RT.jsAdd}(${o}, ${this.coerce(e.right, 'Any?')})`,
				[K.MinusEqualsToken]: (o, v) => `${n(o)} - (${v})`,
				[K.AsteriskEqualsToken]: (o, v) => `${n(o)} * (${v})`,
				[K.SlashEqualsToken]: (o, v) => `${n(o)} / (${v})`,
				[K.PercentEqualsToken]: (o, v) => `${RT.jsMod}(${n(o)}, ${v})`,
				[K.AsteriskAsteriskEqualsToken]: (o, v) => `${RT.jsPow}(${n(o)}, ${v})`,
			};
			for (const k of Object.keys(BIT_ASSIGNMENTS)) arithmetic[+k as ts.SyntaxKind] = (o, v) => `${bitOperation(+k, RT)}(${n(o)}, ${v})`;
			const make = arithmetic[op];
			if (make) return this.untypedUpdate(member, make('__old', op === K.PlusEqualsToken ? '' : this.toNumber(e.right)), this.throwsInfo.expr(e.right));
			if (op === K.BarBarEqualsToken || op === K.AmpersandAmpersandEqualsToken) {
				return this.marks.blockCode(`if ${op === K.BarBarEqualsToken ? '!' : ''}${RT.jsTruthy}(${this.tryPrefix(e.left)}${l()}) { ${this.tryPrefix(e)}${this.assignment(e)} }`);
			}
		}
		if (BIT_ASSIGNMENTS[op] || untyped?.kind === 'numeric') {
			const value = untyped?.kind === 'numeric' ? numericThrowing(this, untyped, e.left, e.right) : `${bitOperation(op, RT)}(${this.toNumber(e.left)}, ${this.toNumber(e.right)})`;
			// `options |= UIMenuOptions.Destructive` on a native option set: the set of the combined raw value.
			const lt = this.declaredTypeOf(e.left) ?? this.typeOf(e.left);
			return assigned(() => (this.native.isEnumType(lt.replace(/\?$/, '')) ? this.native.enumFromNumber(value, lt) : value));
		}
		// A number held optional (a variable lenient code may read before it is assigned, a field of a shape read from JSON): the
		// operation on what it holds, NaN when undefined, 0 when null.
		const arithmetic: Partial<Record<ts.SyntaxKind, (old: string, v: string) => string>> = {
			[K.PlusEqualsToken]: (o, v) => `${o} + (${v})`,
			[K.MinusEqualsToken]: (o, v) => `${o} - (${v})`,
			[K.AsteriskEqualsToken]: (o, v) => `${o} * (${v})`,
			[K.SlashEqualsToken]: (o, v) => `${o} / (${v})`,
			[K.PercentEqualsToken]: (o, v) => `${RT.jsMod}(${o}, ${v})`,
			[K.AsteriskAsteriskEqualsToken]: (o, v) => `${RT.jsPow}(${o}, ${v})`,
		};
		const keyed = () => this.states.unsetNullField(e.left) && this.states.nullableEntry(e.left, () => this.expr(e.left));
		const held = this.optionalNumberOperand(e.left);
		if (arithmetic[op] && held !== null && !this.isString(e.right)) return assigned(() => arithmetic[op]!(held, untyped ? untypedConversion(this, untyped, e.right) : this.toNumber(e.right)));
		switch (op) {
			case K.EqualsToken:
				return this.assignment(e);
			// An untyped variable holds whatever the operation gives: a string, or a number.
			case K.PlusEqualsToken: {
				if (untyped?.kind === 'add') return assigned(() => `${RT.jsAddThrowing}(${l()}, ${this.coerce(e.right, 'Any?')})`);
				if (this.isAny(e.left)) return assigned(() => `${RT.jsAdd}(${l()}, ${this.coerce(e.right, 'Any?')})`);
				const added = () => (untyped?.kind === 'concat' ? concatOperand(this, e.right, untyped) : this.str(e.right));
				// A string that may be undefined is converted as JavaScript adds it (`undefined + 'x'` is "undefinedx").
				if (this.typeOf(e.left) === 'String?' || this.declaredTypeOf(e.left) === 'String?') return assigned(() => `${keyed() ? `${RT.jsToString}(${keyed()})` : this.states.nilIsNull(e.left) ? this.str(e.left) : `${RT.jsToString}(${this.expr(e.left)} as Any?)`} + ${added()}`);
				return this.isString(e.left) ? `${target()} += ${added()}` : `${target()} += ${untyped ? untypedConversion(this, untyped, e.right) : this.toNumber(e.right)}`;
			}
			case K.MinusEqualsToken:
				return this.isAny(e.left) ? assigned(() => `${this.toNumber(e.left)} - (${this.toNumber(e.right)})`) : `${target()} -= ${this.toNumber(e.right)}`;
			case K.AsteriskEqualsToken:
				return this.isAny(e.left) ? assigned(() => `${this.toNumber(e.left)} * (${this.toNumber(e.right)})`) : `${target()} *= ${this.toNumber(e.right)}`;
			case K.SlashEqualsToken:
				return this.isAny(e.left) ? assigned(() => `${this.toNumber(e.left)} / (${this.toNumber(e.right)})`) : `${target()} /= ${this.toNumber(e.right)}`;
			case K.PercentEqualsToken:
				return assigned(() => `${RT.jsMod}(${this.isAny(e.left) ? this.toNumber(e.left) : l()}, ${this.toNumber(e.right)})`);
			case K.AsteriskAsteriskEqualsToken:
				return assigned(() => `${RT.jsPow}(${this.isAny(e.left) ? this.toNumber(e.left) : l()}, ${this.toNumber(e.right)})`);
			case K.QuestionQuestionEqualsToken:
				if (this.isAny(e.left)) return this.marks.blockCode(`if ${this.tryPrefix(e.left)}${RT.jsIsNullish}(${l()}) { ${this.tryPrefix(e)}${this.assignment(e)} }`);
				// A variable held optional while undefined: assigned only while it is.
				if (ts.isIdentifier(e.left) && this.undefinedVars.has(this.resolve(e.left)!)) return this.marks.blockCode(`if ${target()} == nil { ${this.tryPrefix(e.right)}${target()} = ${this.stored(e.right, e.left, this.typeOf(e.left).replace(/\?$/, ''))} }`);
				// A slot held optional takes a fallback that may be undefined as it is (`this._appearance ??= lookup()` of null).
				if (readWrite(e, this.checker)?.stored ?? true) return assigned(() => `${l()} ?? ${(isOptional(this.declaredTypeOf(e.left) ?? this.typeOf(e.left)) ? this.maybeUndefined(e.right) : null) ?? this.stored(e.right, e.left, this.typeOf(e.left).replace(/\?$/, ''))}`);
				return this.marks.blockCode(`if ${this.tryPrefix(e.left)}${RT.jsIsNullish}(${l()}) { ${this.tryPrefix(e.right)}${target()} = ${(isOptional(this.declaredTypeOf(e.left) ?? this.typeOf(e.left)) ? this.maybeUndefined(e.right) : null) ?? this.stored(e.right, e.left, this.typeOf(e.left).replace(/\?$/, ''))} }`);
			case K.BarBarEqualsToken:
				return this.marks.blockCode(`if !${RT.jsTruthy}(${this.tryPrefix(e.left)}${l()}) { ${this.tryPrefix(e)}${target()} = ${this.stored(e.right, e.left, this.typeOf(e.left))} }`);
			case K.AmpersandAmpersandEqualsToken:
				return this.marks.blockCode(`if ${RT.jsTruthy}(${this.tryPrefix(e.left)}${l()}) { ${this.tryPrefix(e)}${target()} = ${this.stored(e.right, e.left, this.typeOf(e.left))} }`);
			case K.PlusToken: {
				if (this.isString(e.left) || this.isString(e.right)) return this.marks.infix(concatOperand(this, e.left, untyped), '+', concatOperand(this, e.right, untyped));
				if (this.isAny(e.left) || this.isAny(e.right)) {
					const sum = addCall(this, e, untyped),
						t = this.typeOf(e);
					return isUntyped(spelledType(t)) ? sum : this.fromAnyCode(sum, t);
				}
				return this.marks.infix(this.toNumber(e.left), '+', this.toNumber(e.right));
			}
			case K.MinusToken:
				return this.marks.infix(this.toNumber(e.left), '-', this.toNumber(e.right));
			case K.AsteriskToken:
				return this.marks.infix(this.toNumber(e.left), '*', this.toNumber(e.right));
			// Integer literals on both sides would divide as Int where no operand pins Double (`Double(1 / 8)`, `js(16 / 9)`).
			case K.SlashToken:
				return numericLiteralOnly(e.left) && numericLiteralOnly(e.right) ? `(${this.expr(e.left)} as Double) / ${this.expr(e.right)}` : this.marks.infix(this.toNumber(e.left), '/', this.toNumber(e.right));
			case K.PercentToken:
				return `${RT.jsMod}(${this.toNumber(e.left)}, ${this.toNumber(e.right)})`;
			case K.AsteriskAsteriskToken:
				return `${RT.jsPow}(${this.toNumber(e.left)}, ${this.toNumber(e.right)})`;
			case K.EqualsEqualsEqualsToken:
			case K.ExclamationEqualsEqualsToken:
			case K.EqualsEqualsToken:
			case K.ExclamationEqualsToken:
				return this.equality(e);
			case K.LessThanToken:
			case K.GreaterThanToken:
			case K.LessThanEqualsToken:
			case K.GreaterThanEqualsToken: {
				const sym = ts.tokenToString(op)!;
				if (this.isString(e.left) && this.isString(e.right)) return `${RT.jsCompare}(${l()}, ${r()}) ${sym} 0`;
				// An untyped side may hold a string, and two strings compare as strings.
				if (this.isAny(e.left) || this.isAny(e.right)) {
					const [a, b] = [this.coerce(e.left, 'Any?'), this.coerce(e.right, 'Any?')];
					return op === K.LessThanToken ? `(${RT.jsLessThan}(${a}, ${b}) == true)` : op === K.GreaterThanToken ? `(${RT.jsGreaterThan}(${a}, ${b}) == true)` : op === K.LessThanEqualsToken ? `(${RT.jsGreaterThan}(${a}, ${b}) == false)` : `(${RT.jsLessThan}(${a}, ${b}) == false)`;
				}
				return this.marks.infix(this.toNumber(e.left), sym, this.toNumber(e.right));
			}
			case K.QuestionQuestionToken: {
				const t = this.typeOf(e);
				const left = ts.skipOuterExpressions(e.left, ts.OuterExpressionKinds.Parentheses);
				const lt = this.typeOf(e.left);
				// A member of an untyped object, or one an optional chain reads: missing as read, before any conversion gives it a value.
				if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && this.isAny(left.expression) && !isUntyped(spelledType(lt)) && !isOptional(lt) && !isUntyped(spelledType(t))) {
					const key = ts.isPropertyAccessExpression(left) ? swiftString(left.name.text) : this.propertyKey(left.argumentExpression);
					const read = `${ts.isOptionalChain(left) ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(left.expression)}, ${key})`;
					return `(${this.fromAny(read, optionalType(lt))} ?? ${this.coerce(e.right, t)})`;
				}
				if (ts.isPropertyAccessExpression(left) && inOptionalChain(left) && !isUntyped(spelledType(lt)) && !isOptional(lt)) {
					this.optionalReads.set(left, false);
					try {
						const code = this.expr(left);
						if (this.optionalReads.get(left)) return this.marks.leading(`(${code} ?? ${this.coerce(e.right, t)})`, code);
					} finally {
						this.optionalReads.delete(left);
					}
				}
				// A call Swift declares to give a value it never lacks: the fallback never applies.
				const called = ts.isCallExpression(left) && !ts.isOptionalChain(left) ? this.calledType(left) : undefined;
				if (called && called === t && !isOptional(called) && !called.endsWith('!') && !isUntyped(spelledType(called)) && this.lenientRef(called) === called && !this.native.isStructType(called)) return l();
				// A read converting undefined (an untyped member or a record's entry asserted its type): the fallback applies where it is undefined.
				if (!this.library && ['Double', 'String', 'Bool'].includes(lt) && t === lt && !inOptionalChain(left)) {
					const held = this.convertedOptional(e.left, t);
					if (held) return this.marks.leading(`(${held} ?? ${this.coerce(e.right, t)})`, held);
				}
				// A chain that gives a default where it stops (`(contexts?.count ?? .nan)`): the optional, so this fallback applies.
				if (inOptionalChain(left) && ['Double', 'String', 'Bool'].includes(lt)) {
					const code = l();
					let read = code;
					for (let m; (m = /^\((.*) \?\? (?:\.nan|"undefined"|false)\)$/.exec(read)) && balanced(m[1]);) read = m[1];
					if (read !== code) return this.marks.leading(`(${read} ?? ${this.coerce(e.right, t)})`, read);
				}
				if (this.missingObjectType(e) && this.states.observedAsIs(e)) {
					const missing = this.maybeUndefined(e);
					if (missing) return missing;
				}
				const maybe = this.maybeUndefined(e.left);
				// Lenient code holds a number member declared optional as NaN while unset, as `typeof` reads it: undefined.
				if (!maybe && this.lenient && lt === 'Double' && t === 'Double' && this.optionalMember(left)) {
					const lc = l();
					return this.marks.leading(`(Optional(${lc}).flatMap { $0.isNaN ? nil : $0 } ?? ${this.coerce(e.right, t)})`, lc);
				}
				if (maybe && isUntyped(spelledType(t))) return `${RT.jsNullishCoalesce}(${maybe} as Any?, ${this.coerce(e.right, 'Any?')})`;
				// TypeScript types `s ?? 1` as the string `s` is declared; a missing `s` gives the fallback as a string.
				// Parenthesized: the optional may be a conditional (`x == nil ? nil : T(jsObject: x)`), which binds looser than `??`.
				if (maybe) {
					const right = t === 'String' && this.typeOf(e.right) !== 'String' ? this.str(e.right) : this.coerce(e.right, t);
					const checked = this.marks.requiredOf(right);
					return checked ? this.marks.tryCode(this.marks.helper('jsObjectRequired', `((${maybe}) ?? ${checked})`)) : this.marks.leading(`((${maybe}) ?? ${right})`, maybe);
				}
				if (this.isAny(e.left) && !isUntyped(spelledType(t)) && this.states.heldNullish(left)) return `(${this.fromAny(l(), optionalType(t))} ?? ${this.coerce(e.right, t)})`;
				if (this.isAny(e.left)) return `${RT.jsNullishCoalesce}(${l()}, ${this.coerce(e.right, 'Any?')})`;
				// An optional of another type than the whole's untyped value (`parts[k] ?? 1`): its nil is missing, not a value.
				if (isUntyped(spelledType(t)) && isOptional(lt) && !isUntyped(spelledType(lt))) return `${RT.jsNullishCoalesce}(${l()} as Any?, ${this.coerce(e.right, 'Any?')})`;
				// A left side Swift holds as no optional is never missing.
				if (!isOptional(lt) && !lt.endsWith('!') && !isUntyped(spelledType(lt)) && lt === t && !inOptionalChain(e.left) && this.definitelyPresent(e.left)) return l();
				const right = this.coerce(e.right, t),
					checked = this.marks.requiredOf(right);
				if (checked) return this.marks.tryCode(this.marks.helper('jsObjectRequired', `(${l()} ?? ${checked})`));
				const lc = l();
				return this.marks.leading(`(${lc} ?? ${right})`, lc);
			}
			case K.AmpersandAmpersandToken:
			case K.BarBarToken: {
				const sym = op === K.AmpersandAmpersandToken ? '&&' : '||';
				const orUndefined = isNullish(e.right) ? this.maybeUndefined(e) : null;
				if (orUndefined) return this.undefinedAs(orUndefined, this.typeOf(e), this.typeOf(e));
				const assertedLeft = this.assertedUntyped(e.left);
				if (this.isBool(e.left) && this.isBool(e.right) && !assertedLeft) {
					// A boolean that may be missing (a lenient app's optional member) is tested, as a typed slot takes its zero.
					const missing = (x: ts.Expression) => {
						while (ts.isParenthesizedExpression(x)) x = x.expression;
						return ts.isPropertyAccessExpression(x) && this.lenientOptionalMember(x);
					};
					return `${missing(e.left) ? this.cond(e.left) : l()} ${sym} ${missing(e.right) ? this.cond(e.right) : r()}`;
				}
				// `a && a.m && …`: a method read only to test it is there whenever `a` is, so the test is `a`'s.
				let left = e.left;
				while (ts.isParenthesizedExpression(left)) left = left.expression;
				if (op === K.AmpersandAmpersandToken && ts.isBinaryExpression(left) && left.operatorToken.kind === K.AmpersandAmpersandToken && ts.isPropertyAccessExpression(left.right) && left.right.expression.getText() === left.left.getText() && this.resolve(left.right.name)?.declarations?.some((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d))) left = left.left;
				else left = e.left;
				// JavaScript returns an operand, not a Bool.
				const t = this.typeOf(e);
				const v = this.fresh('__v');
				const right = this.coerce(e.right, t);
				const lt = this.tryPrefix(left) ? 'try ' : '';
				const rt = this.tryPrefix(e.right) ? 'try ' : '';
				const throws = lt || rt ? 'throws ' : '';
				// `a?.b || x`: the chain's undefined is falsy here, not the string or number it would convert to elsewhere.
				let inner = left;
				while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
				const chain = op === K.BarBarToken && ts.isPropertyAccessExpression(inner) && !!inner.questionDotToken;
				if (chain) this.optionalReads.set(inner, false);
				// A call that may give undefined (lenient code): the operand is the optional itself, falsy when missing.
				const missing = (ts.isCallExpression(inner) || ts.isElementAccessExpression(inner) || ts.isIdentifier(inner) || assertedLeft) && !isOptional(this.typeOf(left)) ? this.maybeUndefined(inner) : null;
				const leftCode = missing ?? this.expr(left);
				const leftType = missing || this.optionalReads.get(inner) ? optionalType(this.typeOf(left)) : this.typeOf(left);
				this.optionalReads.delete(inner);
				// The left operand is evaluated once; the result is it, unwrapped or boxed as the result's type needs.
				// A falsy left operand of another type is undefined or null where the result is optional.
				// A function operand where the result is untyped is boxed as a function value, as the other operand is.
				const leftValue =
					leftType === t && !t.endsWith('?') && t !== 'Void'
						? `${RT.jsPresent}(${v})`
						: isUntyped(spelledType(t)) && leftType !== t && isFunctionType(leftType.replace(/^\((.*)\)[?!]$/, '$1'))
							? this.convert(v, leftType, t)
							: leftType === t || isUntyped(spelledType(t))
								? v
								: leftType === optionalType(t)
									? op === K.AmpersandAmpersandToken && ['String', 'Double', 'Bool'].includes(t)
										? this.undefinedAs(v, t)
										: `${RT.jsPresent}(${v})`
									: isUntyped(spelledType(leftType))
										? this.fromAny(v, t)
										: t === 'Bool'
											? `${RT.jsTruthy}(${v})`
											: t.endsWith('?') && leftType.endsWith('?') && op === K.AmpersandAmpersandToken
												? 'nil'
												: // A falsy object of another type than the result (`child && hosts.get(child)`) is a missing one.
													t.endsWith('?') && op === K.AmpersandAmpersandToken && this.isObjectRef(left) && leftType.replace(/[?!]$/, '') !== t.replace(/[?!]$/, '')
													? 'nil'
													: v;
				// Lenient code: `a && a.b` where a is an object and the result is not: a falsy a is undefined, read as the result's type reads it.
				// An object result: a falsy object operand is missing, so the result is.
				if (this.lenient && op === K.AmpersandAmpersandToken && !isUntyped(spelledType(t)) && this.lenientRef(t) !== t && (leftType.endsWith('?') || this.lenientRef(leftType) !== leftType)) {
					return this.marks.implicitOf(`({ () ${throws}-> ${optionalType(t)} in let ${v} = ${this.marks.tryBefore(lt, leftCode)}; return ${RT.jsTruthy}(${v}) ? ${rt}${right} : nil }())`);
				}
				if ((this.lenient || this.lenientApp) && op === K.AmpersandAmpersandToken && leftValue === v && leftType.replace(/[?!]$/, '') !== t.replace(/[?!]$/, '') && !isUntyped(spelledType(t))) {
					const z = this.zero(t);
					if (z) return `({ () ${throws}-> ${t} in let ${v} = ${this.marks.tryBefore(lt, leftCode)}; return ${RT.jsTruthy}(${v}) ? ${rt}${right} : ${z} }())`;
					if (this.lenientRef(t) !== t || (this.lenientApp && !isFunctionType(t))) return this.marks.implicitOf(`({ () ${throws}-> ${optionalType(t)} in let ${v} = ${this.marks.tryBefore(lt, leftCode)}; return ${RT.jsTruthy}(${v}) ? ${rt}${right} : nil }())`);
				}
				// `a || b` of objects of one class: an object is truthy exactly when it is there.
				const sameObject = op === K.BarBarToken && this.isObjectRef(left) && this.isObjectRef(e.right) && !isFunctionType(t.replace(/^\((.*)\)[?!]$/, '$1')) && leftType.replace(/[?!]$/, '') === t.replace(/[?!]$/, '') && !leftCode.startsWith('try ');
				if (sameObject && ((leftValue === `${RT.jsPresent}(${v})` && leftType === optionalType(t)) || (leftValue === v && t.endsWith('?')))) return this.marks.leading(`(${leftCode} ?? ${right})`, leftCode);
				// Lenient code: `a || b` of objects is undefined when both are (`span.style.backgroundColor || parent.backgroundColor`).
				if (sameObject && /[?!]$/.test(leftType) && this.lenient && !isUntyped(spelledType(t)) && this.lenientRef(t) !== t && !t.endsWith('!')) return this.marks.leading(`((${leftCode} ?? ${right}) as ${optionalType(t)})`, leftCode);
				if (this.lenient && op === K.BarBarToken && !isUntyped(spelledType(t)) && this.lenientRef(t) !== t && !t.endsWith('!')) {
					return this.marks.implicitOf(`({ () ${throws}-> ${optionalType(t)} in let ${v} = ${this.marks.tryBefore(lt, leftCode)}; return ${RT.jsTruthy}(${v}) ? ${leftValue} : ${rt}${right} }())`);
				}
				return op === K.BarBarToken ? `({ () ${throws}-> ${t} in let ${v} = ${this.marks.tryBefore(lt, leftCode)}; return ${RT.jsTruthy}(${v}) ? ${leftValue} : ${rt}${right} }())` : `({ () ${throws}-> ${t} in let ${v} = ${this.marks.tryBefore(lt, leftCode)}; return ${RT.jsTruthy}(${v}) ? ${rt}${right} : ${leftValue} }())`;
			}
			case K.InstanceOfKeyword: {
				const ce = constClassExpr(e.right, this.checker);
				if (ce) return `(${this.observed(e.left)} is ${this.emitClassExpr(ce)})`;
				const name = e.right.getText();
				// A compiled program makes no String, Number or Boolean wrapper objects.
				if (['String', 'Number', 'Boolean'].includes(name) && isLibDeclaration(this.resolve(e.right)?.declarations?.[0])) return `({ _ = ${this.coerce(e.left, 'Any?')}; return false }())`;
				// The library's classes: the runtime's type of any of their instances (a promise of any result).
				const builtin = BUILTIN_CLASSES[name];
				if (builtin && isLibDeclaration(this.resolve(e.right)?.declarations?.[0])) return `(${l()} is ${builtin})`;
				// A class held as a value (`e instanceof C`, C a parameter): tested against the class it holds.
				if (!(ts.isIdentifier(e.right) && ((this.resolve(e.right)?.flags ?? 0) & ts.SymbolFlags.Class || ERRORS[name])) && this.isAny(e.right) && !isLibDeclaration(this.resolve(e.right)?.declarations?.[0])) {
					return `${RT.jsInstanceOf}(${this.coerce(e.left, 'Any?')}, ${this.expr(e.right)})`;
				}
				const swiftType =
					ERRORS[name] ??
					this.typeOf(e.right)
						.replace(/^typeof /, '')
						.replace(/\.Type$/, '');
				// A class the library declares that has no Swift type (the DOM's `FormData`): the kit's class of that name, as the runtime's globals are core's.
				if (isUntyped(spelledType(swiftType)) && ts.isIdentifier(e.right) && isLibDeclaration(this.resolve(e.right)?.declarations?.[0])) return `${RT.jsInstanceOfNamed}(${this.coerce(e.left, 'Any?')}, ${swiftString(name)})`;
				const known = this.heldInstance(e);
				if (known === 'present') return `(${this.observed(e.left)} != nil)`;
				if (known === 'always') return this.pure(e.left) ? 'true' : `({ _ = ${l()}; return true }())`;
				// A view of an object (`T.jsView`) is its root's instance.
				const lt = this.typeOf(e.left);
				const viewable = !this.library && (isUntyped(spelledType(lt)) || this.isObjectShape(lt.replace(/[?!]$/, '')));
				return viewable ? `(${RT.jsIdentity}(${this.observed(e.left)}) is ${swiftType ?? name})` : `(${this.observed(e.left)} is ${swiftType ?? name})`;
			}
			case K.CommaToken: {
				const throws = this.throwsInfo.expr(e);
				return `({ () ${throws ? 'throws ' : ''}-> ${this.typeOf(e)} in ${this.tryPrefix(e.left)}${this.exprStatement(e.left)}; return ${this.tryPrefix(e.right)}${r()} }())`;
			}
			case K.InKeyword:
				return `${RT.jsHasKey}(${this.coerce(e.right, 'Any?')}, ${this.propertyKey(e.left)})`;
		}
		throw this.error(e, `operator ${ts.tokenToString(op)}`);
	},

	/** An operator on BigInts (both sides, or a comparison with a number). */
	/**
	 * A number held optional (a variable lenient code may read before it is assigned, a field of a shape read from JSON, a
	 * `lenientNullField`) read as an arithmetic operand: NaN where undefined, 0 where null. Null for any other target.
	 */
	optionalNumberOperand(this: Translator, e: ts.Expression): string | null {
		const held = ts.isIdentifier(e) ? this.resolve(e) : undefined;
		if (!((held && this.undefinedVars.get(held) === 'Double?') || this.declaredTypeOf(e) === 'Double?')) return null;
		const nil = this.states.heldNumberNil(e, () => this.expr(e));
		if (!('keyed' in nil)) heldLoss('optionalNumberOperand', nil.isNull ? '0' : '.nan', { node: e });
		return 'keyed' in nil ? `${RT.jsToNumber}(${nil.keyed})` : `(${this.lvalue(e)} ?? ${nil.isNull ? '0' : '.nan'})`;
	},

	/** `++`/`--` of an `optionalNumberOperand` used as a value: the old number (postfix) or the new one. */
	optionalNumberUpdate(this: Translator, e: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): string | null {
		const old = this.optionalNumberOperand(e.operand);
		if (old === null) return null;
		const step = e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-',
			v = this.fresh('__old'),
			tp = this.tryPrefix(e.operand);
		const call = `({ () ${tp ? 'throws ' : ''}-> Double in let ${v} = ${tp}${old}; ${tp}${this.lvalue(e.operand)} = ${v} ${step} 1; return ${ts.isPostfixUnaryExpression(e) ? v : `${v} ${step} 1`} }())`;
		return tp ? this.marks.tryCode(call) : call;
	},

	bigIntBinary(this: Translator, e: ts.BinaryExpression): string | null {
		const plan = bigIntPlan(e.operatorToken.kind, this.typeOf(e.left) === 'JSBigInt', this.typeOf(e.right) === 'JSBigInt');
		if (!plan) return null;
		const l = () => this.expr(e.left),
			r = () => this.expr(e.right);
		if (plan.kind === 'arithmetic' && plan.assigns) {
			const place = this.place(e.left);
			return this.marks.assignedCode(place.code, bigIntArithmetic(plan.op, l(), r(), RT, BIGINT_INFIX), place.throws);
		}
		if (plan.kind === 'arithmetic') return bigIntArithmetic(plan.op, l(), r(), RT, BIGINT_INFIX);
		if (!plan.big) return `(${l()} ${plan.operator} ${r()})`;
		const left = plan.big === 'left';
		return `(${bigIntCompare(left ? l() : r(), this.toNumber(left ? e.right : e.left), RT)}.map { ${left ? '$0' : '-$0'} ${plan.operator} 0 } ?? false)`;
	},

	/** A method call or property read the iOS SDK declares (`userDefaults.objectForKey(key)`). */
	readsSdk(this: Translator, x: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(x)) x = x.expression;
		const target = ts.isCallExpression(x) ? x.expression : x;
		if (!ts.isPropertyAccessExpression(target)) return false;
		const decl = this.checker.getSymbolAtLocation(target.name)?.declarations?.[0];
		return !!decl && /[\\/]objc![^\\/]+\.d\.ts$/.test(decl.getSourceFile().fileName);
	},

	/** Whether a value's type is a class the program declares (not the SDK's or the runtime's). */
	programClass(this: Translator, e: ts.Expression): boolean {
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
		return !!t.getSymbol()?.declarations?.some((d) => ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile) && !t.isUnion();
	},

	/** A typed function value in its identity cell, optional (nil for undefined); null for an untyped one. */
	functionOperand(this: Translator, x: ts.Expression, type: string): string | null {
		const fn = type.replace(/^\((.*)\)[?!]$/, '$1');
		const cell = isFunctionType(fn) ? this.functionCell(fn) : null;
		if (!cell) return null;
		return fn === type && !this.loose(x) ? `${cell}(f: ${this.expr(x)}) as ${cell}?` : `{ (__c: (${fn})?) -> ${cell}? in if let __c { return ${cell}(f: __c) } else { return nil } }(${this.expr(x)})`;
	},

	/**
	 * `typeof x === 'T'` (or `'undefined'`) of a value whose Swift type allows only T or undefined (`Bool?`): whether it is
	 * there, a nil check. Null where the test is not one of presence.
	 */
	typeofPresence(this: Translator, e: ts.BinaryExpression): string | null {
		const strip = (x: ts.Expression) => ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
		const [l, r] = [strip(e.left), strip(e.right)];
		const [t, lit] = ts.isTypeOfExpression(l) && ts.isStringLiteralLike(r) ? [l, r] : ts.isTypeOfExpression(r) && ts.isStringLiteralLike(l) ? [r, l] : [null, null];
		if (!t || !lit) return null;
		const c = this.typeofCell(t);
		if (c.cell !== 'presence' || (lit.text !== 'undefined' && lit.text !== c.type)) return null;
		const negate = e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
		return `${c.tested} ${(lit.text === 'undefined') !== negate ? '==' : '!='} nil`;
	},

	equality(this: Translator, e: ts.BinaryExpression): string {
		this.refuseUnheldIdentity(e.left);
		this.refuseUnheldIdentity(e.right);
		const K = ts.SyntaxKind;
		const op = e.operatorToken.kind;
		const negate = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
		const strict = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken;
		const isNullish = (x: ts.Expression) => x.kind === K.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		const [a, b] = [e.left, e.right];
		const lt = this.typeOf(a);
		const rt = this.typeOf(b);
		const decided = this.neverNullish(e);
		if (decided !== undefined) return String(decided);
		const presence = this.typeofPresence(e);
		if (presence) return presence;
		// A `void` value is undefined, which Swift holds as `()`.
		const nothing = isNullish(b) && lt === 'Void' ? a : isNullish(a) && rt === 'Void' ? b : null;
		if (nothing && !this.states.nullishElementRead(nothing)) {
			const equal = !strict || (isNullish(b) ? b : a).kind !== K.NullKeyword;
			const result = negate !== equal;
			return this.pure(nothing) ? String(result) : `${RT.jsUndefined}(${this.expr(nothing)}) ${result ? '==' : '!='} nil`;
		}
		// A `T | null` value compared strictly with undefined, or a `T | undefined` one with null: never the same.
		const empty = emptyComparison(this.placement, e);
		if (empty?.cell === 'stored') return `${negate ? '!' : ''}${empty.strict ? `${RT.jsStrictEquals}(${this.expr(empty.x)}, ${empty.isNull ? 'jsNull' : 'nil'})` : `${RT.jsIsNullish}(${this.expr(empty.x)})`}`;
		if (empty?.cell === 'empty') return `${negate ? '!' : ''}${RT.jsStrictEquals}(${this.observe(empty.x)}, ${empty.isNull ? 'jsNull' : 'nil'})`;
		// Comparing a typed optional with null or undefined.
		// An element held as `JSNullish<T>`: loosely, its null and its undefined are both empty.
		const slot = isNullish(b) ? a : isNullish(a) ? b : null;
		if (slot && !strict && this.states.nullishElementRead(slot)) return `${negate ? '!' : ''}${RT.jsIsNullish}(${this.maybeUndefined(slot) ?? this.expr(slot)})`;
		const maybe = isNullish(b) ? this.maybeUndefined(a) : isNullish(a) ? this.maybeUndefined(b) : null;
		if (maybe) {
			// An untyped value holds null as `jsNull`, apart from undefined's nil.
			if (isUntyped(spelledType(isNullish(b) ? lt : rt)) && (!strict || (isNullish(b) ? b : a).kind === K.NullKeyword)) return `${negate ? '!' : ''}${strict ? `${RT.jsStrictEquals}(${maybe}, ${this.observe(isNullish(b) ? b : a)})` : `${RT.jsIsNullish}(${maybe})`}`;
			return `${maybe} ${negate ? '!=' : '=='} nil`;
		}
		// A member of an untyped object compared with null or undefined: the value as read, before any conversion to the declared type.
		const untypedRead = (x: ts.Expression) => (ts.isElementAccessExpression(x) || ts.isPropertyAccessExpression(x)) && this.isAny(x.expression) && !this.isAny(x);
		const raw = (x: ts.Expression) => {
			if (!untypedRead(x)) return this.observe(x);
			const target = (x as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
			const key = ts.isElementAccessExpression(x) ? this.propertyKey(x.argumentExpression) : swiftString((x as ts.PropertyAccessExpression).name.text);
			return `${ts.isOptionalChain(x) ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(target)}, ${key})`;
		};
		// Function values: the same function when their closures stand for one (`jsSameFunction`).
		if (!isNullish(a) && !isNullish(b) && (isFunctionType(lt.replace(/^\((.*)\)[?!]$/, '$1')) || isFunctionType(rt.replace(/^\((.*)\)[?!]$/, '$1')))) {
			const ca = this.functionOperand(a, lt),
				cb = this.functionOperand(b, rt);
			if (ca && cb) return `${negate ? '!' : ''}${RT.jsSameFunction}(${ca}, ${cb})`;
			// One side untyped: as script values, the typed one boxed as the one function object it stands for.
			return `${negate ? '!' : ''}${RT.jsStrictEquals}(${this.observe(a)}, ${this.observe(b)})`;
		}
		if ((isNullish(b) && untypedRead(a)) || (isNullish(a) && untypedRead(b))) {
			const [x, n] = isNullish(b) ? [a, b] : [b, a];
			return `${negate ? '!' : ''}${strict ? `${RT.jsStrictEquals}(${raw(x)}, ${this.observe(n)})` : `${RT.jsIsNullish}(${raw(x)})`}`;
		}
		// A noted string, number or boolean field stores its zero: its null or undefined is read by name.
		const zeroNoted = (x: ts.Expression) => notedField(this.states, x) && ['String', 'Double', 'Bool'].includes(this.typeOf(x));
		const noted = isNullish(b) && zeroNoted(a) ? [a, b] : isNullish(a) && zeroNoted(b) ? [b, a] : null;
		if (noted) return `${negate ? '!' : ''}${strict ? `${RT.jsStrictEquals}(${this.coerce(noted[0], 'Any?')}, ${this.observe(noted[1])})` : `${RT.jsIsNullish}(${this.coerce(noted[0], 'Any?')})`}`;
		// A member of an untyped object compared with a value: the comparison JavaScript makes, which a missing member fails.
		if (untypedRead(a) || untypedRead(b)) return `${negate ? '!' : ''}${strict ? RT.jsStrictEquals : RT.jsLooseEquals}(${raw(a)}, ${raw(b)})`;
		// Lenient code: a variable of one of the program's classes holds nothing as undefined, which is not null, unless the program gives it null.
		if (strict && this.lenient) {
			const [x, n] = isNullish(b) ? [a, b] : isNullish(a) ? [b, a] : [null, null];
			if (x && n && n.kind === K.NullKeyword && ts.isIdentifier(x) && this.programClass(x) && !(this.library && this.states.libraryNullVariable(x))) return negate ? 'true' : 'false';
		}
		// Lenient code holds an undefined or null number as NaN.
		if (this.lenient && ((isNullish(b) && lt === 'Double') || (isNullish(a) && rt === 'Double'))) return `${negate ? '!' : ''}${this.expr(isNullish(b) ? a : b)}.isNaN`;
		// An SDK read typed `any` (`userDefaults.objectForKey(key) !== null`): the runtime hands script Objective-C's nil as null.
		if (strict && ((b.kind === K.NullKeyword && isUntyped(spelledType(lt)) && this.readsSdk(a)) || (a.kind === K.NullKeyword && isUntyped(spelledType(rt)) && this.readsSdk(b)))) {
			return `${this.expr(b.kind === K.NullKeyword ? a : b)} ${negate ? '!=' : '=='} nil`;
		}
		// An optional the read unwraps (a native property TypeScript declares non-null) is compared as it is.
		const tested = (x: ts.Expression) => {
			const code = this.expr(x);
			return this.marks.unwrapInner(code) ?? code;
		};
		if (isNullish(b) && !isUntyped(spelledType(lt))) return `${tested(a)} ${negate ? '!=' : '=='} nil`;
		if (isNullish(a) && !isUntyped(spelledType(rt))) return `${tested(b)} ${negate ? '!=' : '=='} nil`;
		const script = scriptComparison(this.placement, e, (x) => this.unboundGeneric(x));
		if (script?.cell === 'nullish') return `${negate ? '!' : ''}${RT.jsIsNullish}(${this.observe(script.x)})`;
		if (script) return `${negate ? '!' : ''}${strict ? RT.jsStrictEquals : RT.jsLooseEquals}(${this.observe(assertedFrom(this.placement, a) ?? a)}, ${this.observe(assertedFrom(this.placement, b) ?? b)})`;
		if (this.isObjectRef(a) && this.isObjectRef(b)) return `${tested(a)} ${negate ? '!==' : '==='} ${tested(b)}`;
		// Swift's comparisons do not associate: an operand that is one is parenthesized (`flag !== n > 0`).
		const K2 = ts.SyntaxKind;
		const compared = (x: ts.Expression) => (ts.isBinaryExpression(x) && x.operatorToken.kind >= K2.LessThanToken && x.operatorToken.kind <= K2.ExclamationEqualsEqualsToken ? `(${this.expr(x)})` : this.expr(x));
		// A string, number or boolean read converting undefined is compared as the undefined it is.
		const same = (x: ts.Expression, y: string) => (!this.library && ['String', 'Double', 'Bool'].includes(y) && lt.replace(/\?$/, '') === rt.replace(/\?$/, '') ? this.undefinedConverted(this.expr(x)) : null);
		const [ua, ub] = [same(a, lt), same(b, rt)];
		if (ua || ub) return isStringType(lt) ? `${negate ? '!' : ''}${RT.jsStringEquals}(${ua ?? this.expr(a)}, ${ub ?? this.expr(b)})` : `${ua ?? compared(a)} ${negate ? '!=' : '=='} ${ub ?? compared(b)}`;
		if (isStringType(lt)) return `${negate ? '!' : ''}${RT.jsStringEquals}(${this.expr(a)}, ${this.expr(b)})`;
		// Lenient code holds an undefined number as NaN: two variables or members holding undefined are equal. `x !== x` still tests for NaN.
		const held = (x: ts.Expression) => {
			x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
			return ts.isIdentifier(x) || ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x);
		};
		if (this.lenient && strict && lt === 'Double' && rt === 'Double' && held(a) && held(b) && a.getText() !== b.getText()) return `${negate ? '!' : ''}${RT.jsLenientNumberEquals}(${this.expr(a)}, ${this.expr(b)})`;
		return `${compared(a)} ${negate ? '!=' : '=='} ${compared(b)}`;
	},
};
