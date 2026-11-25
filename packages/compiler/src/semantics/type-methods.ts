// The type questions both translators answer alike, installed on each prototype as `frontMethods` are: the entry of the
// type mapping (`type`: `nativeTypeOf`, spelled, with the cycles a recursive type meets), the type a node is held as
// (`typeOf`: the backend's own type of it, `plainTypeOf`, as the value states hold it), and the questions over that
// type. Not traced: they read the backend's own spellings (the decision trace records `StateBackend.typeOf`).
import ts from 'typescript';
import { iteratedType } from './lang.ts';
import { literalTypeClassOf, type LiteralClassBackend } from './classes.ts';
import { erasesTypeParameter } from './conversion.ts';
import type { Ledger } from './ledger.ts';
import { nullishField } from './placement.ts';
import type { ValueStates } from './states/value-states.ts';
import { isUntyped, nativeType, nativeTypeOf, parseNativeType, spelledType, untyped, type NativeType, type TypeView } from './types.ts';

interface TypeHost {
	readonly checker: ts.TypeChecker;
	readonly states: ValueStates;
	readonly ledger: Ledger;
	readonly sourceFiles: readonly ts.SourceFile[];
	readonly pluginFiles: ReadonlySet<string>;
	readonly typeView: TypeView;
	/** The types `type()` is spelling, outermost first, each with whether it is on a cycle. */
	readonly spelling: { type: ts.Type; cycle: boolean }[];
	readonly shaping: ReadonlySet<ts.Type>;
	appInterfaces: { name: string; type: ts.Type }[] | null;
	appInterfaceList(): { name: string; type: ts.Type }[];
	typeOf(n: ts.Node): string;
	plainTypeOf(n: ts.Node): string;
	untypedArithmetic(n: ts.Node): boolean;
	narrowedHeld(n: ts.Node): { type: ts.Type } | null;
	plainDeclaredTypeOf(e: ts.Expression): string | null;
	heldElements(n: ts.Node, t: string): string;
	topName(d: ts.Node, name: string): string;
	type(t: ts.Type, where?: ts.Node): string;
	returnTypeOf(d: ts.SignatureDeclaration): string;
}

/** The kit's iterable classes whose one type argument is the type of what iterating them gives. */
const ITERATED = new Set(['JSArray', 'JSSet', 'JSIterator', 'JSGenerator', 'JSIterable', 'JSAsyncIterator', 'JSAsyncGenerator', 'JSAsyncIterable']);

const interfaceLists = new WeakMap<object, { name: string; type: ts.Type }[]>();

export const typeMethods = {
	/**
	 * A type met again while it is being spelled (a recursive alias, `type Markup = [string, ...Markup[]]`) is spelled
	 * there as a value of unknown shape of its kind; a tuple on that cycle is an untyped array, whichever type the
	 * spelling started from.
	 */
	type(this: TypeHost, t: ts.Type, where?: ts.Node): string {
		const s = this.typeView.spelling;
		const untypedArray = () => s.spell(nativeType(s, 'array', 'JSArray', [untyped(s)]));
		const at = this.spelling.findIndex((x) => x.type === t);
		if (at >= 0 || this.shaping.has(t)) {
			if (at >= 0) for (const x of this.spelling.slice(at)) x.cycle = true;
			return this.checker.isTupleType(t) || this.checker.isArrayType(t) ? untypedArray() : s.spell(untyped(s));
		}
		const entry = { type: t, cycle: false };
		this.spelling.push(entry);
		try {
			const spelled = s.spell(nativeTypeOf(t, where, this.typeView));
			return entry.cycle && this.checker.isTupleType(t) ? untypedArray() : spelled;
		} finally {
			this.spelling.pop();
		}
	},

	/**
	 * The type the backend holds `n`'s value as: a narrowing's, else its own with what the value states hold of it (its
	 * elements, an optional element read, a nullish field's use, a variable held as `JSNullish<T>`).
	 */
	typeOf(this: TypeHost, n: ts.Node): string {
		const s = this.typeView.spelling;
		const narrowed = this.narrowedHeld(n);
		if (narrowed) return this.type(narrowed.type, n);
		if (this.untypedArithmetic(n)) return s.spell(untyped(s));
		const t = this.heldElements(n, this.plainTypeOf(n));
		if (this.states.optionalElementRead(n)) return s.optional(t);
		if (nullishField(this, n)) {
			const use = this.states.nullishFieldUse(n);
			return use === 'member' ? t : use === 'converted' ? s.spell(untyped(s)) : s.optional(t);
		}
		return ts.isIdentifier(n) && n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n && this.states.nullishHeld(n.parent) ? s.nullish(t) : t;
	},

	/** `t`, the type of `n`, with the elements `ValueStates.nullishElements` holds as `JSNullish<T>` so, and those `optionalElements` holds optional. */
	heldElements(this: TypeHost, n: ts.Node, t: string): string {
		const s = this.typeView.spelling;
		if (this.states.nullishElements(n)) return s.nullishElements(t);
		if (this.states.optionalElements(n)) return s.optionalElements(t);
		if (this.states.optionalNestedElements(n)) {
			const m = /^JSArray<(.*)>([?!]?)$/.exec(t);
			if (m) return `JSArray<${s.optionalElements(m[1])}>${m[2]}`;
		}
		return t;
	},

	/** A memo call's value type (`computed<T>(fn)`): the type argument it is given, else what `fn` returns. */
	computedType(this: TypeHost, e: ts.CallExpression): string {
		const given = e.typeArguments?.[0];
		return given ? this.type(this.checker.getTypeFromTypeNode(given), given) : this.returnTypeOf(e.arguments[0] as ts.ArrowFunction);
	},

	/** An interface method's parameter as its requirement declares it: optional where it is, or where its group's form widens it. */
	requirementParamType(this: TypeHost, p: ts.ParameterDeclaration): string {
		const s = this.typeView.spelling;
		if (this.states.nullishHeld(p)) return s.nullish(this.typeOf(p.name));
		return p.questionToken || this.states.widened(p) ? s.optional(this.typeOf(p.name)) : this.typeOf(p.name);
	},

	/** The native type the backend holds `n`'s value as. */
	nativeOf(this: TypeHost, n: ts.Node): NativeType {
		return parseNativeType(this.typeOf(n));
	},

	/** The native type the backend holds a value of type `t` read at `at` as. */
	nativeOfType(this: TypeHost & { type(t: ts.Type, where?: ts.Node): string }, t: ts.Type, at: ts.Node): NativeType {
		return parseNativeType(this.type(t, at));
	},

	/** `erasesTypeParameter` under this translator's ledger. */
	erasesTypeParameter(this: { readonly ledger: Ledger }, p: ts.TypeParameterDeclaration): boolean {
		return erasesTypeParameter(p, this.ledger);
	},

	isAny(this: TypeHost, n: ts.Node): boolean {
		return isUntyped(spelledType(this.typeOf(n)));
	},

	isArray(this: TypeHost, n: ts.Node): boolean {
		const t = spelledType(this.typeOf(n));
		return t.head === 'JSArray' && t.args.length > 0;
	},

	isString(this: TypeHost, n: ts.Node): boolean {
		const t = spelledType(this.typeOf(n));
		return t.kind === 'string' && !t.implicit;
	},

	/** The type a read or write of `e` declares, with its elements held as the program's own facts hold them; null where it declares none. */
	declaredTypeOf(this: TypeHost, e: ts.Expression): string | null {
		const t = this.plainDeclaredTypeOf(e);
		if (t && this.untypedArithmetic(e)) return this.typeView.spelling.spell(untyped(this.typeView.spelling));
		return t && this.heldElements(e, t);
	},

	/**
	 * The program's own non-generic top-level interfaces, plugins' left out. Kept apart from `appInterfaces`: Kotlin's
	 * object literals read that one once a conformance question has filled it, so filling it here changes their classes.
	 */
	appInterfaceList(this: TypeHost): { name: string; type: ts.Type }[] {
		let list = interfaceLists.get(this);
		if (!list) {
			const c = this.checker;
			list = this.sourceFiles
				.filter((f) => !this.pluginFiles.has(f.fileName))
				.flatMap((f) => f.statements.filter(ts.isInterfaceDeclaration))
				.filter((d) => !d.typeParameters?.length)
				.map((d) => ({ name: this.topName(d, d.name.text), type: c.getDeclaredTypeOfSymbol(c.getSymbolAtLocation(d.name)!) }));
			interfaceLists.set(this, list);
		}
		return list;
	},

	/**
	 * The one app interface an object literal's type conforms to (every key of the literal is one of its fields, of an
	 * assignable type, and every field the literal lacks is optional): what the literal is, where it flows into that
	 * interface through an inferred type (`.map(e => ({ … }))`).
	 */
	conformingInterface(this: TypeHost, t: ts.Type): string | null {
		const c = this.checker;
		this.appInterfaces ??= this.appInterfaceList();
		const own = t.getProperties();
		if (!own.length) return null;
		const matches = this.appInterfaces.filter(({ type }) => {
			const fields = type.getProperties();
			if (!own.every((p) => fields.some((f) => f.name === p.name))) return false;
			if (!fields.every((f) => own.some((p) => p.name === f.name) || f.flags & ts.SymbolFlags.Optional)) return false;
			return (c as ts.TypeChecker & { isTypeAssignableTo?(a: ts.Type, b: ts.Type): boolean }).isTypeAssignableTo?.(t, type) ?? false;
		});
		return matches.length === 1 ? matches[0].name : null;
	},

	/** Library mode: an object literal's own type, spelled as the class its literal is held as (`literalTypeClassOf`); null for any other type. */
	heldAs(this: TypeHost & LiteralClassBackend, t: ts.Type, where?: ts.Node): string | null {
		const cls = literalTypeClassOf(this, t);
		return cls ? this.type(this.checker.getDeclaredTypeOfSymbol(this.checker.getSymbolAtLocation(cls.name!)!), where) : null;
	},

	/** The type of what iterating `e` gives (`for…of`, a spread). */
	elementTypeOf(this: TypeHost & { type(t: ts.Type, where?: ts.Node): string }, e: ts.Expression): string {
		const t = typeMethods.nativeOf.call(this, e);
		if (t.head !== undefined && ITERATED.has(t.head) && t.args.length === 1 && !t.implicit) return this.typeView.spelling.spell(t.args[0]);
		const async = ts.isForOfStatement(e.parent) && !!e.parent.awaitModifier;
		const el = iteratedType(this.checker.getTypeAtLocation(e), this.checker, e, async);
		return el ? this.type(el, e) : this.typeView.spelling.spell(untyped(this.typeView.spelling));
	},
};

export type TypeMethods = typeof typeMethods;
