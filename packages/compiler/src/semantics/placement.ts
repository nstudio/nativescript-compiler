import ts from 'typescript';
import { traceMethods } from './decision-trace.ts';
import { emptyInto, placement, type Entry, type Held, type Into } from './conversion.ts';
import { isKit, isPrimitive, isUntyped, parseNativeType, presentOf, sameType, untyped, type NativeType, type Spelling } from './types.ts';
import type { Form } from './forms/forms.ts';
import type { ValueStates } from './states/value-states.ts';
import { unsafeReceiver } from './lang.ts';
import { rethrowUnlessRefused } from './refusals.ts';
import { observers } from './observers.ts';
import { isWriteTarget } from './ast.ts';
import type { Ledger } from './ledger.ts';

// A value placed in a slot: the front both translators share, deciding which cell of the state
// step a placement is from the value-states, before the backend's own type step. Each backend spells the cells.

/** One backend's spelling of the state step's cells `place` decides, named by their `Step` (conversion.ts). */

/** A slot that takes undefined as it is: any value, or a string, number or boolean's optional. */
function takesUndefined(to: NativeType): boolean {
	return isUntyped(to) || (to.optional && isPrimitive(presentOf(to)));
}

/** `JSArray<String>` (`optional`: `JSArray<String?>`, no empty state of its own), its own empty state aside unless `optional`. */
function arrayOfStrings(t: NativeType, optional: boolean): boolean {
	const el = t.args[0];
	if (!isKit(t, 'JSArray') || t.args.length !== 1 || el.kind !== 'string' || el.implicit || el.name !== 'String' || el.optional !== optional) return false;
	return !optional || (!t.optional && !t.implicit);
}

/**
 * The type without its optional mark (`T?` as `T`; Swift's `T!` stays). An optional function type's present form keeps
 * its parentheses (`((T) -> U)?` as `((T) -> U)`), so comparing an optional function with a function stays a script
 * comparison.
 */
function withoutOptional(t: NativeType): NativeType {
	return t.optional ? { ...t, optional: false, text: undefined, name: t.kind === 'function' ? `(${t.name})` : t.name } : t;
}

export interface StateCells {
	/** B → F: a `JSNullish<T>` read untyped. */
	jsAny(name: string): string;
	/** B → P: a `JSNullish<T>` read as its `T`, JavaScript's TypeError naming `key` where it holds null or undefined. */
	present(name: string, key: string): string;
	/** B → B of another present type: the value read as its optional `code`, made a `JSNullish<into>` again. */
	type(target: string, into: string, code: string): string;
	/** B → B where `into`'s value is the other's as it is (a supertype, `Any`): null and undefined kept apart. */
	upcast(target: string, code: string): string;
	/** U → B (or N → B, `isNull`): the optional `code` as a `JSNullish<into>`. */
	nullishOf(target: string, into: string, code: string, isNull: boolean): string;
	/** F → B: an untyped value, converted as `into` is read untyped; `entry` where it is an element or entry read untyped. */
	nullishOfAny(target: string, into: string, code: string, entry: boolean): string;
	/** A literal `null` (`isNull`) or `undefined` into `JSNullish`. */
	empty(isNull: boolean): string;
	/** N → F: a value whose nil is null, read untyped. */
	nulled(code: string): string;
	/**
	 * F → P/U with a checked entry, or null where the slot's type has no checked convert: the form an argument's
	 * or a store's `slot` decided, else `foreignPlacement`'s.
	 */
	checked(e: ts.Expression, target: string, slot?: ParamSlot | StoreSlot): string | null;
	/** F → P/U with a checked entry for a value only the backend's code has (`placeCode`), or null where the slot's type has none. */
	checkedCode(code: string, slot: StoreSlot): string | null;
	/** An empty marker's value as it is made (`emptyMarkers`), registered so that checked converts read it as an empty value. */
	marker(code: string): string;
}

/** What `place` reads of a translator. */
export interface PlacementBackend {
	readonly checker: ts.TypeChecker;
	readonly spelling: Spelling;
	readonly sourceFiles: readonly ts.SourceFile[];
	readonly library: unknown;
	readonly lenient: boolean;
	readonly states: ValueStates;
	readonly cells: StateCells;
	typeOf(n: ts.Node): string;
	expr(e: ts.Expression): string;
	resolve(n: ts.Node): ts.Symbol | undefined;
	error(n: ts.Node, what: string): Error;
	optionalType(t: string): string;
	/** The carrier a read's emitted code holds (`readHeld`): what `placement` converts from. */
	readHeld(e: ts.Expression): Held;
	/** `code`, a read held untyped where the checker types it, converted into `target` (`placement`'s `untyped` rule). */
	untypedRead(code: string, target: string, e: ts.Expression): string;
	/** The placement past the shared front: the type step, and the cells not decided here yet. */
	coerce(e: ts.Expression, target: string): string;
	coerceTyped(e: ts.Expression, target: string): string;
	/** The optional a string, number or boolean read converts undefined of (`(x ?? "undefined")`), outside library code; else null. */
	undefinedConverted(code: string): string | null;
	convert(code: string, from: string, to: string): string;
	fromAnyCode(code: string, type: string): string;
	/** A `string[]` an unset regexp group may have filled, or a match whose groups may include one. */
	unsetGroups(n: ts.Node): boolean;
	unsetMatch(e: ts.Expression): boolean;
	/** `nullishRead`'s value as its `JSNullish<T>`, and that slot's type. */
	nullishCode(e: ts.Expression): string;
	nullishSlotType(d: ts.Declaration): string;
	/** The backend's own placements that come before the shared front (Swift's held values). */
	before?(e: ts.Expression, target: string): string | null;
	/** Its own `JSNullish` reads before the shared ones (Kotlin's boxed element reads and adapted functions). */
	nullishBefore?(e: ts.Expression, target: string, held: ts.Declaration | null | undefined): string | null;
	/** Its own refusals and shortcuts once the value is neither `JSNullish` nor checked (Swift's generic-class checks, matches, `void`). */
	after?(e: ts.Expression, target: string): string | null;
	/** Its own shortcuts after the shared ones, before the type step. */
	shortcut?(e: ts.Expression, target: string): string | null;
	/** `code`, `e`'s value placed in an untyped slot, as that slot holds it: a view's root. */
	untypedRoot?(e: ts.Expression, code: string): string;
	/** A conditional placed in a `JSNullish` slot, each branch placed on its own. */
	branches(e: ts.ConditionalExpression, target: string): string;
	/** Its own reads of a value a `return` gives back, before the shared front (Swift's undefined reads of a call's result). */
	result?(e: ts.Expression, slot: ResultSlot): string | null;
	/** Its own cells of an argument, before the shared front (Swift's optional read given as it is, Kotlin's constant defaults). */
	argument?(e: ts.Expression, slot: ParamSlot): string | null;
	/** An `asIs` observer slot's read: the optional the value may be, never unwrapped nor required present. */
	observed(e: ts.Expression): string;
}

/** `e` given where TypeScript takes any value (`any`/`unknown`): only there is a view held as its root. Typed slots a backend holds as `Any?` (a WeakMap's keys, an erased type argument) keep the view, compared by its root. */
function untypedContextAnswer(checker: ts.TypeChecker, e: ts.Expression): boolean {
	const t = checker.getContextualType(e);
	return !!t && !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/** `e` typed by TypeScript (a type parameter, a union) but held untyped by the backend (`nativeType`): it may hold a view. */
function typedButHeldUntypedAnswer(checker: ts.TypeChecker, e: ts.Expression, nativeType: string): boolean {
	const t = checker.getTypeAtLocation(e),
		flags = t.flags;
	// A class's polymorphic `this` is a type parameter, but an instance of a class is always its own root.
	const held = parseNativeType(nativeType);
	return (!!(flags & ts.TypeFlags.TypeParameter) && !t.symbol?.declarations?.some(ts.isClassLike)) || (held.kind === 'any' && held.name === 'Any' && !held.implicit && !(flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Primitive)));
}

/** A call of a function value (not a declared function or method): both backends hold a `() => T` given as a `() => any` unadapted, so its result may be a view. */
function functionValueCallAnswer(e: ts.Expression, resolve: (n: ts.Node) => ts.Symbol | undefined): boolean {
	const call = ts.skipOuterExpressions(e);
	if (!ts.isCallExpression(call)) return false;
	const decls = resolve(call.expression)?.declarations;
	return !!decls?.length && !decls.some((d) => ts.isFunctionLike(d));
}

/** `e` where the backend needs a value of `target`: the value a function gives back in its result `slot`, an argument in its parameter's, a value stored in a variable or field, or an operand an observer reads. */
export function place(b: PlacementBackend, e: ts.Expression, to: string | ResultSlot | ParamSlot | StoreSlot | ObserverSlot): string {
	const code = placeIn(b, e, to);
	const made = ts.skipOuterExpressions(e);
	// A value made here is never a view.
	if (ts.isObjectLiteralExpression(made) || ts.isArrayLiteralExpression(made) || ts.isNewExpression(made)) return code;
	return b.untypedRoot && isUntyped(parseNativeType(typeof to === 'string' ? to : to.target)) ? b.untypedRoot(e, code) : code;
}

function placeIn(b: PlacementBackend, e: ts.Expression, to: string | ResultSlot | ParamSlot | StoreSlot | ObserverSlot): string {
	if (typeof to !== 'string' && to.kind === 'observer') return to.read === 'asIs' ? b.observed(e) : place(b, e, to.target);
	if (typeof to !== 'string' && to.kind === 'return') return b.result?.(e, to) ?? place(b, e, to.target);
	if (typeof to !== 'string' && to.kind === 'argument') return b.argument?.(e, to) ?? placed(b, e, to.target, to);
	const slot = typeof to === 'string' ? undefined : to;
	const target = slot ? slot.target : (to as string);
	const code = placed(b, e, target, slot);
	return b.library && ts.isVariableDeclaration(e.parent) && e.parent.initializer === e && emptyMarkers(b).has(e.parent) ? b.cells.marker(code) : code;
}

function placed(b: PlacementBackend, e: ts.Expression, target: string, slot?: ParamSlot | StoreSlot): string {
	const early = b.before?.(e, target);
	if (early != null) return early;
	const nullish = nullishPlacement(b, e, target);
	if (nullish !== null) return nullish;
	const checked = b.cells.checked(e, target, slot);
	if (checked) return checked;
	const own = b.after?.(e, target);
	if (own != null) return own;
	const to = parseNativeType(target);
	if (arrayOfStrings(to, false) && ((arrayOfStrings(parseNativeType(b.typeOf(e)), true) && b.unsetGroups(e)) || b.unsetMatch(e))) {
		throw b.error(e, "strings a pattern's unset group may leave undefined, given where `string[]` is declared (declare it `(string | undefined)[]`)");
	}
	const shortcut = b.shortcut?.(e, target);
	if (shortcut != null) return shortcut;
	// An enum's object held as a record (`const names: Record<string, string | number> = Color`): an untyped object.
	if (isKit(to, 'JSRecord') && isEnumObject(b, e)) return b.fromAnyCode(b.expr(e), target);
	// An object of a known shape held as a dictionary (`requested = mediaPerms`): a dictionary of its entries.
	if (isKit(to, 'JSRecord') && heldValue(ts.skipOuterExpressions(e)) && isShapeObject(b.checker, e)) return b.convert(b.expr(e), b.typeOf(e), target);
	// A choice one of whose branches converts a string, number or boolean's undefined, where the slot takes undefined: each
	// branch placed there, so that one keeps it.
	const choice = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	if (!b.library && takesUndefined(to) && ts.isConditionalExpression(choice) && isPrimitive(parseNativeType(b.typeOf(choice))) && [choice.whenTrue, choice.whenFalse].some((x) => b.undefinedConverted(b.coerceTyped(ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses), b.typeOf(choice))))) return b.branches(choice, target);
	const held = b.readHeld(e);
	observers.held?.(b, e, held, target);
	const rule = placement(held, into(b, target, slot), parseNativeType(b.typeOf(e)));
	if ('refuse' in rule) throw b.error(e, rule.refuse);
	// `readHeld` derives the carrier of a name or member read only; any other read's code converts itself.
	const read = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	const code = rule.rule === 'untyped' && (ts.isIdentifier(read) || ts.isPropertyAccessExpression(read)) ? b.untypedRead(b.expr(e), target, e) : b.coerceTyped(e, target);
	// A slot taking a string, number or boolean's undefined, or any value, takes it as it is, not converted.
	if (takesUndefined(to)) {
		const held = b.undefinedConverted(code) ?? (choice !== e && !b.library ? b.undefinedConverted(b.coerceTyped(choice, target)) : null);
		if (held) return held;
	}
	if (!isUntyped(to)) return code;
	const entry = b.states.nullableEntry(e, () => code);
	if (entry) return entry;
	return b.states.nilIsNull(e) && code !== 'jsNull' ? b.cells.nulled(code) : code;
}

/** A read of a field held as `JSNullish<T>` (`this.f`), which reads as `T?`. */
function nullishFieldAnswer(b: { readonly states: ValueStates; readonly ledger: Ledger }, e: ts.Node): e is ts.PropertyAccessExpression {
	return ts.isPropertyAccessExpression(e) && !isWriteTarget(e) && !!b.states.nullishRead(e);
}

/** The slot `placement` reads: `target` as the backend spells it, entered as the code placing into it reads foreign values. */
function into(b: PlacementBackend, target: string, slot?: ParamSlot | StoreSlot): Into {
	const mode = b.library ? 'library' : b.lenient ? 'lenient' : 'strict';
	return { type: parseNativeType(target), kind: slot?.kind ?? 'variable', entry: mode === 'strict' ? 'typed' : mode, mode };
}

/**
 * A value placed in or read from a `JSNullish<T>` slot (`ValueStates.nullishHeld`), which keeps null apart from
 * undefined: the B row and column of the state step. Null if neither side is one.
 */
export function nullishPlacement(b: PlacementBackend, e: ts.Expression, target: string): string | null {
	const held = b.states.nullishRead(e);
	const bare = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	const name = held && b.nullishCode(bare);
	const own = b.nullishBefore?.(e, target, held);
	if (own != null) return own;
	const to = parseNativeType(target);
	const into = to.head === 'JSNullish' && to.args.length === 1 && !to.optional && !to.implicit ? to.args[0].text : undefined;
	if (!into) {
		if (name && isUntyped(to)) return b.cells.jsAny(name);
		// A field's `T?` read where a slot holding neither null nor undefined takes it: its `T`.
		return name && ts.isPropertyAccessExpression(bare) && b.states.nullishFieldUse(bare) === 'value' && !to.optional && !to.implicit ? b.cells.present(name, bare.name.text) : null;
	}
	const slot = held && b.nullishSlotType(held);
	if (name) {
		if (slot === target) return name;
		const from = b.optionalType(slot!.slice('JSNullish<'.length, -1)),
			converted = b.convert(`${name}.optional`, from, b.optionalType(into));
		const present = to.args[0];
		return converted === `${name}.optional` || (present.kind === 'any' && present.name === 'Any' && !present.optional && !present.implicit) ? b.cells.upcast(target, name) : b.cells.type(target, into, converted);
	}
	if (bare.kind === ts.SyntaxKind.NullKeyword) return b.cells.empty(true);
	if ((ts.isIdentifier(bare) && bare.text === 'undefined') || ts.isVoidExpression(bare)) return b.cells.empty(false);
	if (ts.isConditionalExpression(bare)) return b.branches(bare, target);
	// Before the untyped case: a field narrowed to null (`x.note = null; f(x.note)`) still reads as the field holds it.
	const any = b.spelling.spell(untyped(b.spelling));
	const entry = b.states.nullishElementRead(e) ? b.coerce(e, any) : b.states.nullableEntry(e, () => b.coerceTyped(e, any));
	if (entry) return b.cells.nullishOfAny(target, into, entry, true);
	if (isUntyped(parseNativeType(b.typeOf(e)))) return b.cells.nullishOfAny(target, into, b.expr(e), false);
	const code = b.coerce(e, b.optionalType(into));
	return b.cells.nullishOf(target, into, code, b.states.nilIsNull(e));
}

/** A destructuring assignment's target that is a variable held as `JSNullish<T>` (`ValueStates.nullishHeld`): its declaration. */
function nullishTarget(b: PlacementBackend, target: ts.Expression): ts.Declaration | null {
	const x = ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses);
	const d = ts.isIdentifier(x) ? b.resolve(x)?.valueDeclaration : undefined;
	return d && b.states.nullishHeld(d) ? d : null;
}

/**
 * How a destructuring assignment reads part `key` (a property's name, an element's index) of `source` where a variable
 * held as `JSNullish<T>` takes it, so null stays apart from undefined:
 * - `keyed`: by its key, untyped;
 * - `element`: an array's element held null, undefined only past the array's end: read untyped, which tells the two apart;
 * - `null`: as typed, its empty value null (a tuple's element typed `T | null`);
 * - `undefined`: as typed, its empty value undefined.
 * Null where `target` is not such a variable.
 */
export function nullishPart(b: PlacementBackend, target: ts.Expression, at: ts.Node, source: ts.Type | null, key: string | number | null): 'keyed' | 'element' | 'null' | 'undefined' | null {
	if (!nullishTarget(b, target)) return null;
	if (typeof key === 'string') return 'keyed';
	const meets = source ? b.states.partDefault(at, source, key) : 'empty';
	return meets === 'element' ? 'element' : meets === 'never' ? 'null' : 'undefined';
}

/**
 * A value `code` (of the backend's type `from`) a destructuring assignment writes to a variable held as `JSNullish<T>`
 * (`ValueStates.nullishHeld`): converted to it, an untyped value checked, a typed one's empty value null where `nilIsNull`;
 * null for any other target.
 */
export function nullishWrite(b: PlacementBackend, target: ts.Expression, code: string, from: string, nilIsNull = false): string | null {
	const d = nullishTarget(b, target);
	if (!d) return null;
	const slot = b.nullishSlotType(d);
	if (from === slot) return code;
	const present = parseNativeType(slot).args[0];
	const into = present.text ?? b.spelling.spell(present);
	return isUntyped(parseNativeType(from)) ? b.cells.nullishOfAny(slot, into, code, true) : b.cells.nullishOf(slot, into, code, nilIsNull);
}

const MARKERS = new WeakMap<ts.TypeChecker, Set<ts.VariableDeclaration>>();
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/**
 * Core's empty markers: module constants made only to be told apart by identity (`unsetValue = new Object()`,
 * `resetSymbol = Symbol(…)`) and compared with one somewhere. Core writes one where a value is reset, typed slots
 * included (`view[name] = unsetValue`), so a checked convert reads one as an empty value, not as a value of another type.
 */
function emptyMarkersAnswer(b: Pick<PlacementBackend, 'checker' | 'sourceFiles'>): Set<ts.VariableDeclaration> {
	let found = MARKERS.get(b.checker);
	if (found) return found;
	const marks = (found = new Set());
	MARKERS.set(b.checker, marks);
	const made = (d: ts.Declaration | undefined): d is ts.VariableDeclaration => {
		if (!d || !ts.isVariableDeclaration(d) || !d.initializer || !(d.parent.flags & ts.NodeFlags.Const) || !ts.isSourceFile(d.parent.parent.parent)) return false;
		const init = ts.skipOuterExpressions(d.initializer);
		const callee = ts.isNewExpression(init) || ts.isCallExpression(init) ? init.expression : undefined;
		if (!callee || !ts.isIdentifier(callee)) return false;
		return ts.isNewExpression(init) ? callee.text === 'Object' && !init.arguments?.length : callee.text === 'Symbol';
	};
	const visit = (n: ts.Node): void => {
		if (ts.isBinaryExpression(n) && EQUALITY.has(n.operatorToken.kind)) {
			for (const side of [n.left, n.right]) {
				const x = ts.skipOuterExpressions(side);
				let sym = ts.isIdentifier(x) ? b.checker.getSymbolAtLocation(x) : undefined;
				if (sym && sym.flags & ts.SymbolFlags.Alias) sym = b.checker.getAliasedSymbol(sym);
				const d = sym?.valueDeclaration;
				if (made(d)) marks.add(d);
			}
		}
		ts.forEachChild(n, visit);
	};
	for (const f of b.sourceFiles) if (!f.isDeclarationFile) visit(f);
	return marks;
}

/** App code: an app enum named as a value (`Color`, `Shapes.Kind`), which is the object JavaScript makes of it. */
const heldValue = (e: ts.Expression) => ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e);

function isShapeObject(checker: ts.TypeChecker, e: ts.Expression): boolean {
	const t = checker.getNonNullableType(checker.getTypeAtLocation(e));
	if (!(t.flags & ts.TypeFlags.Object) || t.getStringIndexType() || !t.getProperties().length || checker.isArrayType(t) || checker.isTupleType(t) || t.getCallSignatures().length) return false;
	const decls = t.getSymbol()?.declarations ?? [];
	return decls.length > 0 && decls.every((d) => ts.isObjectLiteralExpression(d) || ts.isTypeLiteralNode(d) || ts.isInterfaceDeclaration(d));
}

function isEnumObjectAnswer(b: Pick<PlacementBackend, 'library' | 'resolve' | 'checker'>, e: ts.Expression): boolean {
	if (b.library) return false;
	const bare = ts.skipOuterExpressions(e);
	if (!ts.isIdentifier(bare) && !ts.isPropertyAccessExpression(bare)) return false;
	const sym = b.resolve(ts.isPropertyAccessExpression(bare) ? bare.name : bare);
	const decl = sym && sym.flags & ts.SymbolFlags.Alias ? b.checker.getAliasedSymbol(sym).valueDeclaration : sym?.valueDeclaration;
	return !!decl && ts.isEnumDeclaration(decl) && !decl.getSourceFile().isDeclarationFile && !hasConst(decl);
}

function hasConst(d: ts.EnumDeclaration): boolean {
	return !!ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.ConstKeyword);
}

/** A function's result as the slot its `return`s and its expression body are placed in. */
export interface ResultSlot {
	kind: 'return';
	/** The backend's spelling: in an async function or a generator, the value its continuation takes. */
	target: string;
	type: NativeType;
	/** Async and generator bodies give the value to their continuation instead of returning it. */
	lowered: boolean;
	/** The function the slot is the result of. */
	fn?: ts.SignatureDeclaration;
	/** False where what gives the value cannot throw (a synthesized getter or initializer): a conversion's TypeError is reported there, the value empty. */
	throws?: false;
}

/** The result slot of a function giving back `target`. */
export function resultSlot(target: string, fn?: ts.SignatureDeclaration, lowered = false): ResultSlot {
	return { kind: 'return', target, type: parseNativeType(target ?? ''), lowered, fn };
}

/** A parameter as the slot a call's argument is placed in, as the backend has the parameter at that call. */
export interface ParamSlot {
	kind: 'argument';
	/** The backend's spelling of the parameter's type at the call. */
	target: string;
	type: NativeType;
	/** The parameter; none past the declared ones. */
	decl?: ts.Declaration;
	/** Held `JSNullish<T>` (`ValueStates.nullishHeld`): the value placed in it, no other cell. */
	nullish?: boolean;
	/** Takes a missing value as it is: an argument the backend holds optional is given as that optional; `declared` is the parameter's type before it was made optional. */
	asIs?: { declared: string };
	/** Kotlin: the parameter's default is a constant its declaration has, which a possibly missing argument falls back to. */
	constantDefault?: boolean;
	/** Kotlin: a package's parameter called from outside the package, its type as the package declares it. */
	packaged?: boolean;
	/** How the argument comes in; `checked` where it is: the form its untyped value enters as (`ValueStates.foreignArgument`). */
	entry: Entry;
	checked?: Form;
	/** An element of a rest parameter's array, an argument past the declared parameters or to an untyped callee: no declared parameter's cell. */
	rest?: boolean;
	/**
	 * A parameter the call leaves out, given as `empty` (a function value takes every parameter: the slot's empty value) or
	 * as `undefined` reads in the slot's type (a required parameter of an app function).
	 */
	missing?: 'empty' | 'undefined';
	/** A native API's parameter (`.d.ts`): the backend's conversion to the native type `target` names, no other cell. */
	native?: NativeParam;
}

/** What a native parameter's conversion reads besides its type: Kotlin's `target` is the Java descriptor, with the nullness and generic signature the class file gives. */
export interface NativeParam {
	nullable?: boolean;
	nonNull?: boolean;
	signature?: string;
	typeVar?: (name: string) => string;
}

type SlotFacts = Pick<ParamSlot, 'nullish' | 'asIs' | 'constantDefault' | 'packaged' | 'rest' | 'missing' | 'native'>;

/** The slot of a parameter the backend has as `target` at the call `at`, taking its `k`th argument `a` (none where the call leaves it out or a spread gives it). */
export function argumentSlot(b: Pick<PlacementBackend, 'library' | 'lenient' | 'states'>, target: string, decl: ts.Declaration | undefined, at: { call: ts.CallExpression | ts.NewExpression; k: number; a?: ts.Expression }, facts: SlotFacts = {}): ParamSlot {
	return { kind: 'argument', target, type: parseNativeType(target), decl, ...argumentEntry(b, at.call, at.k, at.a), ...facts };
}

/** How the `k`th argument `a` of `call` comes in, as its slot has it (`argumentSlot`). */
function argumentEntryAnswer(b: Pick<PlacementBackend, 'library' | 'lenient' | 'states'>, call: ts.CallExpression | ts.NewExpression, k: number, a?: ts.Expression): Pick<ParamSlot, 'entry' | 'checked'> {
	let checked: Form | null = null;
	// A value the forms throw on enters unchecked.
	try {
		checked = a ? b.states.foreignArgument(call, k, a) : null;
	} catch (e) {
		rethrowUnlessRefused(e);
		checked = null;
	}
	return checked ? { entry: 'checked', checked } : { entry: b.library ? 'library' : b.lenient ? 'lenient' : 'typed' };
}

/** The call `a` is an argument of, past parentheses, and its position there; null where `a` is no call's argument. */
export function argumentOf(a: ts.Expression): { call: ts.CallExpression | ts.NewExpression; k: number } | null {
	let x: ts.Node = a;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	return (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== x ? { call: p, k: p.arguments!.indexOf(x as ts.Expression) } : null;
}

/**
 * Where a value is stored: a variable's declaration, a class's or a shape's field, an object literal's field (`{ a }`
 * too), a parameter (its default), an assignment's target (a variable, a member, an element), a signal's write
 * (`s.set(v)`), or a container's element (`ElementStore`).
 */
export type Store = ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertySignature | ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.ParameterDeclaration | ts.BindingElement | ts.Expression;

/** What stores its arguments or its elements as a container's elements: an array literal, or a call adding to an array, Set or Map. */
export type ElementStore = ts.CallExpression | ts.ArrayLiteralExpression;

/** A variable, a field, an object literal's field or a container's element as the slot a value is stored in. */
export interface StoreSlot {
	kind: 'variable' | 'field' | 'literalField' | 'element';
	/** The backend's spelling of the slot's type where the value is stored. */
	target: string;
	type: NativeType;
	/** The declaration or the assignment's target the value is stored by. */
	at: Store;
	/** How the value comes in; `checked` where it is: the form its untyped value enters as (`ValueStates.foreignStore`). */
	entry: Entry;
	checked?: Form;
}

/**
 * The slot `a` is stored in by `at`, the backend having it as `target`. `checks` false: a value the store does not give
 * as it is (a compound assignment's operand, a signal's `set`), which enters unchecked.
 */
export function storeSlot(b: Pick<PlacementBackend, 'library' | 'lenient' | 'states'>, target: string, at: Store, a: ts.Expression, checks = true): StoreSlot {
	return { kind: storeKind(b.states.backend.checker, at), target, type: parseNativeType(target), at, ...storeEntry(b, at, a, checks) };
}

/**
 * The slot of a field (`at`, its declaration) a value only the backend's code has is stored in, untyped (a dynamic
 * setter's `newValue`), the backend having it as `target`; no `at` where the backend's field has no one declaration.
 */
export function codeStoreSlot(b: Pick<PlacementBackend, 'library' | 'lenient' | 'states'>, target: string, at?: ts.PropertyDeclaration | ts.PropertySignature | ts.PropertyAssignment): StoreSlot | null {
	if (!at) return null;
	const checked = b.states.foreignCodeStore(at);
	return { kind: storeKind(b.states.backend.checker, at), target, type: parseNativeType(target), at, ...(checked ? { entry: 'checked', checked } : { entry: b.library ? 'library' : b.lenient ? 'lenient' : 'typed' }) };
}

/** An untyped value only the backend's code has (`code`), stored in `slot`: its checked cell where the slot's entry is checked, else null for the backend's own conversion. */
export function placeCode(b: PlacementBackend, code: string, slot: StoreSlot | null): string | null {
	return slot?.entry === 'checked' ? b.cells.checkedCode(code, slot) : null;
}

/**
 * The slot a destructuring pattern's part is bound or assigned to (`at`: a binding element, or the target of a
 * destructuring assignment or of a `for…of` over existing variables), the backend having it as `target`, its value only
 * the backend's code has, read untyped from the pattern's value (`ValueStates.foreignBinding`).
 */
export function bindingSlot(b: Pick<PlacementBackend, 'library' | 'lenient' | 'states'>, target: string, at: ts.BindingElement | ts.Expression): StoreSlot {
	const checked = b.states.foreignBinding(at);
	return { kind: storeKind(b.states.backend.checker, at), target, type: parseNativeType(target), at, ...(checked ? { entry: 'checked', checked } : { entry: b.library ? 'library' : b.lenient ? 'lenient' : 'typed' }) };
}

/**
 * The value a destructuring pattern's part `at` takes apart, past nested patterns and defaults: a variable's
 * initializer (`declaration`), an assignment's right side, or a `for…of`'s iterated value (`iterated`). Null for a
 * parameter's pattern, or where `at` is no pattern's part.
 */
export function patternSource(at: ts.BindingElement | ts.Expression): { whole: ts.Expression; iterated: boolean; declaration?: ts.VariableDeclaration } | null {
	if (ts.isBindingElement(at)) {
		let holder: ts.Node = at.parent.parent;
		while (ts.isBindingElement(holder)) holder = holder.parent.parent;
		if (!ts.isVariableDeclaration(holder)) return null;
		const loop = holder.parent.parent;
		if (ts.isForOfStatement(loop) && loop.initializer === holder.parent) return { whole: loop.expression, iterated: true, declaration: holder };
		return holder.initializer ? { whole: holder.initializer, iterated: false, declaration: holder } : null;
	}
	let x: ts.Node = at,
		part = false;
	for (;;) {
		const p: ts.Node = x.parent;
		if (ts.isForOfStatement(p) && p.initializer === x) return { whole: p.expression, iterated: true };
		if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === x) {
			if (ts.isArrayLiteralExpression(p.parent) || (ts.isPropertyAssignment(p.parent) && p.parent.initializer === p)) {
				x = p;
				continue;
			}
			return part ? { whole: p.right, iterated: false } : null;
		}
		if (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)) part = true;
		else if (!(ts.isParenthesizedExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === x) || (ts.isShorthandPropertyAssignment(p) && p.name === x))) return null;
		x = p;
	}
}

/** The variables and members a destructuring assignment's pattern (or a `for…of`'s target) writes, past nested patterns and defaults. */
export function patternTargets(pattern: ts.Expression): ts.Expression[] {
	const x = ts.skipOuterExpressions(pattern, ts.OuterExpressionKinds.Parentheses);
	if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken) return patternTargets(x.left);
	if (ts.isSpreadElement(x)) return patternTargets(x.expression);
	if (ts.isArrayLiteralExpression(x)) return x.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : patternTargets(e)));
	if (ts.isObjectLiteralExpression(x)) {
		return x.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? patternTargets(p.initializer) : ts.isShorthandPropertyAssignment(p) ? [p.name] : ts.isSpreadAssignment(p) ? patternTargets(p.expression) : []));
	}
	return [x];
}

/** How `a`, stored by `at`, comes in, as its slot has it (`storeSlot`). */
function storeEntryAnswer(b: Pick<PlacementBackend, 'library' | 'lenient' | 'states'>, at: Store, a: ts.Expression, checks = true): Pick<StoreSlot, 'entry' | 'checked'> {
	let checked: Form | null = null;
	// A value the forms throw on enters unchecked.
	try {
		checked = checks ? b.states.foreignStore(at, a) : null;
	} catch (e) {
		rethrowUnlessRefused(e);
		checked = null;
	}
	return checked ? { entry: 'checked', checked } : { entry: b.library ? 'library' : b.lenient ? 'lenient' : 'typed' };
}

function storeKind(checker: ts.TypeChecker, at: Store): StoreSlot['kind'] {
	if (isElementStore(checker, at)) return 'element';
	if (ts.isVariableDeclaration(at) || ts.isParameter(at) || ts.isBindingElement(at)) return 'variable';
	if (ts.isPropertyDeclaration(at) || ts.isPropertySignature(at) || ts.isCallExpression(at)) return 'field';
	if (ts.isPropertyAssignment(at) || ts.isShorthandPropertyAssignment(at)) return 'literalField';
	const target = ts.skipOuterExpressions(at, ts.OuterExpressionKinds.Parentheses);
	return ts.isIdentifier(target) ? 'variable' : ts.isElementAccessExpression(target) ? 'element' : 'field';
}

const STORING = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);

/**
 * The store `a` is the value of, past parentheses and the branches of a conditional: a variable's or a field's
 * initializer, an object literal's field (`{ a }` too), the right side of an assignment (`=`, `??=`, `||=`, `&&=`).
 * Null where `a` is none.
 */
function storeOfAnswer(a: ts.Expression): Store | null {
	let x: ts.Node = a;
	while (ts.isParenthesizedExpression(x.parent) || (ts.isConditionalExpression(x.parent) && x.parent.condition !== x)) x = x.parent;
	const p = x.parent;
	if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === x) return p;
	if (ts.isShorthandPropertyAssignment(p) && p.name === x) return p;
	return ts.isBinaryExpression(p) && STORING.has(p.operatorToken.kind) && p.right === x ? p.left : null;
}

/**
 * The array literal or call that stores `a`, past parentheses, as an element of a container: the literal's element,
 * `push`/`unshift`'s arguments, `splice`'s items, `fill`'s value, a Set's `add` or a Map's `set` value. Null where `a`
 * is none.
 */
function elementStoreOfAnswer(checker: ts.TypeChecker, a: ts.Expression): ElementStore | null {
	let x: ts.Node = a;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	if (ts.isArrayLiteralExpression(p)) return p;
	if (!ts.isCallExpression(p) || p.expression === x || !ts.isPropertyAccessExpression(p.expression)) return null;
	const k = p.arguments.indexOf(x as ts.Expression),
		method = p.expression.name.text;
	const kind = containerKind(checker, p.expression.expression);
	const stores = kind === 'Array' ? method === 'push' || method === 'unshift' || (method === 'splice' && k >= 2) || (method === 'fill' && k === 0) : kind === 'Set' ? method === 'add' && k === 0 : kind === 'Map' && method === 'set' && k === 1;
	return stores ? p : null;
}

/** Whether `at` is a container's store (`elementStoreOf`), not a signal's write (`s.set(v)`), which is a call too. */
function isElementStoreAnswer(checker: ts.TypeChecker, at: Store): at is ElementStore {
	return ts.isArrayLiteralExpression(at) || (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && !!containerKind(checker, at.expression.expression));
}

/** Whether `e` is an array, a Set or a Map, by its type. */
function containerKindAnswer(checker: ts.TypeChecker, e: ts.Expression): 'Array' | 'Set' | 'Map' | null {
	const t = checker.getNonNullableType(checker.getTypeAtLocation(e));
	if (checker.isArrayType(t)) return 'Array';
	const kind = t.getSymbol()?.name;
	return kind === 'Set' || kind === 'Map' ? kind : null;
}

/** Whether `a` is the value an assignment stores in `left` as it is (`storeOf`): a compound assignment's operand, or one of an assignment the translation made from another, is not. */
function assignedToAnswer(left: ts.Expression, a: ts.Expression): boolean {
	return storeOf(a) === left;
}

/** One cell of a `return`-kind slot. */
export type ReturnCell =
	/** No value (`return;`), or a missing value the slot reads as its empty: `code` is what is returned ('' for nothing). */
	| { step: 'empty'; code: string; e?: ts.Expression }
	/** A value where the slot holds nothing: evaluated, then nothing returned. */
	| { step: 'drop'; e: ts.Expression }
	/** A call that never returns: the statement's end itself. */
	| { step: 'never'; e: ts.Expression }
	/** A value giving nothing (a void call) where the slot holds one: evaluated, then `empty`. */
	| { step: 'voidCall'; e: ts.Expression; empty: string }
	/** The value placed in the slot; `code` where the backend's own step placed it already. */
	| { step: 'value'; e: ts.Expression; code?: string };

/** What `returnCell` reads of a translator. */
export interface ReturnBackend {
	typeOf(n: ts.Node): string;
	/**
	 * What a missing value (`e`: a nullish literal; none: `return;`) returns in `slot` where the backend reads it as the
	 * slot's empty (lenient code's zeros; '' for nothing), or null where it is placed as a value (in a slot holding
	 * nothing: evaluated). With no `e`, always an answer.
	 */
	emptyReturn(e: ts.Expression | undefined, slot: ResultSlot): string | null;
	/** The value `e`, giving nothing (a void call), leaves in `slot`, or null where it is placed as a value. */
	voidValue(e: ts.Expression, slot: ResultSlot, body: boolean): string | null;
	/** The backend's own cells before the shared ones. */
	returnBefore?(e: ts.Expression, slot: ResultSlot): ReturnCell | null;
}

/** `e` given back from a function whose result is `slot`: by a `return` statement, or as an arrow's expression `body`. */
export function returnCell(b: ReturnBackend, e: ts.Expression | undefined, slot: ResultSlot, body = false): ReturnCell {
	if (!e) return { step: 'empty', code: slot.lowered ? '' : (b.emptyReturn(undefined, slot) ?? '') };
	if (slot.lowered) return isNullishLiteral(e) && !voidOperand(e) && emptyInto(slot.type) === 'unit' ? { step: 'empty', code: '' } : { step: 'value', e };
	const own = b.returnBefore?.(e, slot);
	if (own) return own;
	const given = parseNativeType(b.typeOf(e));
	const plain = !given.optional && !given.implicit;
	const call = ts.isCallExpression(e);
	if (!body && call && plain && given.kind === 'never') return { step: 'never', e };
	const effect = voidOperand(e);
	if (slot.type.kind === 'void' && !slot.type.optional) {
		if (effect) return { step: 'drop', e: effect };
		const code = isNullishLiteral(e) ? b.emptyReturn(e, slot) : null;
		return code !== null ? { step: 'empty', code, e } : { step: 'drop', e };
	}
	if (plain && given.kind === 'void') {
		const empty = b.voidValue(e, slot, body);
		if (empty) return { step: 'voidCall', e, empty };
	}
	if (!body && isNullishLiteral(e)) {
		const code = b.emptyReturn(e, slot);
		if (code !== null) return effect ? { step: 'voidCall', e: effect, empty: code } : { step: 'empty', code, e };
	}
	return { step: 'value', e };
}

/** `null`, `undefined` or `void x`, parenthesized or not. */
function isNullishLiteralAnswer(e: ts.Expression): boolean {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e);
}

/** The operand of `void x` where evaluating it may do something (not a literal or a name), else null. */
function voidOperand(e: ts.Expression): ts.Expression | null {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	if (!ts.isVoidExpression(e)) return null;
	let x: ts.Expression = e.expression;
	while (ts.isParenthesizedExpression(x)) x = x.expression;
	return ts.isLiteralExpression(x) || ts.isIdentifier(x) ? null : e.expression;
}

/**
 * A member read's, call's or index's receiver as the slot it is placed in (`kind: 'receiver'`): present where the
 * read needs it (U → P). `x` is `target` past its parentheses; `chained` where the read is `?.` of it.
 */
export interface ReceiverSlot {
	kind: 'receiver';
	target: ts.Expression;
	x: ts.Expression;
	key: string;
	chained: boolean;
}

/** The receiver slot of the read of `key` that `target` is the receiver of. */
export function receiverSlot(target: ts.Expression, key: string): ReceiverSlot {
	let x = target;
	while (ts.isParenthesizedExpression(x)) x = x.expression;
	const access = target.parent;
	const chained = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && !!access.questionDotToken;
	return { kind: 'receiver', target, x, key, chained };
}

/** One cell of a `receiver`-kind slot. */
export type ReceiverCell =
	/** Read as the access reads it. */
	| { cell: 'asIs' }
	/** `code`, the receiver as it is held, made present: JavaScript's TypeError naming the key where it is missing (`isNull`: it is null there). */
	| { cell: 'present'; code: string; isNull: boolean }
	/**
	 * Inside an optional chain (`a?.[0].name`, `o?.x!.y`): undefined where `guard`, the value the chain's nearest `?.`
	 * tests, is nullish; else `receiver`'s value made present as for `present`.
	 */
	| { cell: 'chained'; guard: ts.Expression; receiver: ts.Expression; isNull: boolean };

/** The receiver cell of what the await `a` gives: its held value, JavaScript's TypeError where it gives nothing. */
export function awaitedCell(a: AwaitSlot): ReceiverCell {
	return { cell: 'present', code: a.raw, isNull: a.isNull };
}

/** What `receiverCell` reads of a translator. */
export interface ReceiverBackend {
	readonly checker: ts.TypeChecker;
	readonly states: ValueStates;
	expr(e: ts.Expression): string;
	/** The value as it is held where it may be the program's own missing value, else null. */
	maybeUndefined(e: ts.Expression): string | null;
	awaited(e: ts.Expression): AwaitSlot | undefined;
	/** A receiver the backend holds optional though its type says present, read as it is held; null where it holds it present. */
	held(x: ts.Expression): string | null;
	/** An untyped value asserted to a type, which the assertion leaves empty where it is (`Front.assertedUntyped`). */
	assertedUntyped(e: ts.Expression): ts.Expression | null;
	/** The backend's own cells before the shared ones. */
	receiverBefore?(slot: ReceiverSlot): ReceiverCell | null;
}

/**
 * `slot`'s cell: an await's held value; a receiver its type lets through though it can be missing (`unsafeReceiver`:
 * `x!`, an array's object element) or the program may leave missing at this read (`missingAtRead`), read as it is
 * held; else as it is.
 */
export function receiverCell(b: ReceiverBackend, slot: ReceiverSlot): ReceiverCell {
	const own = b.receiverBefore?.(slot);
	if (own) return own;
	const { target, x, chained } = slot;
	const awaited = chained ? undefined : b.awaited(x);
	if (awaited) return awaitedCell(awaited);
	const kind = unsafeReceiver(target, b.checker) ?? (chained ? null : (b.states.missingAtRead(target) ?? (assertedArray(b, x) ? 'undefined' : null)));
	if (kind && ts.isOptionalChain(x)) return chained ? { cell: 'asIs' } : { cell: 'chained', guard: chainGuard(x), receiver: ts.isNonNullExpression(x) ? x.expression : x, isNull: kind === 'null' };
	const code = !kind ? null : ts.isNonNullExpression(x) ? (b.maybeUndefined(x.expression) ?? b.expr(x.expression)) : (b.maybeUndefined(x) ?? b.held(x));
	return code ? { cell: 'present', code, isNull: kind === 'null' } : { cell: 'asIs' };
}

/** The value an optional chain link's nearest `?.` (at `x` or before it) tests. */
function chainGuard(x: ts.Expression): ts.Expression {
	let n = x;
	while (!((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) && n.questionDotToken)) n = (n as ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression | ts.NonNullExpression).expression;
	return n.expression;
}

/** An untyped value asserted to an array, which the assertion leaves empty where it is (an assertion to any other type is checked). */
function assertedArray(b: ReceiverBackend, x: ts.Expression): boolean {
	return !!b.assertedUntyped(x) && b.checker.isArrayType(b.checker.getNonNullableType(b.checker.getTypeAtLocation(x)));
}

/**
 * The receiver cell of an untyped value asserted to an array, read by an element (`(match as string[])[0]`) or a
 * method: JavaScript's TypeError where it is missing. Any other receiver is read as the backend holds it.
 */
export function assertedReceiverCell(b: ReceiverBackend, target: ts.Expression, key: string): ReceiverCell {
	const read = ts.walkUpParenthesizedExpressions(target.parent);
	if (((ts.isElementAccessExpression(read) || ts.isPropertyAccessExpression(read)) && (read.questionDotToken || isWriteTarget(read))) || !assertedArray(b, ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses))) return { cell: 'asIs' };
	return receiverCell(b, receiverSlot(target, key));
}

/** An element read's receiver cell (`assertedReceiverCell` or `unsafeReceiver`). */
export function elementReceiverCell(b: ReceiverBackend, e: ts.ElementAccessExpression): ReceiverCell {
	if (ts.isOptionalChain(e)) return { cell: 'asIs' };
	const key = keyName(e.argumentExpression);
	const asserted = assertedReceiverCell(b, e.expression, key);
	if (asserted.cell !== 'asIs') return asserted;
	return unsafeReceiver(e.expression, b.checker) ? receiverCell(b, receiverSlot(e.expression, key)) : { cell: 'asIs' };
}

/** The name a TypeError reading by `key` gives: a literal key's text, else the key's source. */
export function keyName(key: ts.Expression): string {
	return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : key.getText();
}

/**
 * The value an `await` resumes its continuation with (`kind: 'await'`), where the promise may resolve with nothing its
 * type has (a non-strict app's async call): held optional as `raw`, the continuation's parameter. Reads of the await
 * place that held value (U), so a member read of it is JavaScript's TypeError where nothing came.
 */
export interface AwaitSlot {
	kind: 'await';
	/** The continuation parameter's type: the optional of the await's type. */
	target: string;
	type: NativeType;
	a: ts.AwaitExpression;
	raw: string;
	/** The async function gives only null where it gives nothing (`nullResult`): its empty is null, not undefined. */
	isNull: boolean;
}

/** `a`'s await slot where its operand is a non-strict app's async call (`lenientAsyncCall`) of a type `holds`, else null. */
export function awaitSlot(b: Pick<PlacementBackend, 'states' | 'typeOf' | 'optionalType'>, a: ts.AwaitExpression, raw: string, holds: (type: string) => boolean): AwaitSlot | null {
	if (!b.states.lenientAsyncCall(a.expression)) return null;
	const type = b.typeOf(a);
	if (!holds(type)) return null;
	const target = b.optionalType(type);
	return { kind: 'await', target, type: parseNativeType(target), a, raw, isNull: b.states.nullResult(a) };
}

/**
 * How a value's truthiness is tested where the backend needs its boolean: the cells of a `condition`-kind slot
 * (`SlotKind`), an `if`'s, a loop's or a conditional's test, and the operands of `!`, `&&` and `||` so tested.
 * Operands are tested in their own condition slot, each decided as the backend spells the one before.
 */
export type ConditionCell =
	/** The types decide it: nothing is evaluated. */
	| { step: 'fixed'; value: boolean }
	/** `a && b`, `a || b` of operands not both booleans: whether both (either) are truthy. */
	| { step: 'logical'; e: ts.BinaryExpression; and: boolean }
	/** `!a`: `a` tested, negated. */
	| { step: 'not'; e: ts.Expression }
	/** A read that may be missing (`maybeUndefined`), tested as the value it stands for: `code` is that read. */
	| { step: 'missing'; e: ts.Expression; code: string }
	/** A boolean, read as it is. */
	| { step: 'bool'; e: ts.Expression }
	/** Any other value: the backend's truthiness test of it. */
	| { step: 'value'; e: ts.Expression };

/** What `conditionCell` reads of a translator. */
export interface ConditionBackend {
	isBool(n: ts.Node): boolean;
	maybeUndefined(e: ts.Expression): string | null;
	/** The truth a whole condition always has where the types decide it, spelled as that truth; absent where the backend tests it anyway. */
	fixed?(e: ts.Expression): boolean | undefined;
	/** Of `a && b` or `a || b`, the operand whose truth alone is the condition's where the other's is decided, or null. */
	decided(e: ts.BinaryExpression): ts.Expression | null;
	/** The operators are looked for inside parentheses, and `!a` is a test of `a` (without: `!a` is a boolean value). */
	readonly bare: boolean;
}

/** `e` tested for its truthiness. */
export function conditionCell(b: ConditionBackend, e: ts.Expression): ConditionCell {
	const fixed = b.fixed?.(e);
	if (fixed !== undefined) return { step: 'fixed', value: fixed };
	let x = e;
	while (b.bare && ts.isParenthesizedExpression(x)) x = x.expression;
	if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
		const one = b.decided(x);
		if (one) return conditionCell(b, one);
		if (!(b.isBool(x.left) && b.isBool(x.right))) return { step: 'logical', e: x, and: x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken };
	}
	if (b.bare && ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) return { step: 'not', e: x.operand };
	const code = b.maybeUndefined(e);
	if (code) return { step: 'missing', e, code };
	return b.isBool(e) ? { step: 'bool', e } : { step: 'value', e };
}

/** The operand of `!`: a boolean that cannot be missing is read as it is, anything else tested. */
export function negatedCell(b: ConditionBackend, e: ts.Expression): ConditionCell {
	return b.isBool(e) && !b.maybeUndefined(e) ? { step: 'bool', e } : conditionCell(b, e);
}

/**
 * An operand an observer reads (`ValueStates.observedAsIs`: an equality's or `typeof`'s), as JavaScript takes it,
 * missing or not (`kind: 'observer'`). `untyped`: placed as a script value; `asIs`: the optional the backend holds it
 * as, never unwrapped nor required present (`PlacementBackend.observed`).
 */
export interface ObserverSlot {
	kind: 'observer';
	target: string;
	type: NativeType;
	read: 'untyped' | 'asIs';
}

export function observerSlot(b: Pick<PlacementBackend, 'spelling'>, read: ObserverSlot['read'] = 'untyped'): ObserverSlot {
	if (read === 'asIs') return { kind: 'observer', target: '', type: parseNativeType(''), read };
	const type = untyped(b.spelling);
	return { kind: 'observer', target: b.spelling.spell(type), type, read };
}

/** The cell of an equality or identity comparison the shared front decides; null where the backend's own cells decide. */
export type EqualityCell =
	/** A value whose null and undefined differ, compared strictly with one of them (`isNull`): as script values. */
	| { cell: 'empty'; x: ts.Expression; isNull: boolean }
	/** Loosely with null or undefined, a value of no one present type: whether it is either. */
	| { cell: 'nullish'; x: ts.Expression }
	/** Operands of different present types, or one untyped or generic: compared as script values. */
	| { cell: 'script' }
	/**
	 * A name held untyped whose read the checker narrows to a string, number or boolean, compared with null or undefined
	 * (`strict`, `isNull`): its stored value, which code unchecked for null may leave empty where its type says present.
	 */
	| { cell: 'stored'; x: ts.Identifier; strict: boolean; isNull: boolean };

const literalEmpty = (x: ts.Expression) => x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');

/** `e`'s comparison with null or undefined where the value tells them apart, which comes before the backend's own reads of a missing value. */
function emptyComparisonAnswer(b: Pick<PlacementBackend, 'states' | 'typeOf'>, e: ts.BinaryExpression): EqualityCell | null {
	const stored = storedComparisonOf(b, e);
	if (stored) return stored;
	const K = ts.SyntaxKind,
		op = e.operatorToken.kind;
	if ((op !== K.EqualsEqualsEqualsToken && op !== K.ExclamationEqualsEqualsToken) || literalEmpty(e.left) === literalEmpty(e.right)) return null;
	const [x, n] = literalEmpty(e.right) ? [e.left, e.right] : [e.right, e.left];
	const isNull = n.kind === K.NullKeyword,
		s = b.states;
	if (!isNull ? s.nullDistinct(x) : s.nullishRead(x) || s.nullishElementRead(x) || s.nulledRead(x)) return { cell: 'empty', x, isNull };
	return isNull && s.nilIsUndefined(x) ? { cell: 'empty', x, isNull } : null;
}

/** A name held untyped that the checker narrows to a string, number or boolean, compared with null or undefined (`EqualityCell` `stored`). */
function storedComparisonOf(b: Pick<PlacementBackend, 'states' | 'typeOf'>, e: ts.BinaryExpression): EqualityCell | null {
	const K = ts.SyntaxKind,
		op = e.operatorToken.kind;
	if (![K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(op) || literalEmpty(e.left) === literalEmpty(e.right)) return null;
	const [side, n] = literalEmpty(e.right) ? [e.left, e.right] : [e.right, e.left];
	const x = ts.skipOuterExpressions(side, ts.OuterExpressionKinds.Parentheses);
	if (!ts.isIdentifier(x) || isWriteTarget(x) || !isPrimitive(parseNativeType(b.typeOf(x))) || b.states.heldType(x).rep !== 'foreign') return null;
	return { cell: 'stored', x, strict: op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken, isNull: n.kind === K.NullKeyword };
}

/** The operand of a `stored` comparison: read as it is held, never converted to the type the checker narrows it to. */
export function storedOperand(b: Pick<PlacementBackend, 'states' | 'typeOf'>, x: ts.Expression): boolean {
	if (!ts.isIdentifier(x)) return false;
	let n: ts.Node = x;
	while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
	const c = ts.isBinaryExpression(n.parent) ? storedComparisonOf(b, n.parent) : null;
	return c?.cell === 'stored' && c.x === x;
}

/** The value a type assertion of another type asserts (`xs as unknown as string`: `xs`), which a comparison compares as it is. */
function assertedFromAnswer(b: Pick<PlacementBackend, 'typeOf'>, x: ts.Expression): ts.Expression | null {
	let inner = x,
		crossed = false;
	for (;;) {
		if (ts.isParenthesizedExpression(inner)) inner = inner.expression;
		else if (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
			inner = inner.expression;
			crossed = true;
		} else break;
	}
	return crossed && !sameType(parseNativeType(b.typeOf(inner)), parseNativeType(b.typeOf(x))) ? inner : null;
}

/** `e`'s comparison as script values where its operands' present types differ (`generic`: a type parameter's), once neither is tested for emptiness on its own. */
export function scriptComparison(b: Pick<PlacementBackend, 'typeOf'>, e: ts.BinaryExpression, generic: (x: ts.Expression, type: string) => boolean): EqualityCell | null {
	const K = ts.SyntaxKind,
		op = e.operatorToken.kind,
		[a, c] = [e.left, e.right];
	if (assertedFrom(b, a) || assertedFrom(b, c)) return { cell: 'script' };
	const [lt, rt] = [b.typeOf(a), b.typeOf(c)];
	const [lh, rh] = [parseNativeType(lt), parseNativeType(rt)];
	if (!(isUntyped(lh) || isUntyped(rh) || generic(a, lt) || generic(c, rt) || (!sameType(lh, rh) && !sameType(withoutOptional(lh), withoutOptional(rh))))) return null;
	const strict = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken;
	return !strict && (literalEmpty(a) || literalEmpty(c)) ? { cell: 'nullish', x: literalEmpty(a) ? c : a } : { cell: 'script' };
}

/** The answers above, recorded by the decision trace (`NS_DECISION_TRACE`). */
export const { untypedContext, typedButHeldUntyped, functionValueCall, nullishField, emptyMarkers, isEnumObject, argumentEntry, storeEntry, storeOf, elementStoreOf, isElementStore, containerKind, assignedTo, isNullishLiteral, emptyComparison, assertedFrom } = traceMethods('placement', {
	untypedContext: untypedContextAnswer,
	typedButHeldUntyped: typedButHeldUntypedAnswer,
	functionValueCall: functionValueCallAnswer,
	nullishField: nullishFieldAnswer,
	emptyMarkers: emptyMarkersAnswer,
	isEnumObject: isEnumObjectAnswer,
	argumentEntry: argumentEntryAnswer,
	storeEntry: storeEntryAnswer,
	storeOf: storeOfAnswer,
	elementStoreOf: elementStoreOfAnswer,
	isElementStore: isElementStoreAnswer,
	containerKind: containerKindAnswer,
	assignedTo: assignedToAnswer,
	isNullishLiteral: isNullishLiteralAnswer,
	emptyComparison: emptyComparisonAnswer,
	assertedFrom: assertedFromAnswer,
});
