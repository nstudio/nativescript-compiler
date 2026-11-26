// Operators and literals as Kotlin: new, instanceof, typeof, binary, equality, object literals, key plans, signals.
import ts from 'typescript';
import { BUILTIN_CLASSES } from './library.ts';
import { ERRORS } from '../semantics/globals.ts';
import { branch, ident, isFunctionType, isNullable, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { asOperation, assignedValues } from '../semantics/lang.ts';
import { located, type Refusal, type RefusalId } from '../semantics/refusals.ts';
import { notedField } from '../semantics/shapes.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { assertedFrom, emptyComparison, scriptComparison } from '../semantics/placement.ts';
import { constClassExpr } from '../semantics/classes.ts';
import { isLibDeclaration } from '../semantics/ast.ts';
import { nullAs } from './expressions.ts';
import { bigIntArithmetic, bigIntCompare, bigIntPlan, type BigIntInfix } from '../semantics/apis/bigint.ts';
import { BIT_ASSIGNMENTS, addCall, bitOperation, concatOperand, numericThrowing, untypedBinary, untypedConversion } from '../semantics/apis/operators.ts';

/** BigInt's operations the backend spells as an operator. */
const BIGINT_INFIX: { readonly [Op in BigIntInfix]: string } = { add: '+', subtract: '-', multiply: '*', and: 'and', or: 'or', xor: 'xor' };

export const operatorsMethods = {
	binary(this: Translator, e: ts.BinaryExpression): string {
		const op = e.operatorToken.kind;
		const K = ts.SyntaxKind;
		const l = () => this.expr(e.left);
		const r = () => this.expr(e.right);
		const target = () => this.lvalue(e.left);
		const big = this.bigIntBinary(e);
		if (big) return big;
		const untyped = this.untypedOperation(e);
		const thrown = untypedBinary(this, untyped, e);
		if (thrown) return thrown;
		const bit = !BIT_ASSIGNMENTS[op] && bitOperation(op, RT);
		if (bit) return `${bit}(${this.toNumber(e.left)}, ${this.toNumber(e.right)})`;
		// A member written by key, or a record's entry (read back nullable): the operation's value, assigned as `=` assigns it.
		const keyed = (BIT_ASSIGNMENTS[op] || op === K.PercentEqualsToken || op === K.AsteriskAsteriskEqualsToken) && this.untypedPlace(e.left);
		const entry = op >= K.FirstCompoundAssignment && op <= K.LastCompoundAssignment && ![K.QuestionQuestionEqualsToken, K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken].includes(op) && ts.isElementAccessExpression(e.left) && isKit(spelledType(this.typeOf(e.left.expression).replace(/\?$/, '')), 'JSRecord');
		if (keyed || entry) {
			this.subst.set(
				e,
				this.entryRead(e.left, () => this.binary(asOperation(e))),
			);
			try {
				return this.assignment(e.left, e);
			} finally {
				this.subst.delete(e);
			}
		}
		if (untyped?.kind === 'numeric') {
			const p = this.untypedPlace(e.left);
			if (p) return `${RT.jsSet}(${p.obj}, ${p.key}, ${numericThrowing(this, untyped, `${RT.jsGet}(${p.obj}, ${p.key})`, e.right)})`;
			return `${target()} = ${numericThrowing(this, untyped, e.left, e.right)}`;
		}
		if (BIT_ASSIGNMENTS[op]) return `${target()} = ${bitOperation(op, RT)}(${this.toNumber(e.left)}, ${this.toNumber(e.right)})`;
		const heldNumber = () => this.heldNumber(e.left);
		switch (op) {
			case K.EqualsToken: {
				const assigned = this.assignment(e.left, e.right);
				const plain = /^(jsSet\(|\w+\.set\()/.test(assigned) || !assigned.includes(' = ');
				// A value the caller holds (`subst`, an assignment used as a value) is not read back: a getter would run.
				return ts.isExpressionStatement(e.parent) || (ts.isParenthesizedExpression(e.parent) && ts.isExpressionStatement(e.parent.parent)) || ts.isForStatement(e.parent) || plain || this.subst.has(e.right) ? assigned : `run { ${assigned}; ${target()} }`;
			}
			// An untyped variable holds whatever the operation gives: a string, or a number.
			case K.PlusEqualsToken: {
				const add = untyped?.kind === 'add' ? RT.jsAddThrowing : RT.jsAdd;
				if (this.untypedPlace(e.left)) {
					const p = this.untypedPlace(e.left)!;
					return `${RT.jsSet}(${p.obj}, ${p.key}, ${add}(${RT.jsGet}(${p.obj}, ${p.key}), ${this.coerce(e.right, 'Any?')}))`;
				}
				if (this.heldOptionalNumber(e.left)) return `${target()} = ${heldNumber()} + ${untyped ? untypedConversion(this, untyped, e.right) : this.toNumber(e.right)}`;
				if (this.isAny(e.left)) return `${target()} = ${add}(${l()}, ${this.coerce(e.right, 'Any?')})`;
				const added = () => (untyped?.kind === 'concat' ? concatOperand(this, e.right, untyped) : this.str(e.right));
				// A string that may be missing converts first: Kotlin's `+` on a null string writes "null" for undefined too.
				if (this.isString(e.left) && isNullable(this.declaredTypeOf(e.left) ?? this.typeOf(e.left))) return `${target()} = ${this.str(e.left)} + ${added()}`;
				return this.isString(e.left) ? `${target()} += ${added()}` : `${target()} += ${untyped ? untypedConversion(this, untyped, e.right) : this.toNumber(e.right)}`;
			}
			case K.MinusEqualsToken:
			case K.AsteriskEqualsToken:
			case K.SlashEqualsToken:
				if (this.heldOptionalNumber(e.left)) {
					return `${target()} = ${heldNumber()} ${({ [K.MinusEqualsToken]: '-', [K.AsteriskEqualsToken]: '*', [K.SlashEqualsToken]: '/' } as Record<number, string>)[op]} ${this.toNumber(e.right)}`;
				}
				if (this.untypedPlace(e.left)) {
					const p = this.untypedPlace(e.left)!;
					return `${RT.jsSet}(${p.obj}, ${p.key}, ${RT.jsToNumber}(${RT.jsGet}(${p.obj}, ${p.key})) ${({ [K.MinusEqualsToken]: '-', [K.AsteriskEqualsToken]: '*', [K.SlashEqualsToken]: '/' } as Record<number, string>)[op]} ${this.toNumber(e.right)})`;
				}
				if (op === K.MinusEqualsToken) return this.isAny(e.left) ? `${target()} = ${this.toNumber(e.left)} - ${this.toNumber(e.right)}` : `${target()} -= ${this.toNumber(e.right)}`;
				if (op === K.AsteriskEqualsToken) return this.isAny(e.left) ? `${target()} = ${this.toNumber(e.left)} * ${this.toNumber(e.right)}` : `${target()} *= ${this.toNumber(e.right)}`;
				if (op === K.SlashEqualsToken) return this.isAny(e.left) ? `${target()} = ${this.toNumber(e.left)} / ${this.toNumber(e.right)}` : `${target()} /= ${this.toNumber(e.right)}`;
			case K.PercentEqualsToken:
				if (this.isAny(e.left)) return `${target()} = ${this.toNumber(e.left)} % ${this.toNumber(e.right)}`;
				return this.heldOptionalNumber(e.left) ? `${target()} = ${this.undefinedAs(this.expr(e.left), 'Double')} % ${this.toNumber(e.right)}` : `${target()} %= ${this.toNumber(e.right)}`;
			case K.AsteriskAsteriskEqualsToken:
				return `${target()} = ${RT.jsPow}(${this.heldOptionalNumber(e.left) ? this.undefinedAs(this.expr(e.left), 'Double') : this.isAny(e.left) ? this.toNumber(e.left) : l()}, ${this.toNumber(e.right)})`;
			case K.QuestionQuestionEqualsToken:
				return `if (${RT.jsIsNullish}(${l()})) ${this.assignment(e.left, e.right)}`;
			case K.BarBarEqualsToken:
				return `if (!${RT.jsTruthy}(${l()})) ${this.assignment(e.left, e.right)}`;
			case K.AmpersandAmpersandEqualsToken:
				return `if (${RT.jsTruthy}(${l()})) ${this.assignment(e.left, e.right)}`;
			case K.PlusToken: {
				if (this.isString(e.left) || this.isString(e.right)) return `${concatOperand(this, e.left, untyped)} + ${concatOperand(this, e.right, untyped)}`;
				if (this.isAny(e.left) || this.isAny(e.right)) {
					const sum = addCall(this, e, untyped),
						t = this.typeOf(e);
					// An operand held untyped though TypeScript types it, and so the sum, a number or string.
					return isUntyped(spelledType(t)) ? sum : this.fromAnyCode(sum, t);
				}
				return `${this.toNumber(e.left)} + ${this.toNumber(e.right)}`;
			}
			case K.MinusToken:
				return `${this.toNumber(e.left)} - ${this.toNumber(e.right)}`;
			case K.AsteriskToken:
				return `${this.toNumber(e.left)} * ${this.toNumber(e.right)}`;
			case K.SlashToken:
				return `${this.toNumber(e.left)} / ${this.toNumber(e.right)}`;
			case K.PercentToken:
				return `${this.toNumber(e.left)} % ${this.toNumber(e.right)}`;
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
				if (this.isString(e.left) && this.isString(e.right)) return `${l()} ${sym} ${r()}`;
				// An untyped or object operand: compared as strings or as numbers by what it holds when the program runs.
				const dynamic = (x: ts.Expression) => {
					const t = this.typeOf(x);
					return isUntyped(spelledType(t)) || t === 'Any' || t === 'String?' || /^[A-Z]\??$/.test(t) || (this.isObjectType(t) && !/^JSDate\??$/.test(t));
				};
				if (dynamic(e.left) || dynamic(e.right)) {
					const fn = ({ [K.LessThanToken]: RT.jsLess, [K.GreaterThanToken]: RT.jsGreater, [K.LessThanEqualsToken]: RT.jsLessOrEqual, [K.GreaterThanEqualsToken]: RT.jsGreaterOrEqual } as Partial<Record<ts.SyntaxKind, string>>)[op];
					return `${fn}(${this.coerce(e.left, 'Any?')}, ${this.coerce(e.right, 'Any?')})`;
				}
				return `${this.toNumber(e.left)} ${sym} ${this.toNumber(e.right)}`;
			}
			case K.QuestionQuestionToken: {
				const t = this.typeOf(e);
				const maybe = this.maybeUndefined(e.left);
				if (maybe && isUntyped(spelledType(t))) return `${RT.jsNullishCoalesce}(${maybe}) { ${this.coerce(e.right, 'Any?')} }`;
				// An object the right operand may leave missing: required present by what reads the whole, not here.
				if (maybe && !this.library && this.isObjectRef(e) && !isNullable(t) && !isFunctionType(t)) {
					const right = this.coerce(e.right, t);
					return this.isAsserted(right) ? this.asserted(`(${maybe} ?: ${this.unasserted(right)})`) : `(${maybe} ?: ${right})`;
				}
				// TypeScript types `s ?? 1` as the string `s` is declared; a missing `s` gives the fallback as a string.
				if (maybe) return `(${maybe} ?: ${t === 'String' && this.typeOf(e.right) !== 'String' ? this.str(e.right) : this.coerce(e.right, t)})`;
				const member = ts.skipOuterExpressions(e.left, ts.OuterExpressionKinds.Parentheses);
				const untyped = t === this.typeOf(member) ? this.untypedMemberRead(member) : null;
				if (untyped) return `(${untyped} ?: ${this.coerce(e.right, t)})`;
				if (this.lenientMissingMember(member) && t === this.typeOf(member)) {
					this.nullOk.add(member);
					try {
						return `(${this.expr(member)} ?: ${this.coerce(e.right, t)})`;
					} finally {
						this.nullOk.delete(member);
					}
				}
				if (this.isAny(e.left)) {
					const code = `${RT.jsNullishCoalesce}(${l()}) { ${this.coerce(e.right, 'Any?')} }`;
					return (this.library || this.states.heldNullish(ts.skipOuterExpressions(e.left))) && !isUntyped(spelledType(t)) ? this.fromAnyCode(code, t, true) : code;
				}
				// A read converting undefined (a record's entry asserted its type): the fallback applies where it is undefined.
				const held = ['String', 'Double', 'Boolean'].includes(t) && this.typeOf(e.left) === t ? this.convertedOptional(e.left, t) : null;
				const left = held ?? l(),
					right = this.coerce(e.right, t);
				if (!this.library && this.isObjectRef(e) && !isNullable(t) && !isFunctionType(t) && this.isAsserted(right)) return this.asserted(`(${left} ?: ${this.unasserted(right)})`);
				return `(${left} ?: ${right})`;
			}
			case K.AmpersandAmpersandToken:
			case K.BarBarToken: {
				const sym = op === K.AmpersandAmpersandToken ? '&&' : '||';
				const assertedLeft = this.assertedUntyped(e.left);
				if (this.isBool(e.left) && this.isBool(e.right) && !assertedLeft) {
					const fixed = this.staticTruth(e);
					if (fixed !== undefined) return String(fixed);
					if (this.staticTruth(e.left) === (sym === '&&')) return r();
					if (this.staticTruth(e.right) === (sym === '&&') && this.pure(e.left)) return l();
					const left = l(),
						right = r();
					return left === right ? left : `${left} ${sym} ${right}`;
				}
				// JavaScript returns an operand, not a Boolean.
				// Library mode: a function `a && a.getItem` gives may be missing: nullable where a nullable variable takes it, as
				// where a `libraryNull` variable is assigned it.
				const holder = ts.isVariableDeclaration(e.parent) && e.parent.initializer === e && ts.isIdentifier(e.parent.name) ? e.parent.name : ts.isBinaryExpression(e.parent) && e.parent.operatorToken.kind === K.EqualsToken && e.parent.right === e && ts.isIdentifier(e.parent.left) && this.states.libraryNullVariable(e.parent.left)?.only ? e.parent.left : null;
				const declared = holder ? this.declaredTypeOf(holder) : null;
				const t = this.library && declared && isNullable(declared) && (isFunctionType(declared.replace(/^\((.*)\)\?$/, '$1')) || ['String?', 'Double?', 'Boolean?'].includes(declared)) ? declared : this.typeOf(e);
				const v = this.fresh('__v');
				// Library mode: a right operand declared nullable (a field left unset) is the result as its type reads undefined.
				const right = this.library && ['String', 'Double', 'Boolean'].includes(t) && this.declaredTypeOf(e.right) === optionalType(t) ? this.undefinedAs(this.expr(e.right), t) : this.coerce(e.right, t);
				const leftType = this.typeOf(e.left);
				// A nullable declaration read as its non-null type: present when truthy, else the type's undefined.
				const nullableLeft = (!!assertedLeft || ((ts.isIdentifier(e.left) || ts.isPropertyAccessExpression(e.left)) && this.declaredTypeOf(e.left) === optionalType(leftType))) && leftType !== optionalType(leftType);
				let leftValue = leftType === t || isUntyped(spelledType(t)) ? v : leftType === optionalType(t) ? this.unwrapped(v) : isUntyped(spelledType(leftType)) ? (this.library ? this.fromAnyCode(v, t, true) : this.fromAny(v, t)) : t === 'Boolean' ? `${RT.jsTruthy}(${v})` : v;
				const left = this.maybeUndefined(e.left) ?? l();
				// `a && a.get()` with an object `a`: undefined when it is missing.
				// Tested for truth (`a && b && b.c`, `if (a && b)`): the missing value as it is.
				let at: ts.Node = e.parent;
				while (ts.isParenthesizedExpression(at)) at = at.parent;
				const tested = (ts.isBinaryExpression(at) && [K.AmpersandAmpersandToken, K.BarBarToken].includes(at.operatorToken.kind) && ts.skipOuterExpressions(at.left) === e) || ((ts.isIfStatement(at) || ts.isConditionalExpression(at)) && ts.skipOuterExpressions(ts.isIfStatement(at) ? at.expression : at.condition) === e) || (ts.isPrefixUnaryExpression(at) && at.operator === K.ExclamationToken);
				if (op === K.AmpersandAmpersandToken && leftValue === v && this.isObjectType(leftType) && leftType.replace(/\?$/, '') !== t.replace(/\?$/, '') && !isUntyped(spelledType(t)) && t !== 'Boolean') {
					return isNullable(t) || tested ? `(if (${RT.jsTruthy}(${left})) ${right} else null)` : this.asserted(`(if (${RT.jsTruthy}(${left})) ${right} else null)`);
				}
				// `flag && (() => …)` of a flag TypeScript types `true | undefined`: the function, else undefined (the result's type has no `false`).
				if (!this.library && op === K.AmpersandAmpersandToken && leftValue === v && /^Boolean\??$/.test(leftType) && isNullable(t) && isFunctionType(t.replace(/^\((.*)\)\?$/, '$1'))) return `(if (${RT.jsTruthy}(${left})) ${branch(right)} else null)`;
				// Library mode: `s && s.match(re)` of a string `s`: the object, else none (a falsy string is no match).
				if (this.library && op === K.AmpersandAmpersandToken && leftValue === v && ['String', 'Double', 'Boolean'].includes(leftType) && this.isObjectType(t.replace(/\?$/, '')) && !['String', 'Double', 'Boolean'].includes(t.replace(/\?$/, ''))) {
					return isNullable(t) || tested ? `(if (${RT.jsTruthy}(${left})) ${right} else null)` : this.asserted(`(if (${RT.jsTruthy}(${left})) ${right} else null)`);
				}
				if (nullableLeft && leftValue === v && !isUntyped(spelledType(t))) leftValue = op === K.BarBarToken ? this.unwrapped(v) : this.undefinedAs(v, t);
				// A truthy left operand is present, whatever Kotlin types its read (`a?.b`, a record's value).
				if (op === K.BarBarToken && leftValue === v && !isNullable(t) && !isUntyped(spelledType(t))) leftValue = this.unwrapped(v);
				// `done && subscriber.complete()` as a value: the falsy left operand, else undefined.
				if (op === K.AmpersandAmpersandToken && !ts.isExpressionStatement(at) && this.typeOf(e.right) === 'Unit' && t !== 'Unit' && leftType.replace(/\?$/, '') === t.replace(/\?$/, '')) return `${RT.jsAnd}<${optionalType(t)}>(${left}) { ${this.expr(e.right)}; null }`;
				if (leftValue === v) return `${op === K.BarBarToken ? RT.jsOr : RT.jsAnd}(${left}) { ${right} }`;
				// A boolean of a value's truth: the truth itself, as the operator gives it.
				if (leftValue === `${RT.jsTruthy}(${v})` && t === 'Boolean') return `(${RT.jsTruthy}(${left}) ${sym} ${right})`;
				// jsTruthy's contract makes the tested value non-null where it holds.
				const chosen = op === K.BarBarToken ? `run { val ${v} = ${left}; if (${RT.jsTruthy}(${v})) ${leftValue === `${v}!!` ? v : leftValue} else ${branch(right)} }` : `run { val ${v} = ${left}; if (${RT.jsTruthy}(${v})) ${branch(right)} else ${leftValue} }`;
				// A right operand held nullable gives its undefined, which a use wanting the type's value reads as undefined reads.
				const heldRight = !this.library && !tested && ['String', 'Double', 'Boolean'].includes(t) && this.declaredTypeOf(e.right) === optionalType(t) && !this.nullTolerant(e);
				return heldRight ? this.undefinedAs(chosen, t) : chosen;
			}
			case K.InstanceOfKeyword: {
				const rhsExpr = constClassExpr(e.right, this.checker);
				if (rhsExpr) return `(${this.observed(e.left)} is ${this.emitClassExprCode(rhsExpr)})`;
				// A class held as a value (`C: ErrorConstructor`): tested by the class it holds.
				const libraryClass = ts.isIdentifier(e.right) && isLibDeclaration(this.resolve(e.right)?.declarations?.[0]);
				if (!libraryClass && this.typeOf(e.right).replace(/\?$/, '').startsWith('Class<')) return `${this.expr(e.right)}.isInstance(${this.coerce(e.left, 'Any?')})`;
				const name = e.right.getText();
				// A compiled program makes no String, Number or Boolean wrapper objects.
				if (['String', 'Number', 'Boolean'].includes(name) && isLibDeclaration(this.resolve(e.right)?.declarations?.[0])) {
					const left = this.coerce(e.left, 'Any?');
					return this.marks.isPure(left) ? 'false' : `run { ${left}; false }`;
				}
				// The library's classes: the runtime's type of any of their instances (a promise of any result).
				const builtin = BUILTIN_CLASSES[name];
				if (builtin && isLibDeclaration(this.resolve(e.right)?.declarations?.[0])) return `(${this.observed(e.left)} is ${builtin})`;
				// Library mode: an untyped parameter tested as it is, as a cast here would narrow it in Kotlin past the test.
				const param = ts.isIdentifier(e.left) ? this.resolve(e.left)?.valueDeclaration : undefined;
				let left = this.library && param && ts.isParameter(param) && this.typeTested(param) ? ident((e.left as ts.Identifier).text) : this.observed(e.left);
				// An untyped value read as the class its type names passes for one whatever it holds: the value itself is tested.
				const cast = this.marks.markOf(left);
				if (cast?.op === 'cast' && cast.unchecked) left = ts.isIdentifier(e.left) ? this.refName(e.left) : cast.to.args.length || cast.optional || cast.to.kind === 'function' ? left : cast.of.code;
				// Library mode: a class the program declares, by its Kotlin name; a class held in a value, tested when the program runs.
				const cls = this.library && !ERRORS[name] ? this.resolve(e.right)?.valueDeclaration : undefined;
				if (cls && ts.isClassDeclaration(cls) && !cls.getSourceFile().isDeclarationFile) return this.decidedInstanceOf(e) ? `${RT.jsIs}<${this.className(cls)}>(${left})` : `(${left} is ${this.className(cls)})`;
				const rightSym = this.resolve(ts.isPropertyAccessExpression(e.right) ? e.right.name : e.right);
				// A generic class is tested whatever its type arguments: `is Box<*>`.
				const generic = rightSym?.valueDeclaration && ts.isClassDeclaration(rightSym.valueDeclaration) ? (rightSym.valueDeclaration.typeParameters?.length ?? 0) : 0;
				const tested =
					ERRORS[name] ??
					this.typeOf(e.right)
						.replace(/^typeof /, '')
						.replace(/\?$/, '')
						.replace(/<>$/, generic ? `<${Array(generic).fill('*').join(', ')}>` : '');
				if (this.library && (tested === 'Any' || !tested) && !(rightSym && (rightSym.flags & ts.SymbolFlags.Class || isLibDeclaration(rightSym.declarations?.[0])))) {
					const alias = ts.isIdentifier(e.right) ? this.native?.identifier(e.right) : null;
					return `${RT.jsInstanceOf}(${this.coerce(e.left, 'Any?')}, ${alias ?? this.coerce(e.right, 'Any?')})`;
				}
				// A view of an object (`T.jsView`) is its root's instance; a narrowed read of it casts the root (`jsCastPresent`).
				const lt = this.typeOf(e.left).replace(/\?$/, '');
				if (!this.library && (lt === 'Any' || this.viewed.has(lt) || this.isShapeType(lt)) && !this.decidedInstanceOf(e)) return `${RT.jsIs}<${tested ?? name}>(${RT.jsIdentity}(${left}))`;
				return this.decidedInstanceOf(e) ? `${RT.jsIs}<${tested ?? name}>(${left})` : `(${left} is ${tested ?? name})`;
			}
			case K.CommaToken:
				return `run { ${this.exprStatement(e.left)}; ${r()} }`;
			case K.InKeyword:
				return `${RT.jsHasKey}(${this.coerce(e.right, 'Any?')}, ${this.propertyKey(e.left)})`;
		}
		throw this.error(e, `operator ${ts.tokenToString(op)}`);
	},

	/** An operator on BigInts (both sides, or a comparison with a number). */
	/** A `heldOptionalNumber` read as an arithmetic operand: NaN where undefined, 0 where null. */
	heldNumber(this: Translator, e: ts.Expression): string {
		const empty = this.states.heldNumberNil(e, () => this.expr(e));
		return 'keyed' in empty ? `${RT.jsToNumber}(${empty.keyed})` : empty.isNull ? nullAs(this.expr(e), 'Double') : this.undefinedAs(this.expr(e), 'Double');
	},

	/** `++`/`--` of a `heldOptionalNumber` used as a value: the old number (postfix) or the new one. */
	heldNumberStep(this: Translator, e: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): string | null {
		if (!this.heldOptionalNumber(e.operand)) return null;
		const sign = e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-',
			v = this.fresh('__old'),
			t = this.lvalue(e.operand);
		return ts.isPostfixUnaryExpression(e) ? `run { val ${v} = ${this.heldNumber(e.operand)}; ${t} = ${v} ${sign} 1.0; ${v} }` : `run { val ${v} = ${this.heldNumber(e.operand)} ${sign} 1.0; ${t} = ${v}; ${v} }`;
	},

	bigIntBinary(this: Translator, e: ts.BinaryExpression): string | null {
		const plan = bigIntPlan(e.operatorToken.kind, this.typeOf(e.left) === 'JSBigInt', this.typeOf(e.right) === 'JSBigInt');
		if (!plan) return null;
		const l = () => this.expr(e.left),
			r = () => this.expr(e.right);
		if (plan.kind === 'arithmetic') return `${plan.assigns ? `${this.lvalue(e.left)} = ` : ''}${bigIntArithmetic(plan.op, l(), r(), RT, BIGINT_INFIX)}`;
		if (!plan.big) return `(${l()} ${plan.operator} ${r()})`;
		const left = plan.big === 'left';
		return `(${bigIntCompare(left ? l() : r(), this.toNumber(left ? e.right : e.left), RT)}?.let { ${left ? 'it' : '-it'} ${plan.operator} 0 } ?: false)`;
	},

	equality(this: Translator, e: ts.BinaryExpression): string {
		const K = ts.SyntaxKind;
		const op = e.operatorToken.kind;
		const negate = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
		const strict = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken;
		const isNullish = (x: ts.Expression) => x.kind === K.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		const [a, b] = [e.left, e.right];
		const lt = this.typeOf(a);
		const rt = this.typeOf(b);
		// A `T | null` value compared strictly with undefined, or a `T | undefined` one with null: never the same.
		const empty = emptyComparison(this.placement, e);
		if (empty?.cell === 'stored') return `${negate ? '!' : ''}${empty.strict ? `${RT.jsStrictEquals}(${this.expr(empty.x)}, ${empty.isNull ? 'jsNull' : 'null'})` : `${RT.jsIsNullish}(${this.expr(empty.x)})`}`;
		if (empty?.cell === 'empty') return `${negate ? '!' : ''}${RT.jsStrictEquals}(${this.observe(empty.x)}, ${empty.isNull ? 'jsNull' : 'null'})`;
		// An element held as `JSNullish<T>`: loosely, its null and its undefined are both empty.
		const slot = isNullish(b) ? a : isNullish(a) ? b : null;
		if (slot && !strict && this.states.nullishElementRead(slot)) return `${negate ? '!' : ''}${RT.jsIsNullish}(${RT.jsBox}(${this.maybeUndefined(slot) ?? this.expr(slot)}))`;
		const maybe = isNullish(b) ? this.maybeUndefined(a) : isNullish(a) ? this.maybeUndefined(b) : null;
		if (maybe) {
			// An untyped value holds null as `jsNull`, apart from undefined's null.
			if (isUntyped(spelledType(isNullish(b) ? lt : rt)) && (!strict || (isNullish(b) ? b : a).kind === K.NullKeyword)) return `${negate ? '!' : ''}${strict ? `${RT.jsStrictEquals}(${maybe}, ${this.observe(isNullish(b) ? b : a)})` : `${RT.jsIsNullish}(${maybe})`}`;
			return `${maybe} ${negate ? '!=' : '=='} null`;
		}
		// A noted string, number or boolean field stores its zero: its null or undefined is read by name.
		const zeroNoted = (x: ts.Expression) => notedField(this.states, x) && ['String', 'Double', 'Boolean'].includes(this.typeOf(x));
		const noted = isNullish(b) && zeroNoted(a) ? [a, b] : isNullish(a) && zeroNoted(b) ? [b, a] : null;
		if (noted) return `${negate ? '!' : ''}${strict ? `${RT.jsStrictEquals}(${this.coerce(noted[0], 'Any?')}, ${this.observe(noted[1])})` : `${RT.jsIsNullish}(${this.coerce(noted[0], 'Any?')})`}`;
		// A value its type calls present that script may still leave out (a field core never set): tested as it is.
		const absent = (x: ts.Expression, t: string) => {
			const code = this.expr(x);
			const cast = this.marks.markOf(code);
			const unchecked = cast?.op === 'cast' && !!cast.unchecked && !cast.optional;
			const present = (!isNullable(t) && !isFunctionType(t) && !isNullable(this.declaredTypeOf(x) ?? t)) || unchecked;
			return present ? `${negate ? '!' : ''}${RT.jsIsNullish}(${code})` : `${code} ${negate ? '!=' : '=='} null`;
		};
		if (isNullish(b) && !isUntyped(spelledType(lt))) return absent(a, lt);
		if (isNullish(a) && !isUntyped(spelledType(rt))) return absent(b, rt);
		const script = scriptComparison(this.placement, e, (_, t) => /^[A-Z]\??$/.test(t));
		if (script?.cell === 'nullish') return `${negate ? '!' : ''}${RT.jsIsNullish}(${this.observe(script.x)})`;
		if (script) return `${negate ? '!' : ''}${strict ? RT.jsStrictEquals : RT.jsLooseEquals}(${this.observe(assertedFrom(this.placement, a) ?? a)}, ${this.observe(assertedFrom(this.placement, b) ?? b)})`;
		// A function reference (`::fn`) is made where it is read, equal to every other of its function: compared by equality.
		const fnType = (t: string) => isFunctionType(t.replace(/^\((.*)\)\?$/, '$1'));
		if (this.isObjectRef(a) && this.isObjectRef(b) && !fnType(lt) && !fnType(rt)) return `${this.observe(a, 'asIs')} ${negate ? '!==' : '==='} ${this.observe(b, 'asIs')}`;
		// An adaptation (`JSAdapted`) is its original either way round, which `==` on the original does not see.
		if (fnType(lt) || fnType(rt)) return `${negate ? '!' : ''}${RT.jsStrictEquals}(${this.expr(a)}, ${this.expr(b)})`;
		// A string, number or boolean read converting undefined is compared as the undefined it is.
		const same = (x: ts.Expression, y: string) => (!this.library && ['String', 'Double', 'Boolean'].includes(y) && lt.replace(/\?$/, '') === rt.replace(/\?$/, '') ? this.undefinedConverted(this.expr(x)) : null);
		return `${same(a, lt) ?? this.expr(a)} ${negate ? '!=' : '=='} ${same(b, rt) ?? this.expr(b)}`;
	},

	/**
	 * A field declared a read-only `Signal<T>` that its class gives a signal (`this.morning = s.morning`): that signal's
	 * type, which a non-strict app's declared type may not say is nullable.
	 */
	heldSignal(this: Translator, n: ts.Node): string | null {
		if (this.library) return null;
		const named = ts.isPropertyAccessExpression(n) || ts.isPropertyDeclaration(n) ? n.name : n;
		const d = ts.isIdentifier(named) || ts.isPrivateIdentifier(named) ? this.checker.getSymbolAtLocation(named)?.valueDeclaration : undefined;
		if (!d || !ts.isPropertyDeclaration(d) || !d.type || !ts.isTypeReferenceNode(d.type) || this.framework.signalKind(d.type.typeName.getText()) !== 'computed' || this.heldSignalVisits.has(d)) return null;
		this.heldSignalVisits.add(d);
		try {
			for (const v of assignedValues(d)) {
				const t = this.typeOf(v);
				if (t.startsWith('Signal<')) return t;
			}
			return null;
		} finally {
			this.heldSignalVisits.delete(d);
		}
	},

	/** Whether a `Signal<T>` node is lowered as a Kotlin property reading its value (`val x: T get() = …`) rather than a `Signal<T>`. */
	isComputedProperty(this: Translator, n: ts.Node): boolean {
		if (this.library) return false;
		const decl = ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isPrivateIdentifier(n) ? this.resolve(n)?.valueDeclaration : n;
		if (!decl) return false;
		if (this.framework.memoized(decl, this.checker)) return true;
		if (!ts.isPropertyDeclaration(decl) || !ts.isClassLike(decl.parent) || !decl.initializer) return false;
		const init = decl.initializer,
			callee = this.calleeName(init);
		if (this.framework.heldSignal(callee) || /\.asReadonly$/.test(callee)) return true;
		return this.signalAlias(decl);
	},

	/** A read-only signal's current value. */
	signalValue(this: Translator, e: ts.Expression): string {
		return this.isComputedProperty(e) ? this.expr(e) : `${this.expr(e)}.value`;
	},

	/** A field initialized with another read-only signal (`dayColor = ink`, a module's memo): a property reading through it. */
	signalAlias(this: Translator, m: ts.PropertyDeclaration): boolean {
		return !this.library && !!m.initializer && (ts.isIdentifier(m.initializer) || ts.isPropertyAccessExpression(m.initializer)) && this.framework.signalKind(this.symbolName(m.initializer)) === 'computed';
	},

	/** An error the translation of `n` failed with, at `n` unless it says where already (semantics/refusals.ts). */
	located(this: Translator, e: unknown, n: ts.Node): unknown {
		return located(e, n, (at, what, id) => this.error(at, what, id));
	},

	error(this: Translator, n: ts.Node | undefined, what: string, id: RefusalId = 'unhandled'): Refusal {
		if (!n) return this.config.refusals.refusal(`${what} is not supported in a release build yet`, id);
		const sf = n.getSourceFile();
		const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart());
		return this.config.refusals.refusedAt(sf.fileName, line + 1, character + 1, what, n.getText().slice(0, 80), id);
	},
};
