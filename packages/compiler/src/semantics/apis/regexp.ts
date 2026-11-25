// The string methods given a RegExp (`s.replace(/a/g, …)`), which the backends spell apart from the others.
import { apiEntry, apiTable, type ApiEntry } from './api.ts';

export type RegExpStringMethod = 'match' | 'matchAll' | 'replace' | 'replaceAll' | 'search' | 'split';

export const REGEXP_STRING_METHODS = apiTable<RegExpStringMethod>('method', {
	match: { arity: 1, result: 'object' },
	// A regexp without the global flag: a TypeError.
	matchAll: { arity: 1, result: 'object', throws: true },
	replace: { arity: 2, result: 'string' },
	replaceAll: { arity: 2, result: 'string', throws: true },
	search: { arity: 1, result: 'number' },
	split: { arity: 2, result: 'object' },
});

/** `string.<name>(regexp, …)`; null for one the kits do not take a RegExp for. */
export function regexpStringMember(name: string): ApiEntry<RegExpStringMethod> | null {
	return apiEntry(REGEXP_STRING_METHODS, name);
}
