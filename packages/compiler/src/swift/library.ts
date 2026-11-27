// JavaScript's library as the Swift backend names it: the runtime's classes and functions for the library's globals,
// constants and functions, and which of the kit's hand-written functions throw.
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { KIT_APPLE_SOURCES } from '../driver/paths.ts';
import { adapterRuntimeFiles } from '../kit/manifest.ts';
import { buildCache } from '../program/build-caches.ts';
import { BUFFER_TYPES, SHARED_LIB_CONSTANTS } from '../semantics/globals.ts';
import type { MathOp } from '../semantics/apis/math.ts';
import { RT } from './syntax.ts';

/** Library functions applied to a list (`f.apply(null, list)`): the runtime's function of an array-like. */
export const LIST_APPLIED: Record<string, string> = { 'String.fromCharCode': RT.jsFromCharCodeList, 'Math.max': RT.jsMathMaxList, 'Math.min': RT.jsMathMinList };

/** The ES library's decorator and property descriptor interfaces: plain objects in library mode. */
export const DESCRIPTORS = new Set(['PropertyDescriptor', 'TypedPropertyDescriptor', 'PropertyDescriptorMap', 'ClassDecorator', 'MethodDecorator', 'PropertyDecorator', 'ParameterDecorator']);

export const ARRAY_CALLBACK_METHODS = new Set(['forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap']);
export const isTypedArrayType = (t: string) => /^JS(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64|BigInt64|BigUint64)Array$/.test(t);
// No prototype: a name like `toString` is no error class.
export const BUILTIN_CLASSES: Record<string, string> = Object.assign(Object.create(null), { Promise: 'JSThenable', Array: 'JSArrayProtocol', Map: 'JSMapProtocol', Set: 'JSSetProtocol', Date: 'JSDate', RegExp: 'JSRegExp' }, Object.fromEntries([...BUFFER_TYPES].map((n) => [n, `JS${n}`])));

/** Library functions read as values, with their Swift function types. */
export const LIB_FUNCTION_VALUES: Record<string, { code: string; type: string }> = {
	clearTimeout: { code: `{ (__id: Any?) -> Void in ${RT.jsClearTimeout}(${RT.jsIsNullish}(__id) ? nil : ${RT.jsToNumber}(__id)) }`, type: '(Any?) throws -> Void' },
	clearInterval: { code: `{ (__id: Any?) -> Void in ${RT.jsClearInterval}(${RT.jsIsNullish}(__id) ? nil : ${RT.jsToNumber}(__id)) }`, type: '(Any?) throws -> Void' },
	queueMicrotask: { code: `{ (__f: @escaping () throws -> Void) -> Void in ${RT.jsQueueMicrotask} { ${RT.jsReport} { try __f() } } }`, type: '(() throws -> Void) throws -> Void' },
	requestAnimationFrame: { code: `{ (__f: @escaping (Double) throws -> Void) -> Double in ${RT.jsRequestAnimationFrame} { __t in ${RT.jsReport} { try __f(__t) } } }`, type: '((Double) throws -> Void) throws -> Double' },
	cancelAnimationFrame: { code: `{ (__id: Double?) -> Void in ${RT.jsCancelAnimationFrame}(__id) }`, type: '(Double?) throws -> Void' },
};

/** `Math`'s functions, by the Swift function each is. */
export const MATH: { readonly [Op in MathOp]: string } = {
	floor: 'Foundation.floor',
	ceil: 'Foundation.ceil',
	abs: 'Swift.abs',
	sqrt: 'Foundation.sqrt',
	cbrt: 'Foundation.cbrt',
	trunc: 'Foundation.trunc',
	sin: 'Foundation.sin',
	cos: 'Foundation.cos',
	tan: 'Foundation.tan',
	asin: 'Foundation.asin',
	acos: 'Foundation.acos',
	atan: 'Foundation.atan',
	exp: 'Foundation.exp',
	log: 'Foundation.log',
	log2: 'Foundation.log2',
	log10: 'Foundation.log10',
	log1p: 'Foundation.log1p',
	expm1: 'Foundation.expm1',
	sinh: 'Foundation.sinh',
	cosh: 'Foundation.cosh',
	tanh: 'Foundation.tanh',
	sign: RT.jsSign,
	round: RT.jsRound,
	fround: RT.jsFround,
	clz32: RT.jsClz32,
	atan2: 'Foundation.atan2',
	imul: RT.jsImul,
	pow: RT.jsPow,
	hypot: RT.jsHypot,
	max: RT.jsMathMax,
	min: RT.jsMathMin,
	random: 'Double.random(in: 0..<1)',
};

/** `Math`'s functions of a spread list (`Math.max(...xs)`), each taking the list's storage as `values`. */
export const MATH_OF_SPREAD: { readonly [Op in MathOp]?: string } = { max: RT.jsMathMax, min: RT.jsMathMin };

export const LIB_CONSTANTS: Record<string, string> = {
	'Math.PI': 'Double.pi',
	'Math.E': 'M_E',
	'Math.LN2': 'M_LN2',
	'Math.LN10': 'M_LN10',
	'Math.LOG2E': 'M_LOG2E',
	'Math.LOG10E': 'M_LOG10E',
	'Math.SQRT2': '2.0.squareRoot()',
	'Math.SQRT1_2': '0.5.squareRoot()',
	'Number.MAX_SAFE_INTEGER': '9007199254740991',
	'Number.MIN_SAFE_INTEGER': '-9007199254740991',
	'Number.EPSILON': 'Double.ulpOfOne',
	'Number.MAX_VALUE': 'Double.greatestFiniteMagnitude',
	'Number.MIN_VALUE': 'Double.leastNonzeroMagnitude',
	'Number.POSITIVE_INFINITY': 'Double.infinity',
	'Number.NEGATIVE_INFINITY': '-Double.infinity',
	'Number.NaN': 'Double.nan',
	...SHARED_LIB_CONSTANTS,
	'Date.now': '({ () throws -> Double in JSDate.now() } as () throws -> Double)',
};

/** The library constants spelled as a name or a path of names (`Double.pi`): reading one twice is reading it once. */
export const LIB_CONSTANT_PATHS = Object.values(LIB_CONSTANTS).filter((v) => /^[\w.]+$/.test(v));

/** By the adapter's Swift folder (`''` for none): the functions the kit's hand-written Swift with it declares. */
const kitFunctions = buildCache(new Map<string, Map<string, boolean>>());
/**
 * Whether the kit's hand-written Swift (with the build's adapter's, `adapterApple`) declares a function of this name
 * `throws` (any of its overloads); undefined where it declares none.
 */
export function kitFunctionThrows(name: string, adapterApple: string | undefined): boolean | undefined {
	let found = kitFunctions.get(adapterApple ?? '');
	if (!found) {
		found = new Map<string, boolean>();
		kitFunctions.set(adapterApple ?? '', found);
		const files = (readdirSync(KIT_APPLE_SOURCES, { recursive: true }).sort() as string[]).filter((f) => f.endsWith('.swift') && !f.startsWith('Core/')).map((f) => join(KIT_APPLE_SOURCES, f));
		for (const f of [...files, ...adapterRuntimeFiles(adapterApple)]) {
			const code = readFileSync(f, 'utf8');
			for (const m of code.matchAll(/\bfunc\s+(\w+)\s*(?:<[^>]*>)?\(/g)) {
				let depth = 1,
					k = m.index! + m[0].length;
				for (; k < code.length && depth; k++) depth += code[k] === '(' ? 1 : code[k] === ')' ? -1 : 0;
				const throws = /^\s*(?:async\s+)?(?:re)?throws\b/.test(code.slice(k, k + 30));
				found.set(m[1], (found.get(m[1]) ?? false) || throws);
			}
		}
	}
	return found.get(name);
}
