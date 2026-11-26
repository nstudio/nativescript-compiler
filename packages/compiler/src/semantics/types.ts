import ts from 'typescript';
import { isCoreDeclaration } from '../program/core-facts.ts';
import type { Representation } from './forms/forms.ts';
import type { Held } from './shapes.ts';
import { isLibDeclaration } from './ast.ts';
import { BUFFER_TYPES, ERRORS, UNSUPPORTED_LIB_GLOBALS } from './globals.ts';
import type { Ledger } from './ledger.ts';
import { rethrowUnlessRefused } from './refusals.ts';

/** How the kits hold a core type they implement themselves: an animation's promise settles with no value; an animation definition is read by key. */
export type CoreTypeKind = 'void-promise' | 'untyped';

const CORE_TYPES: Readonly<Record<string, CoreTypeKind>> = {
	AnimationPromise: 'void-promise',
	AnimationDefinition: 'untyped',
};

/**
 * The kind of the core type `name` names where core declares it; null otherwise, as for a program's own type of that name.
 * `ownCore`: a build of core itself (library mode), whose own source declares it.
 */
export function coreTypeKind(name: string, decl: ts.Declaration | undefined, ownCore: boolean): CoreTypeKind | null {
	return Object.hasOwn(CORE_TYPES, name) && (isCoreDeclaration(decl) || (ownCore && !!decl && !decl.getSourceFile().isDeclarationFile)) ? CORE_TYPES[name] : null;
}

export type NativeKind =
	| 'string'
	| 'number'
	| 'boolean'
	| 'bigint'
	| 'symbol'
	| 'void'
	| 'never'
	| 'any'
	| 'nullish'
	| 'array'
	| 'record'
	| 'map'
	| 'set'
	| 'promise'
	| 'function'
	| 'object'
	/** A fixed list of values of their own types: Swift's tuple, Kotlin's `Pair` and `Triple`. */
	| 'tuple'
	/** A value type a conversion builds from any value, never refusing one: a date, an error, a native struct or enum. */
	| 'value';

/**
 * A type as a backend holds a value of it. The front decides its kind, arguments and empty state; `name` is the
 * backend's spelling of its present form, which the backend gives (`Spelling.name`) and the backend's own facts and
 * type equality key on.
 */
export interface NativeType {
	kind: NativeKind;
	/** The spelling without its optional mark (`JSArray<String>`, `Card`). */
	name: string;
	/**
	 * Type arguments: an array's element, a record's or map's value, a promise's result, a `JSNullish`'s present type; a
	 * function type the front builds, its parameters then its result.
	 */
	args: NativeType[];
	/** `T?`: nil is one empty state. */
	optional: boolean;
	/** Swift's `T!`: optional, read as present. */
	implicit: boolean;
	/** The type's name, its arguments aside (`JSPromise`, `Card`); none for a function type. */
	head?: string;
	/** The backend's exact text, for a type parsed from it: what `spell` gives back. */
	text?: string;
}

/** How a backend spells the types the front builds. Pure: spelling a type twice gives one text and changes nothing. */
export interface Spelling {
	/** The present form's spelling of a type of `kind` (its kit name `head`, its arguments). */
	name(kind: NativeKind, head: string | undefined, args: readonly NativeType[]): string;
	/** The whole spelling, its optional mark included. */
	spell(t: NativeType): string;
	/** Of a type carried as its text (`typeOf`): its optional form (`T?`; `T!` and an optional as they are). */
	optional(text: string): string;
	/** Of a type carried as its text: `JSNullish<T>` of its present form. */
	nullish(text: string): string;
	/** Of an array, Set, Map or record type carried as its text: its elements or values held optional (`JSArray<T?>`). */
	optionalElements(text: string): string;
	/** Of an array, Set or Map type carried as its text: its optional elements or values held as `JSNullish<T>`. */
	nullishElements(text: string): string;
}

/** A type the front builds, named by the backend. */
export function nativeType(s: Spelling, kind: NativeKind, head?: string, args: NativeType[] = [], optional = false): NativeType {
	return { kind, name: s.name(kind, head, args), args, optional, implicit: false, head };
}

/** A value the type says nothing of: any value, undefined included. */
export function untyped(s: Spelling): NativeType {
	return nativeType(s, 'any', undefined, [], true);
}

/** Any value, as both kits spell it: what a type step boxes into or unboxes from. */
export const ANY_VALUE: NativeType = { kind: 'any', name: 'Any', args: [], optional: true, implicit: false, text: 'Any?' };

/** The untyped `Any?` (no `Any`, no `Any!`, and of a parsed type, no other text of it); no type at all (null) is not. */
export function isUntyped(t: NativeType | null): boolean {
	return !!t && t.kind === 'any' && t.name === 'Any' && t.optional && !t.implicit && (t.text === undefined || t.text === ANY_VALUE.text);
}

/** The kits' own names of JavaScript's string, number and boolean, held as themselves. */
const PRIMITIVE_NAMES: ReadonlySet<string> = new Set(['String', 'Double', 'Bool', 'Boolean']);

/** How a value of type `t` is held (`Held`): only Swift spells an implicitly unwrapped type, and never a function's result so. */
export function heldOf(t: NativeType): Held {
	if (isUntyped(t)) return 'any';
	if (t.kind === 'function' && !t.optional && !t.implicit) return t.name.endsWith('?') ? 'optional-result' : 'function';
	return t.optional ? 'optional' : t.implicit ? 'unwrapped' : 'present';
}

/** A string, number or boolean held as itself, present (`String`, `Double`, `Bool`). */
export function isPrimitive(t: NativeType): boolean {
	return !t.optional && !t.implicit && !t.args.length && PRIMITIVE_NAMES.has(t.name);
}

/** `t` is the type `name` (its spelling without an empty state: `JSMatch`, `JSRecord<Any?>`), optional or not; with `unwrapped` false, not Swift's `T!`. */
export function isNamed(t: NativeType | null, name: string, unwrapped = true): boolean {
	return !!t && t.name === name && (unwrapped || !t.implicit);
}

/** The kit's generic class `head` (`JSRecord<…>`, `JSPromise<…>`), whatever its empty state. */
export function isKit(t: NativeType, head: string): boolean {
	return t.head === head && t.args.length > 0;
}

/** One type, as the backend spells both. */
export function sameType(a: NativeType, b: NativeType): boolean {
	return a.text !== undefined && b.text !== undefined ? a.text === b.text : a.name === b.name && a.optional === b.optional && a.implicit === b.implicit;
}

/** The type without its empty state (`T?` and `T!` as `T`). */
export function presentOf(t: NativeType): NativeType {
	return t.optional || t.implicit ? { ...t, optional: false, implicit: false, text: undefined } : t;
}

/**
 * What `nativeTypeOf` asks of a backend: its spelling and ledger, its recursion into a type's parts, and the types only it
 * can name (a platform's classes and enums, a program's classes, shapes, function types, tuples).
 */
export interface TypeView {
	readonly checker: ts.TypeChecker;
	readonly spelling: Spelling;
	readonly ledger: Ledger;
	readonly lenient: boolean;
	/** A part of a type, as the backend holds it (its recursion: a type met again while it is mapped is untyped). */
	of(t: ts.Type, where?: ts.Node): NativeType;
	/** A type the backend holds its own way, asked before the front's rules: a platform's enum or class, a type only one platform declares, a namespace or enum held as a value; null for none. */
	leading(t: ts.Type, where?: ts.Node): NativeType | null;
	typeParameter(t: ts.Type, where?: ts.Node): NativeType;
	/** An intersection the backend holds as one of its parts or untyped; null to go on as for a named type. */
	intersection(t: ts.IntersectionType, where?: ts.Node): NativeType | null;
	/** The one type the platform has for a union's different arms (a native class they share); null where it has none. */
	commonType(t: ts.UnionType): NativeType | null;
	tuple(t: ts.TypeReference, where?: ts.Node): NativeType;
	/** Any other object type: a library, platform or program class or interface, a function type, a shape. */
	named(t: ts.Type, where?: ts.Node): NativeType;
}

/**
 * How a backend holds a value of TypeScript type `t` read at `where`: the front's rules for what JavaScript makes of
 * each kind of type (any value, nothing, primitives, unions, arrays), the view's for what only the backend names.
 */
export function nativeTypeOf(t: ts.Type, where: ts.Node | undefined, v: TypeView): NativeType {
	const F = ts.TypeFlags;
	const s = v.spelling;
	if (t.flags & (F.Any | F.Unknown | F.IndexedAccess | F.Null)) return untyped(s);
	if (t.flags & F.Never) return nativeType(s, 'never');
	if (t.flags & (F.Void | F.Undefined)) return nativeType(s, 'void');
	const leading = v.leading(t, where);
	if (leading) return leading;
	if (t.flags & F.TypeParameter) return v.typeParameter(t, where);
	if (t.isIntersection()) {
		const held = v.intersection(t, where);
		if (held) return held;
	}
	if (t.isUnion()) return unionType(t, where, v);
	if (t.flags & (F.Number | F.NumberLiteral)) return nativeType(s, 'number');
	if (t.flags & (F.String | F.StringLiteral | F.TemplateLiteral | F.StringMapping)) return nativeType(s, 'string');
	if (t.flags & (F.Boolean | F.BooleanLiteral)) return nativeType(s, 'boolean');
	if (t.flags & (F.ESSymbol | F.UniqueESSymbol)) return nativeType(s, 'symbol');
	if (t.flags & F.BigIntLike) return nativeType(s, 'bigint');
	if (t.flags & F.NonPrimitive) return untyped(s);
	const c = v.checker;
	if (c.isTupleType(t)) {
		const els = c.getTypeArguments(t as ts.TypeReference);
		if (els.length > 3 && !v.ledger.tuplesBeyondThree && !((t as ts.TypeReference).target as ts.TupleType).hasRestElement) {
			const held = els.map((el) => v.of(el, where));
			return nativeType(s, 'array', 'JSArray', [held.every((h) => sameType(h, held[0])) ? held[0] : untyped(s)]);
		}
		// A tuple both platforms hold as an array (one element, or a rest) of undefined is an array of any value, as an
		// array of undefined is.
		if ((els.length < 2 || ((t as ts.TypeReference).target as ts.TupleType).hasRestElement) && els.some((el) => el.flags & (F.Never | F.Undefined | F.Void))) return nativeType(s, 'array', 'JSArray', [untyped(s)]);
		return v.tuple(t as ts.TypeReference, where);
	}
	if (c.isArrayType(t)) {
		const el = c.getTypeArguments(t as ts.TypeReference)[0];
		// `[]`'s `never[]` holds anything once it is written to (lenient code types `[]` as `undefined[]`), and an array of
		// undefined holds whatever an alias of it as an array of any value writes: its elements carry no type to keep.
		const any = el.flags & (F.Never | F.Undefined | F.Void);
		return nativeType(s, 'array', 'JSArray', [any ? untyped(s) : heldElement(v.of(el, where), s, v.ledger)]);
	}
	return v.named(t, where);
}

/**
 * A union: its arms but null and undefined, optional where those were among them. Arms of one type are that type; of
 * different types, the platform's common type of them or any value. An empty array's `never[]` beside other object
 * arms (`xs || []`) takes their type. An arm the backend refuses to hold is left out.
 */
function unionType(t: ts.UnionType, where: ts.Node | undefined, v: TypeView): NativeType {
	const F = ts.TypeFlags;
	const c = v.checker;
	let parts = t.types.filter((u) => !(u.flags & (F.Undefined | F.Null | F.Void)));
	if (!parts.length) return untyped(v.spelling);
	const optional = parts.length < t.types.length;
	const empty = (u: ts.Type) => c.isArrayType(u) && !!(c.getTypeArguments(u as ts.TypeReference)[0]?.flags & F.Never);
	const primitive = (u: ts.Type) => !!(u.flags & (F.StringLike | F.NumberLike | F.BooleanLike | F.BigIntLike));
	if (parts.length > 1 && parts.some((u) => !empty(u)) && !parts.some(primitive)) parts = parts.filter((u) => !empty(u));
	const held = parts.flatMap((u) => {
		try {
			return [v.of(u, where)];
		} catch (e) {
			rethrowUnlessRefused(e);
			return [];
		}
	});
	if (!held.length) return v.of(parts[0], where);
	const one = new Map(held.map((h) => [v.spelling.spell(h), h]));
	const base = one.size === 1 ? held[0] : (v.commonType(t) ?? untyped(v.spelling));
	return optional ? optionalOf(base) : base;
}

/** The type with an empty state: optional, unless it has one already (`T?`, Swift's `T!`). */
export function optionalOf(t: NativeType): NativeType {
	return t.optional || t.implicit ? t : { ...t, optional: true, text: undefined };
}

/**
 * How a value of a library type is held. `kit`: the kit's class of that name, of kind `kind`, keeping the library type's
 * own arguments as `args` says: `value` as it is, `element` as a container's element (`Ledger.functionElementsUntyped`),
 * `target` as a weak reference's (an object). `conversion`: a function of any value giving the primitive (`Number` held
 * as a value). `array`: an array of the kit's class so named, of strings, or of any value.
 */
export type LibraryHeld = { readonly kit: string; readonly kind: NativeKind; readonly args?: readonly ('value' | 'element' | 'target')[] } | { readonly untyped: true } | { readonly conversion: 'number' | 'string' | 'boolean' } | { readonly array: 'JSMatch' | 'string' | 'untyped' };

/**
 * Which types of a library type's name are it: `lib` TypeScript's own library declares it (its first declaration);
 * `someDeclared` a declaration file declares one of its declarations; `interop` the iOS runtime's interop typings
 * declare it; `any` every type of the name.
 */
export type LibraryGuard = 'lib' | 'someDeclared' | 'interop' | 'any';

export interface LibraryType {
	readonly held: LibraryHeld;
	readonly guard: LibraryGuard;
}

const kit = (name: string, kind: NativeKind, ...args: ('value' | 'element' | 'target')[]): LibraryHeld => ({ kit: name, kind, args });
const UNTYPED: LibraryHeld = { untyped: true };
const lib = (held: LibraryHeld): LibraryType => ({ held, guard: 'lib' });
const any = (held: LibraryHeld): LibraryType => ({ held, guard: 'any' });

/** The library's types the kits hold as their own classes or untyped, by name. */
export const LIBRARY_TYPES: Readonly<Record<string, LibraryType>> = Object.assign(Object.create(null), {
	EventData: any(kit('EventData', 'object')),
	// `Promise.allSettled`'s results are the plain objects it makes (either of them, a union, is untyped).
	PromiseFulfilledResult: any(kit('JSObject', 'object')),
	PromiseRejectedResult: any(kit('JSObject', 'object')),
	Promise: any(kit('JSPromise', 'promise', 'value')),
	PromiseLike: any(kit('JSPromise', 'promise', 'value')),
	PromiseConstructorLike: lib(kit('JSPromiseConstructor', 'object')),
	PromiseConstructor: lib(kit('JSPromiseConstructor', 'object')),
	PromiseWithResolvers: lib(kit('JSPromiseWithResolvers', 'object', 'value')),
	Map: any(kit('JSMap', 'map', 'element', 'element')),
	ReadonlyMap: any(kit('JSMap', 'map', 'element', 'element')),
	Set: any(kit('JSSet', 'set', 'element')),
	ReadonlySet: any(kit('JSSet', 'set', 'element')),
	Date: any(kit('JSDate', 'value')),
	RegExp: any(kit('JSRegExp', 'object')),
	RegExpMatchArray: any(kit('JSMatch', 'object')),
	RegExpExecArray: any(kit('JSMatch', 'object')),
	RegExpStringIterator: any({ array: 'JSMatch' }),
	// A weak reference holds an object: an untyped target is any object.
	WeakRef: any(kit('JSWeakRef', 'object', 'target')),
	WeakMap: any(kit('JSWeakMap', 'object', 'value', 'value')),
	WeakSet: any(kit('JSWeakSet', 'object', 'value')),
	TemplateStringsArray: any({ array: 'string' }),
	ArrayBufferView: lib(kit('JSArrayBufferView', 'object')),
	// An array, a typed array or any object with a length: read by index and length, untyped.
	ArrayLike: lib(UNTYPED),
	IArguments: lib({ array: 'untyped' }),
	NumberFormat: lib(kit('JSNumberFormat', 'object')),
	DateTimeFormat: lib(kit('JSDateTimeFormat', 'object')),
	NumberFormatOptions: lib(UNTYPED),
	DateTimeFormatOptions: lib(UNTYPED),
	CollatorOptions: lib(UNTYPED),
	ResolvedNumberFormatOptions: lib(UNTYPED),
	ResolvedDateTimeFormatOptions: lib(UNTYPED),
	LocalesArgument: lib(UNTYPED),
	// `Number`, `String`, `Boolean` held as values (`const toNumber = Number`): the conversion each calls, which never throws.
	NumberConstructor: lib({ conversion: 'number' }),
	StringConstructor: lib({ conversion: 'string' }),
	BooleanConstructor: lib({ conversion: 'boolean' }),
	Generator: lib(kit('JSGenerator', 'object', 'value')),
	Iterator: lib(kit('JSIterator', 'object', 'value')),
	IterableIterator: lib(kit('JSIterator', 'object', 'value')),
	IteratorObject: lib(kit('JSIterator', 'object', 'value')),
	MapIterator: lib(kit('JSIterator', 'object', 'value')),
	SetIterator: lib(kit('JSIterator', 'object', 'value')),
	ArrayIterator: lib(kit('JSIterator', 'object', 'value')),
	StringIterator: lib(kit('JSIterator', 'object', 'value')),
	Iterable: lib(kit('JSIterable', 'object', 'value')),
	AsyncGenerator: lib(kit('JSAsyncGenerator', 'object', 'value')),
	AsyncIterator: lib(kit('JSAsyncIterator', 'object', 'value')),
	AsyncIterableIterator: lib(kit('JSAsyncIterator', 'object', 'value')),
	AsyncIteratorObject: lib(kit('JSAsyncIterator', 'object', 'value')),
	AsyncIterable: lib(kit('JSAsyncIterable', 'object', 'value')),
	IteratorResult: lib(UNTYPED),
	IteratorYieldResult: lib(UNTYPED),
	IteratorReturnResult: lib(UNTYPED),
	PropertyDescriptor: lib(UNTYPED),
	PropertyDescriptorMap: lib(UNTYPED),
	TypedPropertyDescriptor: lib(UNTYPED),
	// `new Error(message, { cause })`: the options are read by key.
	ErrorOptions: lib(UNTYPED),
	Reference: { held: kit('InteropReference', 'object'), guard: 'interop' },
	Pointer: { held: kit('InteropPointer', 'object'), guard: 'interop' },
	Symbol: lib(kit('JSSymbol', 'symbol')),
	// Any function, called with whatever arguments it is given.
	Function: lib(UNTYPED),
	// A built-in constructor held as a value: its class or runtime constructor, read and called dynamically.
	ErrorConstructor: lib(UNTYPED),
	TypeErrorConstructor: lib(UNTYPED),
	RangeErrorConstructor: lib(UNTYPED),
	SyntaxErrorConstructor: lib(UNTYPED),
	ReferenceErrorConstructor: lib(UNTYPED),
	AggregateErrorConstructor: lib(UNTYPED),
	DateConstructor: lib(UNTYPED),
	ArrayConstructor: lib(UNTYPED),
	ObjectConstructor: lib(UNTYPED),
	...Object.fromEntries(Object.entries(ERRORS).map(([name, cls]) => [name, { held: kit(cls, name === 'Error' ? 'value' : 'object'), guard: 'someDeclared' }])),
	...Object.fromEntries([...BUFFER_TYPES].map((name) => [name, lib(kit(`JS${name}`, 'object'))])),
});

/** The head of an error class held as its class object (`Ledger.errorClassObjects`), which each backend names. */
export const ERROR_CLASS = 'ErrorClass';

const ERROR_CONSTRUCTORS = new Set(['ErrorConstructor', 'TypeErrorConstructor', 'RangeErrorConstructor', 'SyntaxErrorConstructor', 'ReferenceErrorConstructor', 'AggregateErrorConstructor']);

/** The library type `name` names, as declared by `sym`, under the backend's ledger; null for a type of the program's own. */
export function libraryType(name: string, sym: ts.Symbol | undefined, ledger: Ledger): LibraryType | null {
	if (!Object.hasOwn(LIBRARY_TYPES, name)) return null;
	const entry = LIBRARY_TYPES[name];
	const decls = sym?.declarations ?? [];
	const guard = entry.guard;
	const found = guard === 'any' || (guard === 'lib' ? isLibDeclaration(decls[0]) : guard === 'someDeclared' ? decls.some((d) => d.getSourceFile().isDeclarationFile) : !!decls[0] && /[\\/]interop\.d\.ts$/.test(decls[0].getSourceFile().fileName));
	if (!found) return null;
	if (ERROR_CONSTRUCTORS.has(name) && ledger.errorClassObjects) return { held: kit(ERROR_CLASS, 'object'), guard: entry.guard };
	return entry;
}

/** A value of library type `lib` as a native type, `arg` giving the library type's own k-th type argument as the backend holds it. */
export function libraryNativeType(lib: LibraryType, arg: (k: number) => NativeType, s: Spelling, ledger: Ledger): NativeType {
	const held = lib.held;
	if ('untyped' in held) return untyped(s);
	if ('conversion' in held) return nativeType(s, 'function', undefined, [untyped(s), nativeType(s, held.conversion)]);
	if ('array' in held) return nativeType(s, 'array', 'JSArray', [held.array === 'untyped' ? untyped(s) : held.array === 'string' ? nativeType(s, 'string') : nativeType(s, 'object', held.array)]);
	const args = (held.args ?? []).map((hold, k) => {
		const a = arg(k);
		if (hold === 'element') return heldElement(a, s, ledger);
		if (hold === 'target') return isUntyped(a) ? nativeType(s, 'object', 'AnyObject') : presentOf(a);
		return a;
	});
	return nativeType(s, held.kind, held.kit, args);
}

/** A container's element of type `t`: a function element is held untyped where the ledger says so. */
export function heldElement(t: NativeType, s: Spelling, ledger: Ledger): NativeType {
	return ledger.functionElementsUntyped && t.kind === 'function' && t.head === undefined && !t.implicit ? untyped(s) : t;
}

const KINDS: Record<string, NativeKind> = {
	String: 'string',
	Double: 'number',
	Int: 'number',
	Float: 'number',
	CGFloat: 'number',
	Long: 'number',
	Bool: 'boolean',
	Boolean: 'boolean',
	JSBigInt: 'bigint',
	JSSymbol: 'symbol',
	Void: 'void',
	Unit: 'void',
	Never: 'never',
	Nothing: 'never',
	Any: 'any',
	JSNullish: 'nullish',
	JSArray: 'array',
	JSRecord: 'record',
	JSMap: 'map',
	JSSet: 'set',
	JSPromise: 'promise',
	Promise: 'promise',
	Deferred: 'promise',
	JSDate: 'value',
	JSError: 'value',
};

const SPELLED = new Map<string, Readonly<NativeType>>();

/**
 * `parseNativeType`, shared: the type a backend's spelling denotes, for the backends' questions over a type they still
 * carry as its text. The answer is a function of the text alone, so the cache outlives translations; frozen, as one
 * parse serves every asker (`parseNativeType` gives a type to change).
 */
export function spelledType(spelling: string): Readonly<NativeType>;
export function spelledType(spelling: string | null | undefined): Readonly<NativeType> | null;
export function spelledType(spelling: string | null | undefined): Readonly<NativeType> | null {
	if (spelling == null) return null;
	let t = SPELLED.get(spelling);
	if (!t) SPELLED.set(spelling, (t = deepFreeze(parseNativeType(spelling))));
	return t;
}

function deepFreeze(t: NativeType): NativeType {
	for (const a of t.args) deepFreeze(a);
	Object.freeze(t.args);
	return Object.freeze(t);
}

/** A Swift or Kotlin type as the translators spell it. */
export function parseNativeType(spelling: string): NativeType {
	let s = spelling.trim(),
		optional = false,
		implicit = false;
	// A function type returning an optional (`(A) -> B?`) is a function type, not an optional.
	while (!isFunction(s)) {
		if (s.endsWith('?')) {
			optional = true;
			s = s.slice(0, -1);
		} else if (s.endsWith('!')) {
			implicit = true;
			s = s.slice(0, -1);
		} else break;
		if (s.startsWith('(') && closing(s, 0) === s.length - 1 && !isFunction(s) && splitTop(s.slice(1, -1)).length === 1) s = s.slice(1, -1);
	}
	s = s.replace(/^@escaping /, '');
	if (isFunction(s)) return { kind: 'function', name: s, args: [], optional, implicit, text: spelling };
	if (s.startsWith('[') && s.endsWith(']')) return { kind: s.includes(':') ? 'record' : 'array', name: s, args: [], optional, implicit, text: spelling };
	if (s.startsWith('(') && closing(s, 0) === s.length - 1 && splitTop(s.slice(1, -1)).length > 1) return { kind: 'tuple', name: s, args: splitTop(s.slice(1, -1)).map(parseNativeType), optional, implicit, text: spelling };
	const generic = /^([\w.]+)<(.*)>$/s.exec(s);
	const head = generic ? generic[1] : s;
	const args = generic ? splitTop(generic[2]) : [];
	// Kotlin's tuples; a program's class of either name has its own arguments, or none.
	const tuple = (head === 'Pair' && args.length === 2) || (head === 'Triple' && args.length === 3);
	const kind = tuple ? 'tuple' : (KINDS[head.replace(/^(?:kotlin\.|Swift\.|NativeScriptKit\.)/, '')] ?? (/^FunctionCell_/.test(head) ? 'function' : 'object'));
	return { kind, name: s, args: args.map(parseNativeType), optional, implicit, head, text: spelling };
}

/** A slot's representation from its spelling alone: an optional's nil is `nilIs`. */
export function spelledRepresentation(t: NativeType, nilIs: 'undefined' | 'null' = 'undefined'): Representation {
	if (t.kind === 'any') return 'foreign';
	if (t.kind === 'nullish') return 'nullish';
	return t.optional || t.implicit ? nilIs : 'present';
}

function isFunction(s: string): boolean {
	if (!s.startsWith('(')) return /^suspend \(/.test(s);
	const end = closing(s, 0);
	return end > 0 && /^\s*(?:async\s+)?(?:throws\s+)?->/.test(s.slice(end + 1));
}

function closing(s: string, open: number): number {
	let depth = 0;
	for (let k = open; k < s.length; k++) {
		if ('(<['.includes(s[k])) depth++;
		else if (')>]'.includes(s[k]) && !(s[k] === '>' && s[k - 1] === '-')) {
			if (--depth === 0) return k;
		}
	}
	return -1;
}

function splitTop(s: string): string[] {
	const out: string[] = [];
	let depth = 0,
		from = 0;
	for (let k = 0; k < s.length; k++) {
		if ('(<['.includes(s[k])) depth++;
		else if (')>]'.includes(s[k]) && !(s[k] === '>' && s[k - 1] === '-')) depth--;
		else if (s[k] === ',' && !depth) {
			out.push(s.slice(from, k));
			from = k + 1;
		}
	}
	out.push(s.slice(from));
	return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * An object type naming only an event's fields: core's EventData, the data its views raise events with. An inline type
 * (`args: { value: boolean }`) or an object literal given where a type is expected (`this.notify({ eventName, object })`);
 * a literal nothing types (`const a = { value: 1 }`) is its own shape.
 */
export function eventDataTypeLiteral(t: ts.Type, checker: ts.TypeChecker): boolean {
	const props = t.getProperties();
	if (!props.length || !props.every((p) => p.name === 'eventName' || p.name === 'object' || p.name === 'value')) return false;
	return !!t.getSymbol()?.declarations?.every((d) => ts.isTypeLiteralNode(d) || (ts.isObjectLiteralExpression(d) && !!checker.getContextualType(d)));
}

/**
 * `x as Iterable<T>` of a value held as `from`, no iterable class, where `to` is spelled: T's spelling, and whether x
 * may not be iterable at all (an array, a set or a string is), where iterating it throws GetIterator's TypeError.
 * Null for any other assertion.
 */
export function iterableAssertion(from: string, to: string): { element: string; mayFail: boolean } | null {
	const target = /^JSIterable<(.*)>\??$/.exec(to);
	if (!target || /^JS(Iterable|Iterator|Generator|Map)</.test(from)) return null;
	return { element: target[1], mayFail: !/^(JSArray<.*>|JSSet<.*>|String)$/.test(from) };
}

const ERASED_LIB_UTILITIES = new Set(['Extract', 'Exclude', 'NonNullable', 'ReturnType', 'Parameters', 'ConstructorParameters', 'InstanceType', 'ThisParameterType', 'OmitThisParameter', 'ThisType', 'Record']);
const CLASS_UTILITIES = new Set(['Partial', 'Required', 'Readonly', 'Pick', 'Omit']);

/**
 * Mapped types (`Partial<…>`, `{ [k in Side]: number }`), unresolved TS utility aliases (`Extract`, `Exclude`, …),
 * and `*Constructor` lib interfaces: returns the underlying class type for a utility wrapping a class, `'any'` when
 * held untyped, or null otherwise.
 */
export function mappedOrErasedType(t: ts.Type, name: string | undefined, sym: ts.Symbol | undefined): ts.Type | 'any' | null {
	if (name && CLASS_UTILITIES.has(name) && t.aliasSymbol) {
		const of = t.aliasTypeArguments?.[0];
		return of && of.getSymbol()?.flags! & ts.SymbolFlags.Class ? of : 'any';
	}
	if (name && ERASED_LIB_UTILITIES.has(name) && t.aliasSymbol && isLibDeclaration(t.aliasSymbol.declarations?.[0])) return 'any';
	if (name && (/Constructor$/.test(name) || UNSUPPORTED_LIB_GLOBALS.has(name)) && sym?.declarations?.length && sym.declarations.every((d) => isLibDeclaration(d))) return 'any';
	if ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) return 'any';
	return null;
}

/** `Object` as TypeScript's own lib declares it: held untyped. */
export function isLibObjectType(name: string | undefined, sym: ts.Symbol | undefined): boolean {
	return name === 'Object' && !!sym?.declarations?.every((d) => /[\\/]typescript[\\/]lib[\\/]/.test(d.getSourceFile().fileName));
}

/** `NonNullable<T>`'s inner type argument when unresolved by the checker; null otherwise. */
export function nonNullableInner(t: ts.Type, name: string | undefined, args: readonly ts.Type[]): ts.Type | null {
	return name === 'NonNullable' && t.aliasSymbol && args.length === 1 ? args[0] : null;
}

/** Strips trailing `?` from a spelled native type unless it is untyped (`Any?`). */
export function nonOptionalSpelling(type: string): string {
	return isUntyped(spelledType(type)) ? type : type.replace(/\?$/, '');
}

/** A JSDoc `@constructor` function in a JS module (no class/interface/enum/ambient declaration): no native class exists for it. */
export function isJsDocConstructorFunction(sym: ts.Symbol | undefined): boolean {
	if (!sym?.valueDeclaration || !(ts.isFunctionDeclaration(sym.valueDeclaration) || ts.isFunctionExpression(sym.valueDeclaration) || ts.isVariableDeclaration(sym.valueDeclaration))) return false;
	return !sym.declarations?.some((d) => ts.isClassLike(d) || ts.isInterfaceDeclaration(d) || ts.isEnumDeclaration(d) || d.getSourceFile().isDeclarationFile);
}
