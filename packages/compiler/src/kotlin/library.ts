// JavaScript's library as the Kotlin backend names it: the runtime's classes and functions for the library's globals,
// constants and functions, and the core classes kit-android names otherwise.
import type { MathOp } from '../semantics/apis/math.ts';
import { BUFFER_TYPES, SHARED_LIB_CONSTANTS } from '../semantics/globals.ts';
import { RT } from './syntax.ts';

// No prototype: a name like `toString` is no error class.
export const BUILTIN_CLASSES: Record<string, string> = Object.assign(Object.create(null), { Promise: 'JSPromise<*>', Array: 'JSArray<*>', Map: 'JSMap<*, *>', Set: 'JSSet<*>', Date: 'JSDate', RegExp: 'JSRegExp' }, Object.fromEntries([...BUFFER_TYPES].map((n) => [n, `JS${n}`])));
/** Core classes kit-android implements under another name. */
export const KIT_NAMES_ANDROID: Record<string, string> = { ViewBase: 'View', ViewCommon: 'View', EditableTextBase: 'TextBase', LayoutBaseCommon: 'LayoutBase' };

/** `Math`'s functions, as Kotlin calls them. */
export const MATH: { readonly [Op in MathOp]: string } = {
	floor: 'Math.floor',
	ceil: 'Math.ceil',
	abs: 'Math.abs',
	sqrt: 'Math.sqrt',
	cbrt: 'Math.cbrt',
	trunc: RT.jsTrunc,
	sin: 'Math.sin',
	cos: 'Math.cos',
	tan: 'Math.tan',
	asin: 'Math.asin',
	acos: 'Math.acos',
	atan: 'Math.atan',
	exp: 'Math.exp',
	log: 'Math.log',
	log2: RT.jsLog2,
	log10: 'Math.log10',
	log1p: 'Math.log1p',
	expm1: 'Math.expm1',
	sinh: 'Math.sinh',
	cosh: 'Math.cosh',
	tanh: 'Math.tanh',
	sign: RT.jsSign,
	round: RT.jsRound,
	fround: RT.jsFround,
	clz32: RT.jsClz32,
	atan2: 'Math.atan2',
	imul: RT.jsImul,
	pow: RT.jsPow,
	hypot: RT.jsHypot,
	max: RT.jsMathMax,
	min: RT.jsMathMin,
	random: 'Math.random()',
};

/** `Math`'s functions of a spread list (`Math.max(...xs)`). */
export const MATH_OF_SPREAD: { readonly [Op in MathOp]?: string } = { max: RT.jsMathMaxOf, min: RT.jsMathMinOf };

export const LIB_CONSTANTS: Record<string, string> = {
	'Math.PI': 'Math.PI',
	'Math.E': 'Math.E',
	'Math.LN2': '0.6931471805599453',
	'Math.LN10': '2.302585092994046',
	'Math.LOG2E': '1.4426950408889634',
	'Math.LOG10E': '0.4342944819032518',
	'Math.SQRT2': '1.4142135623730951',
	'Math.SQRT1_2': '0.7071067811865476',
	'Number.MAX_SAFE_INTEGER': '9007199254740991.0',
	'Number.MIN_SAFE_INTEGER': '-9007199254740991.0',
	'Number.EPSILON': 'Math.ulp(1.0)',
	'Number.MAX_VALUE': 'Double.MAX_VALUE',
	'Number.MIN_VALUE': 'Double.MIN_VALUE',
	'Number.POSITIVE_INFINITY': 'Double.POSITIVE_INFINITY',
	'Number.NEGATIVE_INFINITY': 'Double.NEGATIVE_INFINITY',
	'Number.NaN': 'Double.NaN',
	...SHARED_LIB_CONSTANTS,
};
