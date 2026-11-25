// `JSON`'s functions.
import { apiTable } from './api.ts';

export type JsonStatic = 'parse' | 'stringify';

export const JSON_STATICS = apiTable<JsonStatic>('static', {
	parse: { arity: 2, result: 'object', throws: true, runtime: 'jsJSONParse' },
	stringify: { arity: 3, result: 'string', throws: true },
});
