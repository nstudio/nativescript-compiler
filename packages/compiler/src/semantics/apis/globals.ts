// The library's global functions.
import { apiEntry, apiTable, type ApiEntry, type ApiResult, type ApiTable, type ArgForm } from './api.ts';
import type { SharedOp } from '../runtime.ts';

export type GlobalOp = 'String' | 'Number' | 'Boolean' | 'parseInt' | 'parseFloat' | 'isNaN' | 'isFinite' | 'setTimeout' | 'setInterval' | 'clearTimeout' | 'clearInterval' | 'queueMicrotask' | 'requestAnimationFrame' | 'cancelAnimationFrame' | 'unescape' | 'atob' | 'btoa' | 'encodeURIComponent' | 'encodeURI' | 'decodeURIComponent' | 'decodeURI' | 'Symbol' | 'BigInt';

interface Facts {
	args?: readonly ArgForm[];
	arity: number;
	result: ApiResult;
	throws?: true;
	runtime?: SharedOp;
	host?: true;
	declaredBy?: 'android';
}

const FACTS = {
	String: { arity: 1, result: 'string' },
	Number: { arity: 1, result: 'number', throws: true },
	Boolean: { arity: 1, result: 'boolean' },
	parseInt: { arity: 2, result: 'number', runtime: 'jsParseInt' },
	parseFloat: { arity: 1, result: 'number', runtime: 'jsParseFloat', args: ['string'] },
	isNaN: { arity: 1, result: 'boolean' },
	isFinite: { arity: 1, result: 'boolean' },
	setTimeout: { arity: 1, result: 'number', runtime: 'jsSetTimeout', host: true },
	setInterval: { arity: 1, result: 'number', runtime: 'jsSetInterval', host: true },
	clearTimeout: { arity: 0, result: 'undefined', runtime: 'jsClearTimeout', host: true },
	clearInterval: { arity: 0, result: 'undefined', runtime: 'jsClearInterval', host: true },
	queueMicrotask: { arity: 1, result: 'undefined', runtime: 'jsQueueMicrotask', args: ['callback'] },
	requestAnimationFrame: { arity: 1, result: 'number', host: true },
	cancelAnimationFrame: { arity: 1, result: 'undefined', host: true },
	unescape: { arity: 1, result: 'string', runtime: 'jsUnescape', args: ['string'] },
	atob: { arity: 1, result: 'string', throws: true, runtime: 'jsAtob', args: ['string'] },
	btoa: { arity: 1, result: 'string', throws: true, runtime: 'jsBtoa', args: ['string'] },
	encodeURIComponent: { arity: 1, result: 'string', throws: true, runtime: 'jsEncodeURIComponent', args: ['string'] },
	encodeURI: { arity: 1, result: 'string', throws: true, runtime: 'jsEncodeURI', args: ['string'] },
	decodeURIComponent: { arity: 1, result: 'string', throws: true, runtime: 'jsDecodeURIComponent', args: ['string'] },
	decodeURI: { arity: 1, result: 'string', throws: true, runtime: 'jsDecodeURI', args: ['string'] },
	Symbol: { arity: 0, result: 'symbol', runtime: 'jsSymbol' },
	BigInt: { arity: 1, result: 'bigint', throws: true },
} as const satisfies { readonly [Op in GlobalOp]: Facts };

export const GLOBALS: ApiTable<GlobalOp> = Object.freeze(Object.fromEntries((Object.keys(FACTS) as GlobalOp[]).map((op) => [op, { kind: 'global', op, ...(FACTS[op] as Facts), throws: !!(FACTS[op] as Facts).throws } satisfies ApiEntry<GlobalOp>])));

/** The global function `name`; null for one the library does not have. */
export function globalFunction(name: string): ApiEntry<GlobalOp> | null {
	return apiEntry(GLOBALS, name);
}

/** The global functions both backends call a kit function of their own name for (`setTimeout`: `jsSetTimeout`). */
export type NamedGlobal = { [Op in GlobalOp]: (typeof FACTS)[Op] extends { runtime: SharedOp } ? Op : never }[GlobalOp];

/** The kit function the global function `op` calls. */
export function globalOp(op: NamedGlobal): SharedOp {
	return FACTS[op].runtime;
}

export type SymbolStatic = 'for' | 'keyFor';

export const SYMBOL_STATICS = apiTable<SymbolStatic>('static', {
	for: { arity: 1, result: 'symbol' },
	keyFor: { arity: 1, result: 'string' },
});
