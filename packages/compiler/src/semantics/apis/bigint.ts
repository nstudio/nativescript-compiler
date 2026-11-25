// What `a op b` does where an operand is a BigInt: arithmetic of two BigInts (a TypeError for a BigInt and a number
// stays the runtime's), and comparison, exact against a number too.
import ts from 'typescript';
import type { SharedOp } from '../runtime.ts';

export type BigIntOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'remainder' | 'power' | 'and' | 'or' | 'xor' | 'shiftLeft' | 'shiftRight';
/** The operators a backend spells as its own infix operator on BigInts. */
export type BigIntInfix = Exclude<BigIntOp, 'divide' | 'remainder' | 'power' | 'shiftLeft' | 'shiftRight'>;

const K = ts.SyntaxKind;
const ARITHMETIC: Partial<Record<ts.SyntaxKind, BigIntOp>> = {
	[K.PlusToken]: 'add',
	[K.MinusToken]: 'subtract',
	[K.AsteriskToken]: 'multiply',
	[K.SlashToken]: 'divide',
	[K.PercentToken]: 'remainder',
	[K.AsteriskAsteriskToken]: 'power',
	[K.AmpersandToken]: 'and',
	[K.BarToken]: 'or',
	[K.CaretToken]: 'xor',
	[K.LessThanLessThanToken]: 'shiftLeft',
	[K.GreaterThanGreaterThanToken]: 'shiftRight',
};
const COMPOUND: Partial<Record<ts.SyntaxKind, BigIntOp>> = {
	[K.PlusEqualsToken]: 'add',
	[K.MinusEqualsToken]: 'subtract',
	[K.AsteriskEqualsToken]: 'multiply',
	[K.SlashEqualsToken]: 'divide',
	[K.PercentEqualsToken]: 'remainder',
	[K.AsteriskAsteriskEqualsToken]: 'power',
	[K.AmpersandEqualsToken]: 'and',
	[K.BarEqualsToken]: 'or',
	[K.CaretEqualsToken]: 'xor',
	[K.LessThanLessThanEqualsToken]: 'shiftLeft',
	[K.GreaterThanGreaterThanEqualsToken]: 'shiftRight',
};
const COMPARISON: Partial<Record<ts.SyntaxKind, '<' | '>' | '<=' | '>='>> = { [K.LessThanToken]: '<', [K.GreaterThanToken]: '>', [K.LessThanEqualsToken]: '<=', [K.GreaterThanEqualsToken]: '>=' };

/** The runtime's function of each BigInt operation the kits do not spell as an operator. */
const RUNTIME: { readonly [Op in Exclude<BigIntOp, BigIntInfix>]: SharedOp } = { divide: 'JSBigInt.divide', remainder: 'JSBigInt.remainder', power: 'JSBigInt.power', shiftLeft: 'JSBigInt.shiftLeft', shiftRight: 'JSBigInt.shiftRight' };

export type BigIntPlan =
	/** Of two BigInts; `assigns`: a compound assignment (`a += b`). */
	| { readonly kind: 'arithmetic'; readonly op: BigIntOp; readonly assigns: boolean }
	/** `big`: the operand that is a BigInt where the other is a number (compared with `JSBigInt.compare`), or null for two BigInts. */
	| { readonly kind: 'compare'; readonly operator: '<' | '>' | '<=' | '>='; readonly big: 'left' | 'right' | null };

/** What the binary operator `op` does on operands of which those flagged are BigInts; null where neither is, or for another operator. */
export function bigIntPlan(op: ts.SyntaxKind, leftBig: boolean, rightBig: boolean): BigIntPlan | null {
	if (!leftBig && !rightBig) return null;
	const both = leftBig && rightBig;
	if (both && ARITHMETIC[op]) return { kind: 'arithmetic', op: ARITHMETIC[op]!, assigns: false };
	if (both && COMPOUND[op]) return { kind: 'arithmetic', op: COMPOUND[op]!, assigns: true };
	const operator = COMPARISON[op];
	return operator ? { kind: 'compare', operator, big: both ? null : leftBig ? 'left' : 'right' } : null;
}

/** `a op b` of two BigInts: the runtime's function, or the backend's infix operator (`infix`). */
export function bigIntArithmetic(op: BigIntOp, a: string, b: string, runtime: { readonly [Op in SharedOp]: string }, infix: { readonly [Op in BigIntInfix]: string }): string {
	return Object.hasOwn(RUNTIME, op) ? `${runtime[RUNTIME[op as keyof typeof RUNTIME]]}(${a}, ${b})` : `(${a} ${infix[op as BigIntInfix]} ${b})`;
}

/** `JSBigInt.compare`'s call for a mixed comparison: the BigInt operand's code and the number's. */
export function bigIntCompare(big: string, number: string, runtime: { readonly [Op in SharedOp]: string }): string {
	return `${runtime['JSBigInt.compare']}(${big}, ${number})`;
}
