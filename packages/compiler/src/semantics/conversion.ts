import ts from 'typescript';
import type { Form, Representation } from './forms/forms.ts';
import type { TypeComposite } from './type-step.ts';
import { isUntyped, parseNativeType, type NativeKind, type NativeType } from './types.ts';
import type { Ledger } from './ledger.ts';
import { TRACING, traced } from './decision-trace.ts';
import { lossOf, type LossReason } from './losses.ts';
import { declaresThis } from './ast.ts';

// One conversion between slots: which of the 5×5 representation cells a placement is, decided
// from the two slots' forms and how the value enters, for both translators. It decides; the backends spell.

/** Where a value is placed or read. */
export type SlotKind = 'argument' | 'return' | 'field' | 'literalField' | 'variable' | 'binding' | 'element' | 'entry' | 'spread' | 'await' | 'callbackParameter' | 'callbackResult' | 'receiver' | 'condition' | 'operand' | 'untyped';

/** How a foreign value comes in: checked, narrowed by a type test, lenient (non-strict code), library (core). */
export type Entry = 'typed' | 'checked' | 'narrowed' | 'lenient' | 'library';

export interface Slot {
	/** The slot's states, where the program decides them; a slot known only by its spelling has none. */
	form?: Form;
	rep: Representation;
	type: NativeType;
	kind: SlotKind;
	/** For TypeError text: the member read, the parameter, the field. */
	name?: string;
}

/** A value as emitted, with what later steps need to know of it so that none reads the code. */
export interface Value {
	code: string;
	throws: boolean;
	/** Evaluating it twice is the same as once: a name, `this`, a literal, a translator temp. */
	pure: boolean;
	mark?: Mark;
}

/** The outermost operation of a value's code. */
export type Mark =
	/**
	 * `unchecked`: Kotlin's `jsUnchecked<T>(x)`, which passes any value for a `T`, or `jsCastCarried(x, …)`, which passes null for one. `spelled`: the type as the code names it.
	 * `up`: Swift's `x as T?`, which cannot fail. `implicit`: Swift's `jsImplicit(x as? T)`. `checked`: Swift's `jsCast(x, T.self)` in its place, as written.
	 */
	| { op: 'cast'; to: NativeType; optional: boolean; implicit: boolean; of: Value; unchecked?: boolean; spelled?: string; up?: boolean; checked?: string }
	/** Swift's `jsImplicit(x)`, or a function cell's own (`cell`: `FunctionCell_X.implicit(x)`; `via`: another static, `fromScriptOrNil`; `chained`: `jsImplicit(x)?`, a chain going on). */
	| { op: 'implicit'; of: Value; cell?: string; via?: string; chained?: boolean }
	/** Swift's `jsForeign(x, …)`, `jsArrayOrNil(x, …)`, `jsObjectRequired(x)`, `jsUnwrap(x, …)`: the kit's helper around the value, its other arguments `rest`. */
	| { op: 'helper'; name: 'jsForeign' | 'jsArrayOrNil' | 'jsObjectRequired' | 'jsUnwrap'; of: Value; rest: string }
	/** The kit's lenient read of a string, number or boolean (`jsLenientNumber(x)`). */
	| { op: 'lenient'; of: Value }
	| { op: 'unwrap' | 'asserted' | 'converted'; of: Value }
	| { op: 'empty'; null: boolean }
	/** Undefined read as a string, number or boolean (`(x ?: "undefined")`). */
	| { op: 'undefinedAs'; to: NativeType; of: Value }
	/** A value read as nothing (Kotlin `run { x; Unit }`). */
	| { op: 'discarded'; of: Value }
	/** A map's entry as the backend reads it, missing where the map lacks the key (`m.get(k)`). */
	| { op: 'entry'; of: Value; key: Value; element?: boolean }
	/** An array the code makes, of the element type it spells. */
	| { op: 'array'; element: string }
	/** A member read off the value (`x.name`; `optional`: Swift's `x?.name`; `dynamic`: Swift's `jsGet(x, "name")`). */
	| { op: 'member'; of: Value; name: string; optional?: boolean; dynamic?: boolean }
	/** Swift's `try` before the code of `of`. */
	| { op: 'try'; of: Value }
	/** Swift's `target = value` (`_` for a value discarded); `targetThrows`: evaluating the target can throw, so a `try` for the value cannot go after the `=`. */
	| { op: 'assign'; target: string; value: Value; targetThrows: boolean }
	/** A Swift statement that is its own block (`if c { … }`, `do { … }`), its `try`s inside it. */
	| { op: 'block' };

/** What one cell does to the value. */
export type Step = 'identity' | 'implicit' | 'type' | 'box' | 'nulled' | 'jsAny' | 'nullishOf' | 'nullishOfNull' | 'nullishOfAny' | 'optional' | 'unwrapNullish' | 'undefinedAs' | 'nullAs' | 'zero' | 'libraryDefault' | 'typeError' | 'readTypeError' | 'truthiness' | 'oneEmpty' | 'checked' | 'narrowed' | 'lenient' | 'converted' | 'refuse';

export interface Plan {
	from: Representation;
	to: Representation;
	entry: Entry;
	step: Step;
	/** The conversion may throw JavaScript's TypeError (Swift marks it `try`). */
	throws: boolean;
	/** The conversion reads the value more than once: an impure value is bound first. */
	binds: boolean;
	refuse?: string;
	/** Present types differ: a type step (arrays, records, promises, shapes, classes, functions) composes inside. */
	typeStep: boolean;
	/** A value stands in for the empty one (`undefinedAs`, `nullAs`, `zero`, `libraryDefault`) where it is held: why that is allowed, or `unnamed`. */
	loss?: LossReason | 'unnamed';
}

/** What a backend holds a value as, which may be other than what the checker types it (`heldType`). */
export interface Held {
	type: NativeType;
	rep: Representation;
}

/** The slot a value is placed into, as `placement` reads it. */
export interface Into {
	type: NativeType;
	kind: SlotKind;
	entry: Entry;
	mode: 'strict' | 'lenient' | 'library';
}

export interface Refusal {
	refuse: string;
}

/**
 * The rule a placement of a value the backend holds as `from` into `to` follows, the first
 * that matches; `claimed` is the type the checker gives the value. Pure: the backends spell each rule.
 * `untyped`: held untyped where the checker types it, so converted from the held value (checked; lenient code's
 * convert-or-zero). `typed`: every other placement, which the backend's own placement decides from the checker's type.
 */
export function placement(from: Held, to: Into, claimed: NativeType): { rule: 'untyped' | 'typed' } | Refusal {
	if (from.rep === 'foreign' && to.type.kind !== 'any' && claimed.kind !== 'any') return { rule: 'untyped' };
	return { rule: 'typed' };
}

/**
 * A value's or a native slot's class, as native bridging reads it; each backend
 * classifies its own spellings. `scriptObject`: an object script made (a literal's shape, a record). `anyDictionary`: a
 * native dictionary keyed by any object (`[AnyHashable: Any]`); `typedDictionary`: one whose keys and values are
 * plain classes (`[String: Any]`, `[String: String]`); `keyedDictionary`: one keyed by a string-backed constant type;
 * `nsDictionary`: a slot of Foundation's NSDictionary class itself (a Swift-declared plugin API's). `integer`, `floating`, `double`: a native number slot
 * (`Int`, `UInt`, Java's `int`; `Float`, `CGFloat`; the 64-bit floating type itself). `cStruct`: a C struct the runtime
 * fills from an object's fields of the same names (`NSRange`, `CGSize`).
 */
export type BridgeClass = 'untyped' | 'number' | 'string' | 'numericEnum' | 'scriptObject' | 'mutableData' | 'anyDictionary' | 'typedDictionary' | 'keyedDictionary' | 'nsDictionary' | 'numberObject' | 'data' | 'stringConstant' | 'integer' | 'floating' | 'double' | 'cStruct' | 'other';

/**
 * What the runtime does to a value of one class passed where a native API takes the other, as one step.
 * `dictionary`: a script object's keys and values marshalled; `entries`: a native dictionary's entries of the slot's key
 * and value types; `keyed`: marshalled, string keys as the constant type; `numberObject`: the number boxed
 * (a numeric enum by its raw value); `stringConstant`: the string as the constant type; `bridged`: Foundation's
 * mutable subclass as the value type Swift imports it as. `integer`: the number (ToNumber of
 * an untyped value; undefined is NaN) truncated toward zero and clamped to the slot's range, NaN 0, as the runtime's
 * conversion compiles on arm64 (FCVTZS/FCVTZU); `floating`: NaN 0, else rounded to the slot's type; `double`: NaN 0.
 * `struct`: each of the struct's fields read from the object by name and converted as its slot is.
 */
export type BridgeStep = 'dictionary' | 'dictionaryEntries' | 'entries' | 'keyed' | 'numberObject' | 'enumNumberObject' | 'stringConstant' | 'bridged' | 'integer' | 'floating' | 'double' | 'struct';

const BRIDGING: ReadonlyArray<readonly [BridgeClass | '*', BridgeClass, BridgeStep]> = [
	['*', 'keyedDictionary', 'keyed'],
	['untyped', 'anyDictionary', 'dictionary'],
	['scriptObject', 'anyDictionary', 'dictionary'],
	['untyped', 'typedDictionary', 'dictionaryEntries'],
	['scriptObject', 'typedDictionary', 'dictionaryEntries'],
	['anyDictionary', 'typedDictionary', 'entries'],
	['number', 'numberObject', 'numberObject'],
	['numericEnum', 'numberObject', 'enumNumberObject'],
	['untyped', 'stringConstant', 'stringConstant'],
	['string', 'stringConstant', 'stringConstant'],
	['mutableData', 'data', 'bridged'],
	['scriptObject', 'nsDictionary', 'dictionary'],
	['number', 'integer', 'integer'],
	['untyped', 'integer', 'integer'],
	['number', 'floating', 'floating'],
	['untyped', 'floating', 'floating'],
	['number', 'double', 'double'],
	['untyped', 'double', 'double'],
	['scriptObject', 'cStruct', 'struct'],
];

/** The bridging step for a value of class `from` where a native API takes `to`, or null: none (the backend's other rules decide). */
export function nativeBridging(from: BridgeClass, to: BridgeClass): BridgeStep | null {
	return BRIDGING.find(([f, t]) => (f === '*' || f === from) && t === to)?.[2] ?? null;
}

/** A receiver of `o.k` or `o[k]` by its declared type, for `memberOrKey`. `record`: typed by an index signature or a `Record`. */
export type Receiver = 'record' | 'class' | 'other';

/**
 * How `o.k` and `o[k]` reach the value, for both backends. `key`: the receiver's entry of that key, which is all a record
 * holds, whatever name the key spells. `classKey`: the class's key subscript, which reads and writes the named own
 * property (undefined for a missing one). `member`: the member the receiver's type declares.
 */
export function memberOrKey(receiver: Receiver, key: { literal: boolean }): 'member' | 'key' | 'classKey' {
	if (receiver === 'record') return 'key';
	if (receiver === 'class' && !key.literal) return 'classKey';
	return 'member';
}

/** What a backend knows of its own object types, for `structural`. */
export interface StructuralFacts {
	/** An object type the program declares structurally (an interface, a literal's shape), which another such converts to. */
	shape(name: string): boolean;
	/** The program's class `sub` extends or implements `base`. */
	extends(sub: string, base: string): boolean;
}

/**
 * How a value of one present type becomes another. `same`: nothing to do.
 * `upcast`: the same object as its base. `copy`: an object of the target's class viewing the source (its other keys
 * kept, its named members written through). `untyped`: an array of a type where an array of any value is wanted, the
 * one array held untyped (what either is written, the other reads; `===` holds). `view`: an array whose elements are
 * the same values as the wanted array's element type (each `upcast`, `untyped` or itself `view`: `Dog[]` as
 * `Animal[]`, `number[][]` as `any[][]`), the one array held as that type. `elements`: a container of the same kind
 * whose elements each take `element`, never `same` (then the container is `same`). Null: neither rule applies (the
 * backends' other arms decide). Containers here are Kotlin's and Swift's `JSArray`, `JSRecord`, `JSMap` and
 * `JSPromise`.
 */
export type Structural = { step: 'same' | 'upcast' | 'copy' | 'untyped' | 'view' } | { step: 'elements'; container: 'array' | 'record' | 'map' | 'promise'; element: Structural };

const CONTAINERS: Partial<Record<NativeKind, 'array' | 'record' | 'map' | 'promise'>> = { array: 'array', record: 'record', map: 'map', promise: 'promise' };

export function structural(from: NativeType, to: NativeType, facts: StructuralFacts): Structural | null {
	if (from.name === to.name) return { step: 'same' };
	const container = CONTAINERS[from.kind];
	if (container && from.kind === to.kind && from.args.length === to.args.length && from.args.length) {
		if (container === 'array' && isUntyped(to.args[0]) && !isUntyped(from.args[0])) return { step: 'untyped' };
		// A map's keys are the same JavaScript values whatever their element: only its values step.
		const k = from.args.length - 1;
		if (from.args.slice(0, k).some((a, j) => a.name !== to.args[j].name)) return null;
		const element = structural(from.args[k], to.args[k], facts);
		if (!element) return null;
		if (container === 'array' && (element.step === 'upcast' || element.step === 'untyped' || element.step === 'view')) return { step: 'view' };
		return element.step === 'same' ? element : { step: 'elements', container, element };
	}
	if (from.kind !== 'object' || to.kind !== 'object' || from.optional !== to.optional) return null;
	if (facts.extends(from.name, to.name)) return { step: 'upcast' };
	return facts.shape(from.name) && facts.shape(to.name) ? { step: 'copy' } : null;
}

/**
 * A function literal given where a callback's parameters are untyped and it declares types for them (an untyped array's
 * elements read by `(d: Item, i: number) => …`): `adapt`, a function of the slot's parameters calling the literal with
 * each untyped argument read as its parameter is declared, as JavaScript passes the value itself; else `as-is`.
 */
export function literalCallback(slot: readonly NativeType[], own: readonly NativeType[]): 'adapt' | 'as-is' {
	return own.some((p, k) => k < slot.length && isUntyped(slot[k]) && !isUntyped(p)) ? 'adapt' : 'as-is';
}

/** A spelling held as it is, `optional` where the backend's own facts hold it so. */
export function heldAs(spelling: string, optional: boolean): Held {
	const type = parseNativeType(spelling);
	return { type, rep: isUntyped(type) ? 'foreign' : optional ? 'undefined' : 'present' };
}

const PRIMITIVE: ReadonlySet<NativeKind> = new Set(['string', 'number', 'boolean']);
/** Kinds a checked conversion of a foreign value builds, never refuses. */
const CONVERTED: ReadonlySet<NativeKind> = new Set(['string', 'number', 'boolean', 'array', 'record', 'promise', 'function', 'void', 'any', 'value']);

/** The cell for a value of slot `from` placed in slot `to`. Pure: the throws analysis asks it too. */
export function plan(from: Slot, to: Slot, entry: Entry): Plan {
	return TRACING ? traced(`plan(${entry})`, planOf(from, to, entry)) : planOf(from, to, entry);
}

function planOf(from: Slot, to: Slot, entry: Entry): Plan {
	const f = from.rep,
		t = to.rep;
	const typeStep = f !== 'foreign' && t !== 'foreign' && presentName(from.type) !== presentName(to.type);
	const cell = (step: Step, throws = false, binds = false): Plan => {
		const loss = lossOf(step, to.kind, entry);
		return loss ? { from: f, to: t, entry, step, throws, binds, typeStep, loss } : { from: f, to: t, entry, step, throws, binds, typeStep };
	};
	if (f === 'foreign') return fromForeign(to, entry, cell);
	if (f === t) return cell(typeStep ? 'type' : 'identity');
	if (t === 'foreign') return cell(f === 'null' ? 'nulled' : f === 'nullish' ? 'jsAny' : 'box');
	if (t === 'nullish') return cell(f === 'null' ? 'nullishOfNull' : 'nullishOf');
	if (f === 'present') return cell('implicit');
	if (t === 'present') {
		if (f === 'nullish') return { ...emptyToPresent('undefined', to, entry, cell), step: 'unwrapNullish', binds: true };
		return emptyToPresent(f, to, entry, cell);
	}
	// Between the one-empty-state forms and the two-state one, a state is lost: refused where something tells them apart.
	const observed = !!(from.form?.observed || to.form?.observed);
	const lost = f === 'nullish' ? (t === 'null' ? 'undefined' : 'null') : f;
	if (observed) return { ...cell('refuse'), refuse: `${lost === 'null' ? 'null' : 'undefined'} placed where only ${t === 'null' ? 'null' : 'undefined'} is held, which the program tells apart` };
	return cell(f === 'nullish' ? 'optional' : 'oneEmpty');
}

/** U or N into a present slot: JavaScript's conversion of the empty value, or its TypeError. */
function emptyToPresent(state: 'undefined' | 'null', to: Slot, entry: Entry, cell: (s: Step, throws?: boolean) => Plan): Plan {
	if (to.kind === 'condition') return cell('truthiness');
	if (to.kind === 'receiver') return cell('readTypeError', true);
	if (!PRIMITIVE.has(to.type.kind)) return to.type.kind === 'any' || to.type.kind === 'void' ? cell('box') : cell('typeError', true);
	if (entry === 'library') return cell('libraryDefault');
	if (entry === 'lenient') return cell('zero');
	return cell(state === 'null' ? 'nullAs' : 'undefinedAs');
}

/**
 * What JavaScript's empty value (`undefined`, `null`) becomes in a slot of `type`, for every emitter placing one: a void
 * slot's unit value; the slot's own empty state where its type has one; else `widen`, which the slot-state rules must
 * have done at the slot's declaration (an optional, or `JSNullish` where both states are told apart), as no value of
 * the type stands for it.
 */
export function emptyInto(type: NativeType): 'unit' | 'held' | 'widen' {
	if (type.kind === 'void' && !type.optional) return 'unit';
	return type.optional || type.implicit || type.kind === 'nullish' || type.kind === 'any' ? 'held' : 'widen';
}

/** The F row: a foreign value into a typed slot, by how it enters. */
function fromForeign(to: Slot, entry: Entry, cell: (s: Step, throws?: boolean, binds?: boolean) => Plan): Plan {
	if (to.rep === 'foreign') return cell('identity');
	if (to.rep === 'nullish') return cell('nullishOfAny', true);
	switch (entry) {
		// Core's own code: a string, number or boolean converts as String(), Number() and Boolean() do, any object is a
		// TypeError; other kinds still convert unchecked.
		case 'library':
			return PRIMITIVE.has(to.type.kind) ? cell('checked', true) : cell('converted');
		case 'narrowed':
			return cell('narrowed', true);
		// Lenient code reads a missing primitive as its zero, but an object where one must be present is still a TypeError.
		case 'lenient':
			return cell('lenient', to.rep === 'present' && !PRIMITIVE.has(to.type.kind) && to.type.kind !== 'any');
		default:
			return cell('checked', to.rep === 'present' && !CONVERTED.has(to.type.kind));
	}
}

function presentName(t: NativeType): string {
	return t.kind === 'nullish' && t.args[0] ? presentName(t.args[0]) : t.name;
}

/**
 * Whether `===` can tell the value after a step from the value before it, for both backends (each spells keeping it:
 * Swift a function object, Kotlin a `JSAdapted`). Functions, containers and objects are one JavaScript value across
 * any step. At a function literal written in place there is none to keep: it is its first value. At a function-typed
 * parameter, a method's always matters (an override shares its signature), a function's only when its body does more
 * with it than call or test it (stores, compares, passes or returns it).
 */
export function keepsIdentity(c: TypeComposite, at?: ts.Node): boolean {
	if (c === 'primitive' || c === 'void' || c === 'value' || c === 'enum') return false;
	if (!at) return true;
	if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) return false;
	return ts.isParameter(at) ? escapingParameter(at) : true;
}

function escapingParameter(p: ts.ParameterDeclaration): boolean {
	const fn = p.parent;
	if (!ts.isFunctionDeclaration(fn) || !fn.body || !ts.isIdentifier(p.name)) return true;
	const name = p.name.text;
	let escapes = false;
	const visit = (n: ts.Node): void => {
		if (escapes) return;
		if (ts.isIdentifier(n) && n.text === name && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
			const at = n.parent;
			const called = (ts.isCallExpression(at) && at.expression === n) || (ts.isPropertyAccessExpression(at) && at.expression === n);
			const tested = ts.isTypeOfExpression(at) || (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.ExclamationToken) || ((ts.isIfStatement(at) || ts.isWhileStatement(at)) && at.expression === n) || (ts.isBinaryExpression(at) && at.left === n && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(at.operatorToken.kind));
			if (!called && !tested) escapes = true;
		}
		ts.forEachChild(n, visit);
	};
	visit(fn.body);
	return escapes;
}

/** A function type, or an array or Set of them, optionally with null or undefined: a type whose values `keepsIdentity` asks about as functions. */
export function functionShaped(t: ts.TypeNode): boolean {
	if (ts.isParenthesizedTypeNode(t)) return functionShaped(t.type);
	if (ts.isFunctionTypeNode(t)) return true;
	if (ts.isArrayTypeNode(t)) return functionShaped(t.elementType);
	if (ts.isUnionTypeNode(t)) {
		const present = t.types.filter((u) => u.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(u) && u.literal.kind === ts.SyntaxKind.NullKeyword));
		return present.length === 1 && functionShaped(present[0]);
	}
	if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && ['Array', 'ReadonlyArray', 'Set', 'ReadonlySet'].includes(t.typeName.text) && t.typeArguments?.length === 1) return functionShaped(t.typeArguments[0]);
	return false;
}

/**
 * A type parameter the translation erases to any value: an interface's or a type alias's (one class of fields serves
 * every instantiation), or a function's its parameters don't name (no call could infer it). Where
 * `Ledger.structuralGenericsErased`, also a function literal's, one bound to a shape, and one the parameters name only
 * inside function types.
 */
export function erasesTypeParameter(p: ts.TypeParameterDeclaration, ledger: Pick<Ledger, 'structuralGenericsErased'>): boolean {
	const fn = p.parent;
	if (ts.isInterfaceDeclaration(fn) || ts.isTypeAliasDeclaration(fn)) return true;
	const structural = ledger.structuralGenericsErased;
	if (!ts.isFunctionDeclaration(fn) && !ts.isMethodDeclaration(fn) && !(structural && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))) return false;
	if (structural && p.constraint && (ts.isTypeLiteralNode(p.constraint) || (ts.isIntersectionTypeNode(p.constraint) && p.constraint.types.some(ts.isTypeLiteralNode)))) return true;
	const named = new RegExp(`\\b${p.name.text}\\b`);
	return !fn.parameters.some((q) => {
		if (!q.type || !named.test(q.type.getText())) return false;
		if (!structural || !functionShaped(q.type)) return true;
		const ftn = functionTypeNode(q.type);
		return !!ftn && !declaresThis(ftn) && !keepsIdentity('function', q);
	});
}

/** A function type, with null or undefined. */
function functionTypeNode(t: ts.TypeNode): ts.FunctionTypeNode | null {
	while (ts.isParenthesizedTypeNode(t)) t = t.type;
	if (ts.isUnionTypeNode(t)) {
		const present = t.types.filter((u) => u.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(u) && u.literal.kind === ts.SyntaxKind.NullKeyword));
		return present.length === 1 ? functionTypeNode(present[0]) : null;
	}
	return ts.isFunctionTypeNode(t) ? t : null;
}
