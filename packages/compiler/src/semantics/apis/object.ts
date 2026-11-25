// `Object`'s functions.
import { apiTable } from './api.ts';

export type ObjectStatic = 'assign' | 'create' | 'defineProperties' | 'defineProperty' | 'entries' | 'freeze' | 'fromEntries' | 'getOwnPropertyDescriptor' | 'getOwnPropertyNames' | 'getOwnPropertySymbols' | 'getPrototypeOf' | 'groupBy' | 'hasOwn' | 'is' | 'isExtensible' | 'isFrozen' | 'isSealed' | 'keys' | 'preventExtensions' | 'seal' | 'values';

export const OBJECT_STATICS = apiTable<ObjectStatic>('static', {
	assign: { arity: 2, rest: true, result: 'object' },
	create: { arity: 2, result: 'object' },
	defineProperties: { arity: 2, result: 'object', throws: true },
	defineProperty: { arity: 3, result: 'object', throws: true },
	entries: { arity: 1, result: 'object' },
	freeze: { arity: 1, result: 'object', runtime: 'jsFreeze', args: ['value'] },
	fromEntries: { arity: 1, result: 'object', runtime: 'jsObjectFromEntries', args: ['iterable'] },
	getOwnPropertyDescriptor: { arity: 2, result: 'object', throws: true },
	getOwnPropertyNames: { arity: 1, result: 'object', throws: true, runtime: 'jsOwnPropertyNames', args: ['any'] },
	getOwnPropertySymbols: { arity: 1, result: 'object', throws: true, runtime: 'jsOwnPropertySymbols', args: ['any'] },
	getPrototypeOf: { arity: 1, result: 'object', throws: true, runtime: 'jsGetPrototypeOf', args: ['any'] },
	groupBy: { arity: 2, result: 'object' },
	hasOwn: { arity: 2, result: 'boolean', runtime: 'jsHasOwn', args: ['any', 'key'] },
	is: { arity: 2, result: 'boolean', runtime: 'jsSameValue', args: ['any', 'any'] },
	isExtensible: { arity: 1, result: 'boolean', runtime: 'jsIsExtensible', args: ['any'] },
	isFrozen: { arity: 1, result: 'boolean', runtime: 'jsIsFrozen', args: ['any'] },
	isSealed: { arity: 1, result: 'boolean', runtime: 'jsIsSealed', args: ['any'] },
	keys: { arity: 1, result: 'object' },
	preventExtensions: { arity: 1, result: 'object' },
	seal: { arity: 1, result: 'object' },
	values: { arity: 1, result: 'object' },
});
