// `Number`'s and `BigInt`'s functions.
import type ts from 'typescript';
import { apiEntry, apiTable, type ApiEntry } from './api.ts';

export type NumberStatic = 'isFinite' | 'isInteger' | 'isNaN' | 'isSafeInteger' | 'parseFloat' | 'parseInt';
export type BigIntStatic = 'asIntN' | 'asUintN';

export const NUMBER_STATICS = apiTable<NumberStatic>('static', {
	isFinite: { arity: 1, result: 'boolean' },
	isInteger: { arity: 1, result: 'boolean' },
	isNaN: { arity: 1, result: 'boolean' },
	isSafeInteger: { arity: 1, result: 'boolean' },
	parseFloat: { arity: 1, result: 'number', runtime: 'jsParseFloat', args: ['value'] },
	parseInt: { arity: 2, result: 'number', runtime: 'jsParseInt' },
});

export const BIGINT_STATICS = apiTable<BigIntStatic>('static', {
	asIntN: { arity: 2, result: 'bigint', throws: true },
	asUintN: { arity: 2, result: 'bigint', throws: true },
});

export type NumberMethod = 'toExponential' | 'toFixed' | 'toLocaleString' | 'toPrecision' | 'toString' | 'valueOf';

export const NUMBER_METHODS = apiTable<NumberMethod>('method', {
	// Digits or a radix out of range, or a locale no language tag names: a RangeError.
	toExponential: { arity: 1, result: 'string', throws: true },
	toFixed: { arity: 1, result: 'string', throws: true },
	toLocaleString: { arity: 0, result: 'string', throws: true },
	toPrecision: { arity: 1, result: 'string', throws: true },
	toString: { arity: 1, result: 'string', throws: true },
	valueOf: { arity: 0, result: 'number' },
});

/**
 * Whether a number method's argument not typed a number converts by running its own code (held untyped, or an object
 * other than a Date: valueOf, Symbol.toPrimitive), which can throw, so it converts by the kits' throwing ToNumber.
 */
export function argumentRunsConversion(t: { heldUntyped(n: ts.Node): boolean; isObjectRef(n: ts.Node): unknown; typeOf(n: ts.Node): string }, x: ts.Expression): boolean {
	return t.heldUntyped(x) || (!!t.isObjectRef(x) && t.typeOf(x) !== 'JSDate');
}

/** `number.<name>(…)`; null for a method numbers do not have. */
export function numberMember(name: string): ApiEntry<NumberMethod> | null {
	return apiEntry(NUMBER_METHODS, name);
}
