// JavaScript's library globals as both kits implement them. Each name is the kits' runtime class or helper of that name
// (`JS` and the global's name for the buffer and web classes, the error classes' as listed), so a backend reads these
// tables and spells the name.
import type ts from 'typescript';
import type { Ledger } from './ledger.ts';
import type { StateBackend } from './states/value-states.ts';

export const TYPED_ARRAYS: readonly string[] = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];

/** The library's buffer types, each the runtime's class of its name with a `JS` prefix; their constructors throw a RangeError for a length or an offset out of bounds. */
export const BUFFER_TYPES: ReadonlySet<string> = new Set(['ArrayBuffer', ...TYPED_ARRAYS, 'DataView']);

// No prototype: a name like `toString` is no error class.
export const ERRORS: Readonly<Record<string, string>> = Object.assign(Object.create(null), { Error: 'JSError', TypeError: 'JSTypeError', RangeError: 'JSRangeError', SyntaxError: 'JSSyntaxError', ReferenceError: 'JSReferenceError', AggregateError: 'JSAggregateError' });

/**
 * A library error constructor's arguments (`new TypeError(message, options)`, an error class's `super(…)`): an
 * AggregateError's errors come first; the error's cause is the options' `cause`, read only when the options give one.
 */
export function errorArguments(name: string, args: readonly ts.Expression[]): { errors?: ts.Expression; message?: ts.Expression; options?: ts.Expression } {
	const [errors, message, options] = name === 'AggregateError' ? args : [undefined, ...args];
	return { errors, message, options };
}

/** WinterTC's web classes as NativeScript's globals declare them: the runtime's class of each name with a `JS` prefix. */
const WEB_CLASSES = ['TextEncoder', 'TextDecoder', 'Crypto', 'SubtleCrypto', 'CryptoKey', 'CryptoKeyPair', 'KeyAlgorithm', 'DOMException'];
/** The worker API's classes, web classes of a kit that runs workers. */
const WORKER_CLASSES = ['Worker', 'MessageEvent', 'ErrorEvent', 'URL'];

/** `name` is a web class the kit implements. */
export function isWebClass(ledger: Ledger, name: string): boolean {
	return WEB_CLASSES.includes(name) || (ledger.workerGlobals && WORKER_CLASSES.includes(name));
}

/** The web's option and algorithm dictionaries, plus global-object web interfaces read by key. */
export const WEB_DICTIONARIES: readonly string[] = ['TextDecoderOptions', 'Algorithm', 'HmacKeyGenParams', 'RsaKeyGenParams', 'RsaHashedKeyGenParams', 'RsaOaepParams', 'Performance', 'Storage'];

/** Globals declared in `/__shims__/globals.d.ts` whose runtime values live on `jsGlobalThis`. */
export const SHIM_GLOBAL_OBJECT_VARS: ReadonlySet<string> = new Set(['performance', 'localStorage', 'sessionStorage']);

/** Standard ES library globals the compiled runtime intentionally omits (`typeof X` is `"undefined"`). */
export const UNSUPPORTED_LIB_GLOBALS: ReadonlySet<string> = new Set(['Proxy', 'Reflect', 'eval', 'Function', 'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics']);

/** Library constants whose runtime spelling is identical in both Swift and Kotlin kits. */
export const SHARED_LIB_CONSTANTS: Readonly<Record<string, string>> = {
	'Symbol.iterator': 'JSSymbol.iterator',
	'Symbol.asyncIterator': 'JSSymbol.asyncIterator',
	'Symbol.toPrimitive': 'JSSymbol.toPrimitive',
	'Symbol.toStringTag': 'JSSymbol.toStringTag',
	'Symbol.hasInstance': 'JSSymbol.hasInstance',
	'Symbol.dispose': 'JSSymbol.dispose',
	'Symbol.asyncDispose': 'JSSymbol.asyncDispose',
	'Object.prototype': 'JSPrototypes.objectPrototype',
};

const LIB_GLOBALS = new Set(['Math', 'JSON', 'Object', 'Array', 'Number', 'Promise', 'console', 'String', 'Boolean', 'Map', 'Set', 'Date', 'RegExp', 'WeakRef', 'Symbol', 'WeakMap', 'WeakSet', 'BigInt']);

/** `id` names one of the library's globals itself, not a program's declaration of that name. */
export function isLibGlobal(b: Pick<StateBackend, 'resolve'>, id: ts.Identifier): boolean {
	if (!LIB_GLOBALS.has(id.text) && !BUFFER_TYPES.has(id.text)) return false;
	const decl = b.resolve(id)?.declarations?.[0];
	return !decl || decl.getSourceFile().isDeclarationFile;
}
