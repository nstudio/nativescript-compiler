// JavaScript's bitwise and shift operators on numbers, which both kits implement as functions (ToInt32 of each operand,
// ToUint32 for `>>>`'s left), and the compound assignments of each.
import ts from 'typescript';
import type { RuntimeColumn, SharedOp } from '../runtime.ts';
import { isObjectInstanceTest, resolveSymbol } from '../ast.ts';

const K = ts.SyntaxKind;

export const BIT_OPERATORS: Readonly<Partial<Record<ts.SyntaxKind, SharedOp>>> = {
	[K.AmpersandToken]: 'jsBitAnd',
	[K.BarToken]: 'jsBitOr',
	[K.CaretToken]: 'jsBitXor',
	[K.LessThanLessThanToken]: 'jsShiftLeft',
	[K.GreaterThanGreaterThanToken]: 'jsShiftRight',
	[K.GreaterThanGreaterThanGreaterThanToken]: 'jsShiftRightUnsigned',
};

/** A compound bitwise assignment's operator (`a |= b`: `|`). */
export const BIT_ASSIGNMENTS: Readonly<Partial<Record<ts.SyntaxKind, ts.SyntaxKind>>> = {
	[K.AmpersandEqualsToken]: K.AmpersandToken,
	[K.BarEqualsToken]: K.BarToken,
	[K.CaretEqualsToken]: K.CaretToken,
	[K.LessThanLessThanEqualsToken]: K.LessThanLessThanToken,
	[K.GreaterThanGreaterThanEqualsToken]: K.GreaterThanGreaterThanToken,
	[K.GreaterThanGreaterThanGreaterThanEqualsToken]: K.GreaterThanGreaterThanGreaterThanToken,
};

/** The runtime function of the bitwise operator `op` (or of the operator a compound assignment `op` applies), in `column`. */
export function bitOperation(op: ts.SyntaxKind | undefined, column: { readonly [Op in SharedOp]: string }): string | undefined {
	const kind = op !== undefined ? (BIT_ASSIGNMENTS[op] ?? op) : undefined;
	const fn = kind !== undefined ? BIT_OPERATORS[kind] : undefined;
	return fn && column[fn];
}

/** A numeric or bitwise operator on operands of which one is held untyped. */
export type NumericOp = 'subtract' | 'multiply' | 'divide' | 'remainder' | 'exponent' | 'and' | 'or' | 'xor' | 'shiftLeft' | 'shiftRight' | 'shiftRightUnsigned';

/** The kits' throwing function of each `NumericOp`: ToNumeric of both operands, a TypeError for a BigInt beside a number. */
const NUMERIC_THROWING: { readonly [Op in NumericOp]: SharedOp } = {
	subtract: 'jsSubtractThrowing',
	multiply: 'jsMultiplyThrowing',
	divide: 'jsDivideThrowing',
	remainder: 'jsRemainderThrowing',
	exponent: 'jsExponentThrowing',
	and: 'jsBitAndThrowing',
	or: 'jsBitOrThrowing',
	xor: 'jsBitXorThrowing',
	shiftLeft: 'jsShiftLeftThrowing',
	shiftRight: 'jsShiftRightThrowing',
	shiftRightUnsigned: 'jsShiftRightUnsignedThrowing',
};

/** `NUMERIC_THROWING`'s functions giving the value untyped: two BigInts give a BigInt (`>>>` a TypeError). */
const NUMERIC_UNTYPED: { readonly [Op in NumericOp]: SharedOp } = {
	subtract: 'jsSubtractUntypedThrowing',
	multiply: 'jsMultiplyUntypedThrowing',
	divide: 'jsDivideUntypedThrowing',
	remainder: 'jsRemainderUntypedThrowing',
	exponent: 'jsExponentUntypedThrowing',
	and: 'jsBitAndUntypedThrowing',
	or: 'jsBitOrUntypedThrowing',
	xor: 'jsBitXorUntypedThrowing',
	shiftLeft: 'jsShiftLeftUntypedThrowing',
	shiftRight: 'jsShiftRightUntypedThrowing',
	shiftRightUnsigned: 'jsShiftRightUnsignedUntypedThrowing',
};

/**
 * What an operator does to an operand whose conversion can throw (`conversionThrows`: one held untyped, a BigInt beside
 * a number, a Symbol, an object's own `[Symbol.toPrimitive]`, `valueOf` or `toString` that throws). Both kits give each
 * as a throwing function (`…Throwing`) used at these sites only; any other operand keeps the kits' plain conversions.
 */
export type UntypedOperation =
	/** `a + b`, or `a += b` of an untyped `a`, neither a string: `jsAddThrowing`. */
	| { readonly kind: 'add'; readonly assigns: boolean }
	/** `a + b`, `a += b` beside a string: each untyped operand by `jsToStringDefaultThrowing`. */
	| { readonly kind: 'concat'; readonly assigns: boolean }
	/**
	 * `NUMERIC_THROWING`'s function; `held`: whether each operand goes as it is held (untyped, or a BigInt), not as its
	 * number. `untyped`: the value is held untyped (`untypedArithmetic`, or assigned to a place held untyped), so two
	 * BigInts give a BigInt (`NUMERIC_UNTYPED`); elsewhere it is the number TypeScript types it, of two BigInts their
	 * numbers'.
	 */
	| { readonly kind: 'numeric'; readonly op: NumericOp; readonly assigns: boolean; readonly held: readonly [boolean, boolean]; readonly untyped: boolean }
	/** Unary `+`: `jsToNumberThrowing`. */
	| { readonly kind: 'toNumber' }
	/** Unary `-` and `~`: `jsToNumericThrowing`, a BigInt as its number. */
	| { readonly kind: 'toNumeric'; readonly op: 'negate' | 'bitNot' }
	/** `a += b`'s b beside a typed number `a`: `jsNumberAddendThrowing`, a BigInt a TypeError. */
	| { readonly kind: 'addend' }
	/** A template literal's substitution: `jsToStringThrowing`. */
	| { readonly kind: 'template' }
	/** `<`, `>`, `<=`, `>=`: `RELATIONAL_THROWING`'s function, ToPrimitive (number) of the left operand first. */
	| { readonly kind: 'compare'; readonly op: RelationalOp }
	/** The library's `String(x)`: `jsStringThrowing`, a Symbol its description. */
	| { readonly kind: 'string' }
	/** The library's `Number(x)`: `jsToNumericThrowing`, a BigInt as its number. */
	| { readonly kind: 'number' };

type RelationalOp = '<' | '>' | '<=' | '>=';

const RELATIONAL: Partial<Record<ts.SyntaxKind, RelationalOp>> = { [K.LessThanToken]: '<', [K.GreaterThanToken]: '>', [K.LessThanEqualsToken]: '<=', [K.GreaterThanEqualsToken]: '>=' };

const RELATIONAL_THROWING: { readonly [Op in RelationalOp]: SharedOp } = { '<': 'jsLessThrowing', '>': 'jsGreaterThrowing', '<=': 'jsLessOrEqualThrowing', '>=': 'jsGreaterOrEqualThrowing' };

const NUMERIC: Partial<Record<ts.SyntaxKind, [NumericOp, boolean]>> = {
	[K.MinusToken]: ['subtract', false],
	[K.AsteriskToken]: ['multiply', false],
	[K.SlashToken]: ['divide', false],
	[K.PercentToken]: ['remainder', false],
	[K.AsteriskAsteriskToken]: ['exponent', false],
	[K.AmpersandToken]: ['and', false],
	[K.BarToken]: ['or', false],
	[K.CaretToken]: ['xor', false],
	[K.LessThanLessThanToken]: ['shiftLeft', false],
	[K.GreaterThanGreaterThanToken]: ['shiftRight', false],
	[K.GreaterThanGreaterThanGreaterThanToken]: ['shiftRightUnsigned', false],
	[K.MinusEqualsToken]: ['subtract', true],
	[K.AsteriskEqualsToken]: ['multiply', true],
	[K.SlashEqualsToken]: ['divide', true],
	[K.PercentEqualsToken]: ['remainder', true],
	[K.AsteriskAsteriskEqualsToken]: ['exponent', true],
	[K.AmpersandEqualsToken]: ['and', true],
	[K.BarEqualsToken]: ['or', true],
	[K.CaretEqualsToken]: ['xor', true],
	[K.LessThanLessThanEqualsToken]: ['shiftLeft', true],
	[K.GreaterThanGreaterThanEqualsToken]: ['shiftRight', true],
	[K.GreaterThanGreaterThanGreaterThanEqualsToken]: ['shiftRightUnsigned', true],
};

/** The TypeScript types whose values convert without running code or throwing. */
const PLAIN_CONVERSION = ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.EnumLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never;

/** Whether every value of `type` converts to a primitive without running code or throwing. */
export function convertsPlainly(type: ts.Type): boolean {
	return (type.isUnion() ? type.types : [type]).every((t) => !!(t.flags & PLAIN_CONVERSION));
}

/**
 * Whether an operand converts by what can throw. One held untyped (`held`): its TypeScript type where it is read admits
 * a BigInt, a Symbol or an object (any, unknown, a type parameter…); a `let` without a type that TypeScript narrows to a
 * number where it is read (`let h; h = 0; h /= 6` under noImplicitAny) converts plainly, and a variable arithmetic of
 * untyped operands initializes (`heldArithmetic`) does not, as it may hold a BigInt. A typed one: where its own
 * conversion can throw (`typed`: `Throws.objectConversionThrows`).
 */
export function conversionThrows(checker: ts.TypeChecker, n: ts.Node, held: (n: ts.Node) => boolean, typed: (n: ts.Node) => boolean): boolean {
	if (!convertsPlainly(checker.getTypeAtLocation(n))) return held(n) || typed(n);
	return heldArithmetic(checker, n, { held, string: (x) => !!(checker.getTypeAtLocation(x).flags & ts.TypeFlags.StringLike), big: (x) => !!(checker.getTypeAtLocation(x).flags & ts.TypeFlags.BigIntLike) });
}

/**
 * Whether the operator `n` converts an operand by what can throw (`untyped`: `conversionThrows`), so that it can throw
 * (`UntypedOperation`); so does the library's `String(x)` or `Number(x)` (`libCall`: `n` calls it, `conversionCall`).
 */
export function convertsUntyped(n: ts.Node, untyped: (n: ts.Node) => boolean, libCall: (n: ts.CallExpression) => ConversionCall | null): boolean {
	if (ts.isBinaryExpression(n)) {
		const op = n.operatorToken.kind;
		return (op === K.PlusToken || op === K.PlusEqualsToken || !!NUMERIC[op] || !!RELATIONAL[op]) && (untyped(n.left) || untyped(n.right));
	}
	if (ts.isCallExpression(n)) {
		const call = n.arguments.length > 0 && !ts.isSpreadElement(n.arguments[0]!) ? libCall(n) : null;
		return call === 'throws' || (call === 'converts' && untyped(n.arguments[0]!));
	}
	if (ts.isPrefixUnaryExpression(n)) return (n.operator === K.PlusToken || n.operator === K.MinusToken || n.operator === K.TildeToken) && untyped(n.operand);
	if (ts.isTemplateSpan(n)) return !ts.isTaggedTemplateExpression(n.parent.parent) && untyped(n.expression);
	return false;
}

/**
 * Whether `e`, a numeric or bitwise operator whose operands are each held untyped or a BigInt (one at least untyped),
 * is held untyped where its value is used as script holds any value: given where TypeScript takes any value, to
 * `typeof`, a template or `+` beside a string or an untyped value, as an operand of another such operator, assigned
 * to a place held untyped, or initializing a variable declared without a type (`arithmeticVariable`). Two BigInts then
 * give a BigInt; anywhere else its value is used as a number, and it is held as one.
 */
export function untypedArithmetic(checker: ts.TypeChecker, e: ts.Node, types: Pick<OperandTypes, 'held' | 'big' | 'string'>): boolean {
	if (!numericOperation(e) || !operandsHeld(e as ts.BinaryExpression, types) || bothBig(e as ts.BinaryExpression, types)) return false;
	let x: ts.Node = e;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	if (ts.isTypeOfExpression(p) || ts.isTemplateSpan(p)) return true;
	if (ts.isBinaryExpression(p)) {
		const other = p.left === x ? p.right : p.left;
		const op = p.operatorToken.kind;
		if (op === K.PlusToken) return heldOperand(other, types) || (!numericOperation(ts.skipOuterExpressions(other, ts.OuterExpressionKinds.Parentheses)) && types.string(other));
		if (numericOperation(p)) return heldOperand(other, types);
		if (op === K.EqualsToken && p.right === x) return types.held(p.left);
		return false;
	}
	if (ts.isVariableDeclaration(p) && p.initializer === x && !p.type && ts.isIdentifier(p.name)) return true;
	const context = checker.getContextualType(x as ts.Expression);
	return !!context && !!(context.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/**
 * The declaration of a variable `n` names (or is) that has no type and is initialized by arithmetic: held untyped where
 * `untypedArithmetic` holds its initializer so, every read of it then reading what it holds (a BigInt where TypeScript
 * types a number).
 */
export function arithmeticVariable(n: ts.Node, resolve: (n: ts.Node) => ts.Symbol | undefined): (ts.VariableDeclaration & { initializer: ts.Expression }) | null {
	const d = ts.isVariableDeclaration(n) ? n : ts.isIdentifier(n) ? (n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent : resolve(n)?.valueDeclaration) : undefined;
	if (!d || !ts.isVariableDeclaration(d) || d.type || !ts.isIdentifier(d.name) || !d.initializer) return null;
	return numericOperation(ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses)) ? (d as ts.VariableDeclaration & { initializer: ts.Expression }) : null;
}

const arithmeticPending = new WeakSet<ts.VariableDeclaration>();

/** Whether `n` reads or declares a variable `arithmeticVariable` holds untyped, as `untypedArithmetic` holds its initializer. */
export function heldArithmetic(checker: ts.TypeChecker, n: ts.Node, types: Pick<OperandTypes, 'held' | 'big' | 'string'>): boolean {
	const d = arithmeticVariable(n, (x) => resolveSymbol(x, checker));
	// A variable its own initializer reads is no number TypeScript knows of: it is held as TypeScript types it.
	if (!d || arithmeticPending.has(d)) return false;
	arithmeticPending.add(d);
	try {
		return untypedArithmetic(checker, ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses), types);
	} finally {
		arithmeticPending.delete(d);
	}
}

/** Two BigInts by their types: TypeScript types the operation a BigInt, which the kits give as one. */
function bothBig(e: ts.BinaryExpression, types: Pick<OperandTypes, 'big'>): boolean {
	return types.big(e.left) && types.big(e.right);
}

/** A numeric or bitwise operator, not a compound assignment. */
function numericOperation(e: ts.Node): boolean {
	return ts.isBinaryExpression(e) && NUMERIC[e.operatorToken.kind]?.[1] === false;
}

function operandsHeld(e: ts.BinaryExpression, types: Pick<OperandTypes, 'held' | 'big'>): boolean {
	return heldOperand(e.left, types) && heldOperand(e.right, types);
}

/** An operand held untyped or a BigInt; a numeric operator's, by its own operands, so that two operators of one expression never ask each other. */
function heldOperand(e: ts.Expression, types: Pick<OperandTypes, 'held' | 'big'>): boolean {
	const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	return numericOperation(x) ? operandsHeld(x as ts.BinaryExpression, types) : types.held(x) || types.big(x);
}

/** `conversionCall`: `converts` its argument as an operator does; `throws` whatever it holds (`Number` of a Symbol). */
export type ConversionCall = 'converts' | 'throws';

/** A call of the library's global `String` or `Number` (not a program's own of that name); null for any other call. */
export function conversionCall(e: ts.CallExpression, checker: ts.TypeChecker): ConversionCall | null {
	if (!ts.isIdentifier(e.expression) || (e.expression.text !== 'String' && e.expression.text !== 'Number')) return null;
	const decl = checker.getSymbolAtLocation(e.expression)?.declarations?.[0];
	if (decl && !decl.getSourceFile().isDeclarationFile) return null;
	const arg = e.arguments[0];
	const symbol = (t: ts.Type) => !!(t.flags & ts.TypeFlags.ESSymbolLike);
	if (e.expression.text === 'Number' && arg) {
		const t = checker.getTypeAtLocation(arg);
		if (t.isUnion() ? t.types.some(symbol) : symbol(t)) return 'throws';
	}
	return 'converts';
}

/** What tells an untyped operation's operands apart: converting by what can throw (`conversionThrows`), held untyped, typed a string, typed a BigInt. */
export interface OperandTypes {
	readonly checker: ts.TypeChecker;
	untyped(n: ts.Node): boolean;
	held(n: ts.Node): boolean;
	string(n: ts.Node): boolean;
	big(n: ts.Node): boolean;
}

/** The throwing conversion the operator `n` runs on its untyped operands (`convertsUntyped`). */
export function untypedOperation(n: ts.Node, types: OperandTypes): UntypedOperation | null {
	if (!convertsUntyped(n, types.untyped, (e) => conversionCall(e, types.checker))) return null;
	if (ts.isTemplateSpan(n)) return { kind: 'template' };
	if (ts.isCallExpression(n)) return (n.expression as ts.Identifier).text === 'Number' ? { kind: 'number' } : { kind: 'string' };
	if (ts.isPrefixUnaryExpression(n)) return n.operator === K.PlusToken ? { kind: 'toNumber' } : { kind: 'toNumeric', op: n.operator === K.MinusToken ? 'negate' : 'bitNot' };
	const e = n as ts.BinaryExpression;
	const op = e.operatorToken.kind;
	const numeric = NUMERIC[op];
	const relational = RELATIONAL[op];
	if (relational) return { kind: 'compare', op: relational };
	const held = (x: ts.Expression) => types.held(x) || types.big(x);
	if (numeric) {
		const both: [boolean, boolean] = [held(e.left), held(e.right)];
		const untyped = both[0] && both[1] && (numeric[1] ? types.held(e.left) : untypedArithmetic(types.checker, e, types));
		return { kind: 'numeric', op: numeric[0], assigns: numeric[1], held: both, untyped };
	}
	if (op === K.PlusToken) return types.string(e.left) || types.string(e.right) ? { kind: 'concat', assigns: false } : { kind: 'add', assigns: false };
	if (types.held(e.left)) return { kind: 'add', assigns: true };
	return types.string(e.left) ? { kind: 'concat', assigns: true } : { kind: 'addend' };
}

/** The translator methods an untyped operation's code is spelled with, alike in both backends. */
export interface OperandSpelling {
	readonly checker: ts.TypeChecker;
	readonly syntax: { readonly runtime: RuntimeColumn<SharedOp>; readonly untypedType: string };
	coerce(e: ts.Expression, target: string): string;
	toNumber(e: ts.Expression): string;
}

/** A numeric operation's call on `left` and `right` (the operands, or their code where a string). */
export function numericThrowing(t: OperandSpelling, plan: Extract<UntypedOperation, { kind: 'numeric' }>, left: ts.Expression | string, right: ts.Expression | string): string {
	const operand = (x: ts.Expression | string, held: boolean) => (typeof x === 'string' ? x : held ? t.coerce(x, t.syntax.untypedType) : t.toNumber(x));
	return `${t.syntax.runtime[(plan.untyped ? NUMERIC_UNTYPED : NUMERIC_THROWING)[plan.op]]}(${operand(left, plan.held[0])}, ${operand(right, plan.held[1])})`;
}

/** A relational operator's call on its operands, as script holds them. */
function relationalThrowing(t: OperandSpelling, plan: Extract<UntypedOperation, { kind: 'compare' }>, e: ts.BinaryExpression): string {
	return `${t.syntax.runtime[RELATIONAL_THROWING[plan.op]]}(${t.coerce(e.left, t.syntax.untypedType)}, ${t.coerce(e.right, t.syntax.untypedType)})`;
}

/**
 * A numeric operator (not a compound assignment) or a relational one under `plan`: its throwing call; `x instanceof
 * Object` (`isObjectInstanceTest`): the runtime's test of the value; null for any other.
 */
export function untypedBinary(t: OperandSpelling, plan: UntypedOperation | null, e: ts.BinaryExpression): string | null {
	if (isObjectInstanceTest(e, t.checker)) return `${t.syntax.runtime.jsInstanceOfObject}(${t.coerce(e.left, t.syntax.untypedType)})`;
	if (plan?.kind === 'numeric' && !plan.assigns) return numericThrowing(t, plan, e.left, e.right);
	return plan?.kind === 'compare' ? relationalThrowing(t, plan, e) : null;
}

/** The code of `operand`'s own conversion under `plan` (unary, template, concatenation, `a += b`'s b, `String(x)`). */
export function untypedConversion(t: OperandSpelling, plan: UntypedOperation, operand: ts.Expression): string {
	const rt = t.syntax.runtime;
	const value = t.coerce(operand, t.syntax.untypedType);
	switch (plan.kind) {
		case 'toNumber':
			return `${rt.jsToNumberThrowing}(${value})`;
		case 'toNumeric':
			return plan.op === 'negate' ? `-${rt.jsToNumericThrowing}(${value})` : `${rt.jsBitNot}(${rt.jsToNumericThrowing}(${value}))`;
		case 'addend':
			return `${rt.jsNumberAddendThrowing}(${value})`;
		case 'concat':
			return `${rt.jsToStringDefaultThrowing}(${value})`;
		case 'template':
			return `${rt.jsToStringThrowing}(${value})`;
		case 'string':
			return `${rt.jsStringThrowing}(${value})`;
		case 'number':
			return `${rt.jsToNumericThrowing}(${value})`;
		default:
			throw new Error(`untypedConversion: ${plan.kind} converts both operands together`);
	}
}

/** What the front tells of an operand, beside its spelling, where an operator converts it. */
export interface UntypedSpelling extends OperandSpelling {
	untypedOperation(n: ts.Node): UntypedOperation | null;
	heldUntyped(n: ts.Node): boolean;
	conversionThrows(n: ts.Node): boolean;
	isObjectRef(n: ts.Node): boolean;
	isAny(n: ts.Node): boolean;
	maybeUndefined(n: ts.Node): unknown;
	typeOf(n: ts.Node): string;
	str(e: ts.Expression): string;
}

/** A template literal's substitution: its untyped value's throwing conversion, anything else as the backend's `str` gives it. */
export function templateSubstitution(t: UntypedSpelling, span: ts.TemplateSpan): string {
	const plan = t.untypedOperation(span);
	return plan ? untypedConversion(t, plan, span.expression) : t.str(span.expression);
}

/** How a computed key converts to a property key (`frontMethods.keyConversion`). */
export type KeyConversion = 'symbol' | 'value' | 'string';

/**
 * A computed key as a property key, as `keyConversion` decides: ToString (`str`), by what it holds (`jsPropertyKey`),
 * or a symbol's own key (`symbolKey`, the backend's spelling of a symbol it holds).
 */
export function propertyKeyCode(t: OperandSpelling & { keyConversion(e: ts.Expression): KeyConversion; str(e: ts.Expression): string }, e: ts.Expression, symbolKey: () => string): string {
	const conversion = t.keyConversion(e);
	if (conversion === 'string') return t.str(e);
	return conversion === 'value' ? `${t.syntax.runtime.jsPropertyKey}(${t.coerce(e, t.syntax.untypedType)})` : symbolKey();
}

/** The library's `String(x)` or `Number(x)` of an operand whose conversion may throw: its throwing conversion; null for any other. */
export function conversionCallThrowing(t: UntypedSpelling, e: ts.CallExpression): string | null {
	const plan = t.untypedOperation(e);
	return plan?.kind === 'string' || plan?.kind === 'number' ? untypedConversion(t, plan, e.arguments[0]!) : null;
}

/** Unary `+`, `-` or `~` on an operand held untyped: its throwing conversion; null for any other unary operator. */
export function untypedUnary(t: UntypedSpelling, e: ts.PrefixUnaryExpression): string | null {
	const plan = t.untypedOperation(e);
	return plan && untypedConversion(t, plan, e.operand);
}

/** `a + b` with an operand held untyped, neither a string: `jsAddThrowing` where the operator converts its operands (`untypedOperation`), else `jsAdd`. */
export function addCall(t: OperandSpelling, e: ts.BinaryExpression, untyped: UntypedOperation | null): string {
	const rt = t.syntax.runtime;
	return `${untyped?.kind === 'add' ? rt.jsAddThrowing : rt.jsAdd}(${t.coerce(e.left, t.syntax.untypedType)}, ${t.coerce(e.right, t.syntax.untypedType)})`;
}

/** An operand of `+` beside a string: an object converts with the default hint; `untyped`: the operator converts its untyped operands (`untypedOperation`). */
export function concatOperand(t: UntypedSpelling, e: ts.Expression, untyped: UntypedOperation | null = null): string {
	if (untyped && t.conversionThrows(e)) return untypedConversion(t, untyped, e);
	return (t.isObjectRef(e) || t.isAny(e)) && !t.maybeUndefined(e) && t.typeOf(e) !== 'JSSymbol' ? `${t.syntax.runtime.jsToStringDefault}(${t.coerce(e, t.syntax.untypedType)})` : t.str(e);
}
