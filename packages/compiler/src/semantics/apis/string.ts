// `String`'s functions.
import { apiEntry, apiTable, type ApiEntry } from './api.ts';

export type StringStatic = 'fromCharCode' | 'fromCodePoint';

export const STRING_STATICS = apiTable<StringStatic>('static', {
	fromCharCode: { arity: 1, rest: true, result: 'string' },
	fromCodePoint: { arity: 1, rest: true, result: 'string', throws: true, runtime: 'jsFromCodePoint', args: ['rest'] },
});

export type StringMethod = 'at' | 'charAt' | 'charCodeAt' | 'codePointAt' | 'concat' | 'endsWith' | 'includes' | 'indexOf' | 'lastIndexOf' | 'localeCompare' | 'match' | 'padEnd' | 'padStart' | 'repeat' | 'replace' | 'replaceAll' | 'search' | 'slice' | 'split' | 'startsWith' | 'substr' | 'substring' | 'toLocaleLowerCase' | 'toLocaleUpperCase' | 'toLowerCase' | 'toString' | 'toUpperCase' | 'trim' | 'trimEnd' | 'trimStart' | 'valueOf';

export const STRING_METHODS = apiTable<StringMethod>('method', {
	at: { arity: 1, result: 'string' },
	charAt: { arity: 1, result: 'string' },
	charCodeAt: { arity: 1, result: 'number' },
	codePointAt: { arity: 1, result: 'number' },
	concat: { arity: 1, rest: true, result: 'string' },
	endsWith: { arity: 1, result: 'boolean' },
	includes: { arity: 1, result: 'boolean' },
	indexOf: { arity: 1, result: 'number' },
	lastIndexOf: { arity: 1, result: 'number' },
	localeCompare: { arity: 1, result: 'number' },
	match: { arity: 1, result: 'object' },
	padEnd: { arity: 1, result: 'string' },
	padStart: { arity: 1, result: 'string' },
	// A negative or infinite count: a RangeError.
	repeat: { arity: 1, result: 'string', throws: true },
	replace: { arity: 2, result: 'string' },
	// A regexp without the global flag: a TypeError.
	replaceAll: { arity: 2, result: 'string', throws: true },
	search: { arity: 1, result: 'number' },
	slice: { arity: 2, result: 'string' },
	split: { arity: 2, result: 'object' },
	startsWith: { arity: 1, result: 'boolean' },
	substr: { arity: 2, result: 'string' },
	substring: { arity: 2, result: 'string' },
	toLocaleLowerCase: { arity: 0, result: 'string' },
	toLocaleUpperCase: { arity: 0, result: 'string' },
	toLowerCase: { arity: 0, result: 'string' },
	toString: { arity: 0, result: 'string' },
	toUpperCase: { arity: 0, result: 'string' },
	trim: { arity: 0, result: 'string' },
	trimEnd: { arity: 0, result: 'string' },
	trimStart: { arity: 0, result: 'string' },
	valueOf: { arity: 0, result: 'string' },
});

/** `string.<name>(…)`; null for a method strings do not have. */
export function stringMember(name: string): ApiEntry<StringMethod> | null {
	return apiEntry(STRING_METHODS, name);
}
