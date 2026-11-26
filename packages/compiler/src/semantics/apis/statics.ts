// The functions of the library's namespaces and constructors (`Math.floor`, `Object.keys`, `console.log`), by owner.
import ts from 'typescript';
import { apiEntry, type ApiEntry, type ApiTable } from './api.ts';
import { ARRAY_STATICS, BUFFER_STATICS, TYPED_ARRAY_STATICS, type ArrayStatic, type BufferStatic, type TypedArrayStatic } from './array.ts';
import { CONSOLE } from './console.ts';
import { DATE_STATICS, type DateStatic } from './date.ts';
import { SYMBOL_STATICS, type SymbolStatic } from './globals.ts';
import { JSON_STATICS, type JsonStatic } from './json.ts';
import { MAP_STATICS, type MapStatic } from './mapset.ts';
import { MATH, type MathOp } from './math.ts';
import { BIGINT_STATICS, NUMBER_STATICS, type BigIntStatic, type NumberStatic } from './number.ts';
import { OBJECT_STATICS, type ObjectStatic } from './object.ts';
import { PROMISE_STATICS, type PromiseStatic } from './promise.ts';
import { STRING_STATICS, type StringStatic } from './string.ts';
import { TYPED_ARRAYS, isLibGlobal } from '../globals.ts';
import type { StateBackend } from '../states/value-states.ts';

/** A static function's name, of any owner: a backend compares a member's name only with one of these. */
export type StaticName = ArrayStatic | BufferStatic | TypedArrayStatic | DateStatic | SymbolStatic | JsonStatic | MapStatic | MathOp | BigIntStatic | NumberStatic | ObjectStatic | PromiseStatic | StringStatic | ConsoleMethod;

/** console's methods by name (`log`, `groupCollapsed`). */
type ConsoleMethod = 'log' | 'info' | 'debug' | 'dirxml' | 'error' | 'warn' | 'assert' | 'count' | 'countReset' | 'dir' | 'group' | 'groupCollapsed' | 'groupEnd' | 'table' | 'time' | 'timeEnd' | 'timeLog' | 'trace';

/** Each library global's static functions, by the global's name. */
export const STATICS: Readonly<Record<string, ApiTable<string>>> = Object.freeze({
	Array: ARRAY_STATICS,
	ArrayBuffer: BUFFER_STATICS,
	BigInt: BIGINT_STATICS,
	Date: DATE_STATICS,
	JSON: JSON_STATICS,
	Map: MAP_STATICS,
	Math: MATH,
	Number: NUMBER_STATICS,
	Object: OBJECT_STATICS,
	Promise: PROMISE_STATICS,
	String: STRING_STATICS,
	Symbol: SYMBOL_STATICS,
	console: CONSOLE,
	...Object.fromEntries(TYPED_ARRAYS.map((t) => [t, TYPED_ARRAY_STATICS])),
});

/** `<owner>.<name>(…)` of a library global; null where the library has no such function, which both backends refuse. */
export function staticFunction(owner: string, name: string): (ApiEntry & { readonly name: StaticName }) | null {
	const table = Object.hasOwn(STATICS, owner) ? STATICS[owner] : null;
	const entry = table && apiEntry(table, name);
	return entry ? { ...entry, name: name as StaticName } : null;
}

/** A feature-detection probe of an unsupported static member on a library global (`typeof (Uint8Array as any).fromBase64`). */
export function isUnsupportedLibStatic(ctx: Pick<StateBackend, 'resolve'>, read: ts.Expression, hasConstant: (key: string) => boolean): boolean {
	if (!ts.isPropertyAccessExpression(read) || ts.isOptionalChain(read)) return false;
	const base = ts.skipOuterExpressions(read.expression, ts.OuterExpressionKinds.Parentheses | ts.OuterExpressionKinds.Assertions);
	if (!ts.isIdentifier(base) || !isLibGlobal(ctx, base)) return false;
	return !staticFunction(base.text, read.name.text) && !hasConstant(`${base.text}.${read.name.text}`) && !['prototype', 'BYTES_PER_ELEMENT', 'length', 'name'].includes(read.name.text);
}

/** Which first-class function value a library global member (`console.error`, `String.fromCharCode`, `Uint8Array.from`, …) lowers to. */
export function libFunctionValueKind(owner: string, name: string): 'console' | 'fromCharCode' | 'fromCodePoint' | 'mathRandom' | 'mathVariadic' | 'typedArrayFrom' | 'isArray' | 'numberCheck' | null {
	if (owner === 'console' && Object.hasOwn(CONSOLE, name)) return 'console';
	if (owner === 'String' && name === 'fromCharCode') return 'fromCharCode';
	if (owner === 'String' && name === 'fromCodePoint') return 'fromCodePoint';
	if (owner === 'Math' && name === 'random') return 'mathRandom';
	if (owner === 'Math' && (name === 'min' || name === 'max')) return 'mathVariadic';
	if (TYPED_ARRAYS.includes(owner) && name === 'from') return 'typedArrayFrom';
	if (owner === 'Array' && name === 'isArray') return 'isArray';
	if (owner === 'Number' && ['isInteger', 'isSafeInteger', 'isFinite', 'isNaN'].includes(name)) return 'numberCheck';
	return null;
}
