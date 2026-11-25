// `Date`'s functions.
import { apiTable } from './api.ts';

export type DateStatic = 'UTC' | 'now' | 'parse';

export const DATE_STATICS = apiTable<DateStatic>('static', {
	UTC: { arity: 7, result: 'number' },
	now: { arity: 0, result: 'number' },
	parse: { arity: 1, result: 'number' },
});
