import ts from 'typescript';
import { A, F, G, H, M, N, O, U, declarationFile, elementType, isGeneric, isRecord, type Flow, type Owner, type Part, type Slot } from './flow.ts';
import type { FrameworkModel, SignalKind } from '../../api/adapter-api.ts';
import { unionFindMethods, type UnionFindMethods } from './union-find.ts';
import { placementsMethods, type PlacementsMethods } from './placements.ts';
import { observersMethods, type ObserversMethods } from './observers.ts';
import { resultsMethods, type ResultsMethods } from './results.ts';
import { traceAnalysis } from '../decision-trace.ts';
import { byNameCallsMethods, type ByNameCallsMethods } from './by-name.ts';
import { placeCallsMethods, type PlaceCallsMethods } from './place-calls.ts';
import { openMethods, type OpenMethods } from './open.ts';

// One value form per slot: which of JavaScript's empty states a slot may hold, decided
// by one program-wide flow over every place a value is put, for both translators.

/** A slot's value form: its present type and the states beside it a native form must also hold. */
export interface Form {
	/** The present value's type, null and undefined removed. */
	type: ts.Type;
	undefined: boolean;
	null: boolean;
	/** An array element that may be a hole. */
	hole: boolean;
	/** May hold a value of another type than `type` (untyped, asserted, JSON). */
	foreign: boolean;
	/**
	 * Its undefined may be a value the program leaves out: an argument not given, an optional parameter without a default,
	 * a read past an array's or string's end, a hole. Undefined an outside caller gives (an entry point) is not missing.
	 */
	missing: boolean;
	/**
	 * Its null or undefined may be a value the program reads and finds missing: an element past an array's end, a
	 * character past a string's, `find`/`pop`/`shift`/`at`, `Map.get`, a record's entry, a match's group, or an empty
	 * value a function returns (`return null`, a bare `return`, its end). Empty states a library's or platform's value
	 * brings, an optional parameter's and an argument not given are not.
	 */
	absent: boolean;
	/**
	 * Its null or undefined may be one the program's own code gives: a null or undefined it writes, an argument it leaves
	 * out, a variable or field it declares and never writes, or an absent value. An entry point's caller, a template's
	 * glue and a field read before its first write give none.
	 */
	given: boolean;
	/**
	 * Its undefined may be one the program's types leave room for: an optional member's (`tzid?: string`) its objects
	 * leave out, or one a caller holding the function untyped gives. Not an entry point's whose caller is typed (a
	 * platform's, a library's, a template's glue).
	 */
	untyped: boolean;
	/**
	 * Something its value reaches tells its null from its undefined. A form holding both that isn't observed
	 * holds one empty state, read as undefined.
	 */
	observed: boolean;
	/**
	 * Something its value reaches tests the value's type: `typeof`, `instanceof`, `Array.isArray`, `in`. A
	 * foreign form that isn't keeps its declared representation, the foreign value checked where it enters.
	 */
	typeObserved: boolean;
	/** An array's or Set's element, a Map's value, a Promise's result. */
	element?: Form;
}

/** How a backend holds a form (the design's five representations). */
export type Representation = 'present' | 'undefined' | 'null' | 'nullish' | 'foreign';

export function representation(f: Form): Representation {
	if (f.foreign) return 'foreign';
	if (f.undefined && f.null) return f.observed ? 'nullish' : 'undefined';
	return f.null ? 'null' : f.undefined ? 'undefined' : 'present';
}

export interface FormsOptions {
	/** A library (core) is called by programs this one doesn't contain: its exported and public surface is an entry point. */
	library?: boolean;
	/** Whether a declaration file's declaration is a platform's: a class extending one is called by the platform. */
	native?: (d: ts.Declaration) => boolean;
	/**
	 * Whether a platform declaration's binding holds nil, which script sees as null: a property's value, a method's result,
	 * a parameter's argument, a callback parameter's value. The backend's binding knows; the typings don't say.
	 */
	nativeNil?: (d: ts.Declaration) => boolean;
	/** Whether a node is the program's own code, not a package's: only its reads and returns make a form `absent`. */
	ownCode?: (n: ts.Node) => boolean;
	/**
	 * An app whose XML is all built at build time: what script reads a value placed in a `bindingContext`, or by a file
	 * this says is generated from XML, is the keys `memberKeys` lists, so such a placement alone keys the class
	 * (`keyedByNameClasses`) rather than opening every member.
	 */
	keyedFile?: (f: ts.SourceFile) => boolean;
	/** A read of a member only an augmentation gives a typed object the program doesn't compile (core's View): missing until set, as `mergedInterfaceMemberOf`'s. */
	augmented?: (e: ts.PropertyAccessExpression) => boolean;
	/** Class fields are assigned in the constructor, after its parameter properties (`assignsClassFields`). */
	assignFields?: boolean;
	/** The kind of signal a type of this name is. */
	signalKind?: (name: string) => SignalKind | undefined;
	/** The build's framework: whether it may call a class's method or setter where the program can't see it. */
	calledByFramework?: FrameworkModel['calledByFramework'];
	/** The build's framework: whether a declared member may hold undefined at run time though its type leaves it out. */
	unsetMembers?: FrameworkModel['unsetMembers'];
}

export class Forms {
	readonly slots = new Map<ts.Node, Slot>();
	/** The slots of elements, values and results (`child`). */
	readonly parts = new Set<Slot>();
	/** Containers whose storage a fixed point's shares (an app array given to a platform's or library's slot). */
	readonly pinned = new Set<Slot>();
	/** Each signal's value whose signal is held as `JSNullish<T>` (`nullishSignalType`), by the signal's declaration. */
	readonly signalValues = new Map<ts.Node, Slot>();
	/** Every slot made, declarations' and parts'. */
	readonly made: Slot[] = [];
	readonly flows = new Map<ts.Node, Flow>();
	readonly edges: [Slot, Slot, number][] = [];
	readonly aliases: [Slot, Slot][] = [];
	/** The edges `share` added between a concrete slot and a type parameter's, by source. */
	readonly crossed = new Map<Slot, Set<Slot>>();
	/** Values something tells null from undefined in, and slots whose readers do, before the fixpoint. */
	readonly observedValues = new Set<ts.Expression>();
	readonly observedSlots: Slot[] = [];
	/**
	 * Slots a copy connects (a spread's, `Array.from`'s or `new Set(values)`'s elements; an element and the callback
	 * parameter given it): states flow from the first to the second, observation both ways, as no element is converted.
	 */
	readonly copies: [Slot, Slot][] = [];
	/** Variables and fields declared with no value, and the declarations the program assigns: one never assigned is given undefined. */
	readonly unwritten: ts.Declaration[] = [];
	readonly written = new Set<ts.Declaration>();
	/** Values whose type something tests, before the fixpoint. */
	readonly typeObservedValues = new Set<ts.Expression>();
	/** Values given to JSON.stringify (true: classes' fields too) or console (interfaces' and literals' fields). */
	readonly printed: [ts.Expression, boolean][] = [];
	/** The slots each value is placed in. */
	readonly placed = new Map<ts.Expression, Slot[]>();
	/** Arguments the program's calls give defaulted parameters, and the defaulted parameters a spread argument reaches. */
	readonly defaultArguments: [ts.ParameterDeclaration, ts.Expression][] = [];
	readonly spreadDefaults = new Set<ts.ParameterDeclaration>();
	readonly givenArguments: [ts.ParameterDeclaration, ts.Expression][] = [];
	/** Values placed where script holds them untyped: a slot of no type, a field or element no type reads, an unknown callee's argument. */
	readonly placedUntyped = new Set<ts.Expression>();
	/** The `placedUntyped` values held so with no slot to say where (`observeUntyped`). */
	readonly heldUntyped = new Set<ts.Expression>();
	readonly keyedFile: ((f: ts.SourceFile) => boolean) | null;
	/**
	 * Members script calls by a key the program doesn't spell (`obj[key](…)`): the receiver's declaration (null: an untyped
	 * receiver the program can't trace), the names the key's type allows (null: any), and whether they are statics.
	 */
	readonly calledByName: { owner: Owner | null; names: ReadonlySet<string> | null; statics: boolean }[] = [];
	readonly classes: ts.ClassLikeDeclaration[] = [];
	built = false;
	/**
	 * The graph is complete: a part a later question reaches (an element read nothing in the program made) is a slot of
	 * its own, not added to its container's, so that no answer depends on which questions were asked before it.
	 */
	solved = false;
	/** Wall-clock milliseconds the program-wide build took. */
	buildMs = 0;

	readonly files: readonly ts.SourceFile[];
	readonly checker: ts.TypeChecker;
	/** Whether a file is checked with strictNullChecks: its checker types are a lower bound on what its slots hold. */
	readonly strictFile: (f: ts.SourceFile) => boolean;
	readonly library: boolean;
	readonly assignFields: boolean;
	readonly native: (d: ts.Declaration) => boolean;
	readonly nativeNil: (d: ts.Declaration) => boolean;
	readonly ownCode: (n: ts.Node) => boolean;
	readonly augmented: (e: ts.PropertyAccessExpression) => boolean;
	readonly signalKind: (name: string) => SignalKind | undefined;
	readonly calledByFramework: FrameworkModel['calledByFramework'];
	readonly unsetMembers: FrameworkModel['unsetMembers'];

	constructor(files: readonly ts.SourceFile[], checker: ts.TypeChecker, strictFile: (f: ts.SourceFile) => boolean, options: FormsOptions = {}) {
		this.files = files;
		this.checker = checker;
		this.strictFile = strictFile;
		this.library = options.library ?? false;
		this.assignFields = options.assignFields ?? false;
		this.native = options.native ?? (() => false);
		this.ownCode = options.ownCode ?? (() => true);
		this.augmented = options.augmented ?? (() => false);
		this.signalKind = options.signalKind ?? (() => undefined);
		this.calledByFramework = options.calledByFramework;
		this.unsetMembers = options.unsetMembers;
		this.keyedFile = options.keyedFile ?? null;
		const nil = options.nativeNil ?? (() => false),
			known = new Map<ts.Declaration, boolean>();
		this.nativeNil = (d) => {
			let found = known.get(d);
			if (found === undefined) known.set(d, (found = this.native(d) && nil(d)));
			return found;
		};
	}

	/** An array's or Set's element type, or a Map's value type: the part `Form.element` is the form of. */
	elementOf(t: ts.Type): ts.Type | null {
		const part = this.partOf(t);
		return part && part !== 'result' && !this.checker.isTupleType(this.checker.getNonNullableType(t)) ? elementType(this.checker, t, part) : null;
	}

	formOf(e: ts.Expression): Form {
		this.build();
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		const observed = this.observedValues.has(x) || !!this.placed.get(x)?.some((s) => this.find(s).observed);
		const form = this.formFrom(this.flow(e), this.checker.getTypeAtLocation(e), observed);
		if (this.typeObservedValues.has(x) || this.placed.get(x)?.some((s) => this.find(s).typeObserved)) form.typeObserved = true;
		return form;
	}

	/** Whether a slot an array value is placed in has its elements' type tested. */
	elementsTypeObserved(e: ts.Expression): boolean {
		this.build();
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		return !!this.placed.get(x)?.some((s) => {
			const c = this.find(s).children.get('element');
			return !!c && this.find(c).typeObserved;
		});
	}

	formOfSlot(d: ts.Declaration): Form {
		this.build();
		const s = this.slotFor(d);
		// A function literal's slot is its result, though the slot is typed as the function.
		const result = ts.isFunctionLike(d) && ts.isExpression(d) ? this.declaredType(d) : null;
		return this.formFrom({ states: 0, from: [[s, ~0]] }, result ?? this.find(s).type ?? this.checker.getTypeAtLocation(d));
	}

	/**
	 * Whether a container (a declaration, or an expression giving one) shares its storage with a platform's or library's
	 * slot, or is itself another container's element or value: its elements keep their declared form, as the slot whose
	 * type spells them does.
	 */
	elementsPinned(n: ts.Declaration | ts.Expression): boolean {
		this.build();
		const roots = (this.pinnedRoots ??= new Set([...this.pinned, ...this.parts].map((s) => this.find(s))));
		if (!roots.size) return false;
		const slots = ts.isExpression(n) && !ts.isFunctionLike(n) ? this.flow(n).from.map(([s]) => s) : [this.slotFor(n as ts.Declaration)];
		return slots.some((s) => roots.has(this.find(s)));
	}
	pinnedRoots?: Set<Slot>;

	/** A fixed point typed as a container of a concrete element type, whose storage holds that type. */
	holdsElements(s: Slot): boolean {
		const part = s.type && this.partOf(s.type);
		const t = part && part !== 'result' ? elementType(this.checker, s.type!, part) : null;
		return !!t && !isGeneric(t) && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	}

	/** Values the program places where script holds them untyped (`placedUntyped`). */
	untypedPlacements(): ReadonlySet<ts.Expression> {
		this.build();
		return this.placedUntyped;
	}

	/**
	 * The program's own declarations' slots and their parts (elements, values, results) whose forms hold null and
	 * undefined both and are not foreign, and how many of those are observed: the ones that render as `JSNullish<T>`.
	 */
	bothStates(): { slots: number; both: number; nullish: number } {
		this.build();
		let slots = 0,
			both = 0,
			nullish = 0;
		const count = (f: Form, depth: number) => {
			slots++;
			if (f.undefined && f.null && !f.foreign) {
				both++;
				if (f.observed) nullish++;
			}
			if (f.element && depth < 4) count(f.element, depth + 1);
		};
		for (const n of [...this.slots.keys()]) if (!ts.isExpression(n) && !declarationFile(n)) count(this.formOfSlot(n as ts.Declaration), 0);
		return { slots, both, nullish };
	}

	/**
	 * The program's declarations whose form is foreign and whose type something tests, by the group that
	 * shares one form: every member of a group is held as one.
	 */
	typeTestedForeign(): ts.Declaration[][] {
		this.build();
		const groups = new Map<Slot, ts.Declaration[]>();
		for (const s of this.made) {
			const r = this.find(s);
			if (!s.decl || r.generic || !(r.states & F) || !r.typeObserved) continue;
			const list = groups.get(r);
			if (list) list.push(s.decl);
			else groups.set(r, [s.decl]);
		}
		return [...groups.values()];
	}

	/** The declarations sharing one form with `d` (overrides, the interface member a class implements, a literal's field), `d` among them. */
	groupOf(d: ts.Declaration): readonly ts.Declaration[] {
		this.build();
		if (!this.groups) {
			this.groups = new Map();
			for (const s of this.made) {
				if (!s.decl) continue;
				const r = this.find(s),
					list = this.groups.get(r);
				if (list) list.push(s.decl);
				else this.groups.set(r, [s.decl]);
			}
		}
		return this.groups.get(this.find(this.slotFor(d))) ?? [d];
	}
	groups: Map<Slot, ts.Declaration[]> | null = null;

	/**
	 * A defaulted parameter, or one of its group, that a call of the program's gives a value that may be undefined or
	 * spreads arguments over: JavaScript applies the default for an undefined argument as for an omitted one.
	 */
	defaultGivenUndefined(p: ts.ParameterDeclaration): boolean {
		this.build();
		const group = new Set(this.groupOf(p));
		return [...group].some((q) => ts.isParameter(q) && this.spreadDefaults.has(q)) || this.defaultArguments.some(([q, a]) => group.has(q) && this.formOf(a).undefined);
	}

	/** Parameters a call of the program's gives a value that may be null, which JavaScript passes past a default. */
	defaultsGivenNull(): Set<ts.ParameterDeclaration> {
		this.build();
		return (this.nullDefaults ??= new Set(this.givenArguments.filter(([, a]) => this.formOf(a).null).map(([q]) => q)));
	}
	nullDefaults?: Set<ts.ParameterDeclaration>;

	/** A declaration whose group holds a fixed point's slot (a platform's or library's declaration): its form is that one's. */
	fixedSlot(d: ts.Declaration): boolean {
		this.build();
		return this.find(this.slotFor(d)).fixed;
	}

	/** What a declaration's own type admits (its checker type, its type as written, `?`, a default), before any flow. */
	declaredForm(d: ts.Declaration): Form {
		const s = this.declaredStates(d) | ((d as { initializer?: ts.Node }).initializer && ts.isParameter(d) ? U : 0);
		const type = this.declaredType(d) ?? this.checker.getTypeAtLocation(d);
		return { type: this.checker.getNonNullableType(type), undefined: !!(s & U), null: !!(s & N), hole: false, foreign: !!(s & F), missing: false, absent: false, given: false, untyped: false, observed: false, typeObserved: false };
	}

	/** A read as a `T` (of a generic slot, at a type parameter's type) holds what the slot holds less what instantiations bring. */
	formFrom(flow: Flow, type: ts.Type, observed = false, depth = 0): Form {
		let states = flow.states,
			typeObserved = false;
		const parts = new Map<Part, Slot[]>();
		const asT = isGeneric(type);
		for (const [s, keep] of flow.from) {
			const r = this.find(s);
			states |= (r.generic && asT ? r.local : r.states) & keep;
			if (r.observed && keep & N) observed = true;
			if (r.typeObserved && keep & F) typeObserved = true;
			for (const [p, c] of r.children) {
				const list = parts.get(p);
				if (list) list.push(c);
				else parts.set(p, [c]);
			}
		}
		if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) states |= F;
		const form: Form = { type: this.checker.getNonNullableType(type), undefined: !!(states & U), null: !!(states & N), hole: !!(states & H), foreign: !!(states & F), missing: !!(states & U && states & M), absent: !!(states & A && states & (U | N)), given: !!(states & (A | G) && states & (U | N)), untyped: !!(states & U && states & O), observed, typeObserved };
		const part = this.partOf(type);
		const inner = part && parts.get(part);
		if (inner && depth < 4) {
			const t = elementType(this.checker, type, part!);
			if (t) form.element = this.formFrom({ states: 0, from: inner.map((c): [Slot, number] => [c, ~0]) }, t, false, depth + 1);
		}
		return form;
	}

	partOf(t: ts.Type): Part | null {
		const x = this.checker.getNonNullableType(t);
		if (this.checker.isArrayType(x) || this.checker.isTupleType(x)) return 'element';
		const name = x.getSymbol()?.name;
		if (name === 'Set' || name === 'ReadonlySet') return 'element';
		if (name === 'Map' || name === 'ReadonlyMap') return 'value';
		if (name === 'Promise') return 'result';
		return isRecord(x) ? 'value' : null;
	}

	/** The containers whose elements a callback's parameter is given (`xs.forEach(show)`), by the parameter. */
	readonly elementSourceOf = new Map<ts.ParameterDeclaration, ts.Expression[]>();

	readonly openedShapes = new Set<ts.Type>();
	readonly openedSignatures = new Set<ts.Declaration>();

	byName: Set<ts.ClassLikeDeclaration> | null = null;
	byNameStatic = new Set<ts.ClassLikeDeclaration>();
	keyedByName = new Set<ts.ClassLikeDeclaration>();
	viewed: Map<ts.ClassLikeDeclaration, Set<string>> | null = null;
	readonly viewedStatic = new Set<ts.ClassLikeDeclaration>();

	/** The program's object literals script reaches by name, as `byNameClasses` finds a class's instances. */
	readonly byNameLiterals = new Set<ts.ObjectLiteralExpression>();
}
export interface Forms extends UnionFindMethods {}
Object.defineProperties(Forms.prototype, Object.getOwnPropertyDescriptors(unionFindMethods));
export interface Forms extends PlacementsMethods {}
Object.defineProperties(Forms.prototype, Object.getOwnPropertyDescriptors(placementsMethods));
export interface Forms extends ObserversMethods {}
Object.defineProperties(Forms.prototype, Object.getOwnPropertyDescriptors(observersMethods));
export interface Forms extends ByNameCallsMethods {}
Object.defineProperties(Forms.prototype, Object.getOwnPropertyDescriptors(byNameCallsMethods));
export interface Forms extends PlaceCallsMethods {}
Object.defineProperties(Forms.prototype, Object.getOwnPropertyDescriptors(placeCallsMethods));
export interface Forms extends OpenMethods {}
Object.defineProperties(Forms.prototype, Object.getOwnPropertyDescriptors(openMethods));
export interface Forms extends ResultsMethods {}
Object.defineProperties(Forms.prototype, Object.getOwnPropertyDescriptors(resultsMethods));
traceAnalysis(Forms.prototype, 'forms');
