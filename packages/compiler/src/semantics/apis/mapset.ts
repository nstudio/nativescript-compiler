// `Map`'s and `Set`'s functions and methods.
import { apiEntry, apiTable, type ApiEntry } from './api.ts';

export type MapStatic = 'groupBy';
/** The methods of a Map or a Set (`get` and `set` a Map's, `add` a Set's). */
export type CollectionMethod = 'add' | 'clear' | 'delete' | 'entries' | 'forEach' | 'get' | 'has' | 'keys' | 'set' | 'values';

export const MAP_STATICS = apiTable<MapStatic>('static', {
	groupBy: { arity: 2, result: 'object', runtime: 'jsMapGroupBy' },
});

export const COLLECTION_METHODS = apiTable<CollectionMethod>('method', {
	add: { arity: 1, result: 'object' },
	clear: { arity: 0, result: 'undefined' },
	delete: { arity: 1, result: 'boolean' },
	entries: { arity: 0, result: 'object' },
	forEach: { arity: 1, result: 'undefined' },
	get: { arity: 1, result: 'any' },
	has: { arity: 1, result: 'boolean' },
	keys: { arity: 0, result: 'object' },
	set: { arity: 2, result: 'object' },
	values: { arity: 0, result: 'object' },
});

/** `map.<name>(…)` or `set.<name>(…)`; null for a method neither has. */
export function collectionMember(name: string): ApiEntry<CollectionMethod> | null {
	return apiEntry(COLLECTION_METHODS, name);
}
