// `Array`'s functions, and those of the buffer types.
import { apiEntry, apiTable, type ApiEntry } from './api.ts';

export type ArrayStatic = 'apply' | 'create' | 'from' | 'isArray' | 'of';
export type BufferStatic = 'from' | 'isView';
export type TypedArrayStatic = 'from' | 'of';

export const ARRAY_STATICS = apiTable<ArrayStatic>('static', {
	// Function.prototype's, which `Array(...list)` reads as.
	apply: { arity: 2, result: 'object' },
	create: { arity: 2, result: 'object', sdk: 'android' },
	from: { arity: 1, result: 'object' },
	isArray: { arity: 1, result: 'boolean' },
	of: { arity: 0, rest: true, result: 'object' },
});

export const BUFFER_STATICS = apiTable<BufferStatic>('static', {
	// NativeScript's `ArrayBuffer.from(byteBuffer)`, over a Java ByteBuffer.
	from: { arity: 1, result: 'object', sdk: 'android' },
	isView: { arity: 1, result: 'boolean' },
});

export const TYPED_ARRAY_STATICS = apiTable<TypedArrayStatic>('static', {
	from: { arity: 1, result: 'object' },
	of: { arity: 0, rest: true, result: 'object' },
});

export type ArrayMethod = 'at' | 'concat' | 'entries' | 'every' | 'fill' | 'filter' | 'find' | 'findIndex' | 'findLast' | 'findLastIndex' | 'flat' | 'flatMap' | 'forEach' | 'includes' | 'indexOf' | 'join' | 'keys' | 'lastIndexOf' | 'map' | 'pop' | 'push' | 'reduce' | 'reduceRight' | 'reverse' | 'shift' | 'slice' | 'some' | 'sort' | 'splice' | 'toLocaleString' | 'toReversed' | 'toSorted' | 'toSpliced' | 'toString' | 'unshift' | 'values' | 'with';

export const ARRAY_METHODS = apiTable<ArrayMethod>('method', {
	at: { arity: 1, result: 'any' },
	concat: { arity: 1, rest: true, result: 'object' },
	entries: { arity: 0, result: 'object' },
	every: { arity: 1, result: 'boolean' },
	fill: { arity: 1, result: 'object' },
	filter: { arity: 1, result: 'object' },
	find: { arity: 1, result: 'any' },
	findIndex: { arity: 1, result: 'number' },
	findLast: { arity: 1, result: 'any' },
	findLastIndex: { arity: 1, result: 'number' },
	flat: { arity: 0, result: 'object' },
	flatMap: { arity: 1, result: 'object' },
	forEach: { arity: 1, result: 'undefined' },
	includes: { arity: 1, result: 'boolean' },
	indexOf: { arity: 1, result: 'number' },
	join: { arity: 1, result: 'string' },
	keys: { arity: 0, result: 'object' },
	lastIndexOf: { arity: 1, result: 'number' },
	map: { arity: 1, result: 'object' },
	pop: { arity: 0, result: 'any' },
	push: { arity: 1, rest: true, result: 'number' },
	// Of an empty array with no initial value: a TypeError.
	reduce: { arity: 1, result: 'any', throws: true },
	reduceRight: { arity: 1, result: 'any', throws: true },
	reverse: { arity: 0, result: 'object' },
	shift: { arity: 0, result: 'any' },
	slice: { arity: 2, result: 'object' },
	some: { arity: 1, result: 'boolean' },
	sort: { arity: 1, result: 'object' },
	splice: { arity: 2, rest: true, result: 'object' },
	toLocaleString: { arity: 0, result: 'string' },
	toReversed: { arity: 0, result: 'object' },
	toSorted: { arity: 1, result: 'object' },
	toSpliced: { arity: 2, rest: true, result: 'object' },
	toString: { arity: 0, result: 'string' },
	unshift: { arity: 1, rest: true, result: 'number' },
	values: { arity: 0, result: 'object' },
	// An index past either end: a RangeError.
	with: { arity: 2, result: 'object', throws: true },
});

/**
 * Array.prototype's methods the kits run over any receiver (`Array.prototype.<name>.call(o, …)`, `jsArrayPrototypeCall`):
 * the methods of arrays above and `copyWithin`, which no array of the program's types calls.
 */
export const GENERIC_ARRAY_METHODS: ReadonlySet<string> = new Set([...Object.keys(ARRAY_METHODS), 'copyWithin']);

/** `array.<name>(…)`; null for a method arrays do not have. */
export function arrayMember(name: string): ApiEntry<ArrayMethod> | null {
	return apiEntry(ARRAY_METHODS, name);
}
