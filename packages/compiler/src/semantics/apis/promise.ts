// `Promise`'s functions. A combinator given what it cannot iterate rejects rather than throws.
import { apiEntry, apiTable, type ApiEntry } from './api.ts';

export type PromiseStatic = 'all' | 'allSettled' | 'any' | 'race' | 'reject' | 'resolve' | 'withResolvers';

export const PROMISE_STATICS = apiTable<PromiseStatic>('static', {
	all: { arity: 1, result: 'object' },
	allSettled: { arity: 1, result: 'object' },
	any: { arity: 1, result: 'object' },
	race: { arity: 1, result: 'object' },
	reject: { arity: 1, result: 'object' },
	resolve: { arity: 1, result: 'object' },
	withResolvers: { arity: 0, result: 'object' },
});

export type PromiseMethod = 'cancel' | 'catch' | 'finally' | 'then';

export const PROMISE_METHODS = apiTable<PromiseMethod>('method', {
	// @nativescript/core's AnimationPromise's.
	cancel: { arity: 0, result: 'undefined', host: true },
	catch: { arity: 1, result: 'object' },
	finally: { arity: 1, result: 'object' },
	then: { arity: 2, result: 'object' },
});

/** `promise.<name>(…)`; null for a method promises do not have. */
export function promiseMember(name: string): ApiEntry<PromiseMethod> | null {
	return apiEntry(PROMISE_METHODS, name);
}
