// `Math`'s functions. Each is its own operation: a backend spells it with the platform's function or the kit's.
import { apiEntry, apiTable, type ApiEntry, type ApiFacts } from './api.ts';

export type MathOp = 'abs' | 'acos' | 'asin' | 'atan' | 'atan2' | 'cbrt' | 'ceil' | 'clz32' | 'cos' | 'cosh' | 'exp' | 'expm1' | 'floor' | 'fround' | 'hypot' | 'imul' | 'log' | 'log10' | 'log1p' | 'log2' | 'max' | 'min' | 'pow' | 'random' | 'round' | 'sign' | 'sin' | 'sinh' | 'sqrt' | 'tan' | 'tanh' | 'trunc';

const ONE: ApiFacts = { arity: 1, result: 'number' };
const TWO: ApiFacts = { arity: 2, result: 'number' };
const REST: ApiFacts = { arity: 2, rest: true, result: 'number' };

export const MATH = apiTable<MathOp>('static', {
	abs: ONE,
	acos: ONE,
	asin: ONE,
	atan: ONE,
	atan2: TWO,
	cbrt: ONE,
	ceil: ONE,
	clz32: ONE,
	cos: ONE,
	cosh: ONE,
	exp: ONE,
	expm1: ONE,
	floor: ONE,
	fround: ONE,
	hypot: REST,
	imul: TWO,
	log: ONE,
	log10: ONE,
	log1p: ONE,
	log2: ONE,
	max: REST,
	min: REST,
	pow: TWO,
	random: { arity: 0, result: 'number' },
	round: ONE,
	sign: ONE,
	sin: ONE,
	sinh: ONE,
	sqrt: ONE,
	tan: ONE,
	tanh: ONE,
	trunc: ONE,
});

/** `Math.<name>`; null for a function the library does not have. */
export function mathFunction(name: string): ApiEntry<MathOp> | null {
	return apiEntry(MATH, name);
}

/** `Math.<name>` held as a value (`const round = Math.round`): a function of one number. */
export function mathFunctionValue(name: string): MathOp | null {
	const m = mathFunction(name);
	return m && m.arity === 1 && !m.rest ? m.op : null;
}
