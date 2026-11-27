import ts from 'typescript';
import { Forms, representation } from '../forms/forms.ts';
import type { Framework } from '../../adapters/hooks.ts';
import type { Held } from '../conversion.ts';
import { isPrimitive, type NativeType } from '../types.ts';
import { LooseSlots, slotOf, type TrustScope } from '../trust.ts';
import { nullishSlots, type NullishSlots, type heldDowncasts } from '../nullish.ts';
import { accessedDeclaration, literalKey } from '../lang.ts';
import { isAsync } from '../throws.ts';
import type { ActiveAdapter } from '../../adapters/active.ts';
import { elementsMethods, type ElementsMethods } from './elements.ts';
import { byNameMethods, type ByNameMethods } from './by-name.ts';
import { fieldsMethods, type FieldsMethods } from './fields.ts';
import { lenientMethods, type LenientMethods } from './lenient.ts';
import { foreignMethods, type ForeignMethods } from './foreign.ts';
import { observers } from '../observers.ts';
import type { Ledger } from '../ledger.ts';
import { traceClass, tracedBackend } from '../decision-trace.ts';
import { assignsClassFields } from '../class-plan.ts';
import { readsMethods, type ReadsMethods } from './reads.ts';
import { nilMethods, type NilMethods } from './nil.ts';
import { untrustedMethods, type UntrustedMethods } from './untrusted.ts';
import { missingMethods, type MissingMethods } from './missing.ts';
import { parametersMethods, type ParametersMethods } from './parameters.ts';
import { resultsMethods, type ResultsMethods } from './results.ts';
import { untypedMethods, type UntypedMethods } from './untyped.ts';

/** What a backend answers of its own (its spelled types, its binding, its kit): inputs of the shared deciders' answers. */
/** The native types the backend holds values as: compared between the backends as the front's own answers are. */
const HELD_TYPES = ['typeOf', 'type', 'returnTypeOf', 'heldType'] as const satisfies readonly (keyof StateBackend)[];
const BACKEND_INPUTS = ['native', 'optional', 'functionType', 'looseObjectType', 'nullableParameter', 'nulledEntry', 'optionalShapeField', 'declaredOptional', 'kitNil', 'resultHoldsNull', 'keyedClass', 'ownSignature', 'augmentedMember'] as const satisfies readonly (keyof StateBackend)[];

// The null/undefined/missing deciders both translators ask: which empty states a value or slot may hold where its native
// form keeps only one. The rules are shared; a backend supplies its mode, how it spells types and how it emits a keyed
// read, and its ledger (../ledger.ts) names the few rules that still differ between the two.
// Groups of deciders are in this folder's other modules (elements, fields, lenient, foreign, by-name), installed as
// ValueStates methods.

/** What the shared deciders read from a translator. */
export interface StateBackend {
	readonly name: 'swift' | 'kotlin';
	readonly checker: ts.TypeChecker;
	readonly sourceFiles: readonly ts.SourceFile[];
	readonly pluginFiles: ReadonlySet<string>;
	/** Where plugins' sources are: a file under one is a plugin's however it is compiled (its components as the app's). */
	readonly pluginRoots: readonly string[];
	/** The build's framework, as its adapter's translator hooks describe it. */
	readonly framework: Framework;
	readonly trust: TrustScope;
	readonly lenient: boolean;
	readonly lenientApp: boolean;
	/** The app's configuration assigns class fields in the constructor (`TranslatorConfig.assignFields`). */
	readonly assignFields: boolean;
	readonly library: unknown;
	/** An app whose XML is all built at build time (`xml/keys.ts`): the keys script reads app objects by, and the files generated from its XML. */
	readonly xmlMemberKeys: XmlMemberKeys | null;
	/** The platform binding (Swift's SDK tables, Kotlin's class files): whether a declaration's binding holds nil. */
	readonly native: { holdsNil?(d: ts.Declaration): boolean } | null;
	readonly ledger: Ledger;
	/** The analyses `ledger.checkedParameters` reads: present on a backend whose ledger has that entry. */
	readonly parameterChecks?: ParameterChecks;
	typeOf(n: ts.Node): NativeType;
	type(t: ts.Type, at: ts.Node): NativeType;
	returnTypeOf(d: ts.SignatureDeclaration): NativeType;
	resolve(n: ts.Node): ts.Symbol | undefined;
	error(n: ts.Node, what: string): Error;
	/** A native type whose empty value stands for a missing one. */
	optional(t: NativeType): boolean;
	functionType(t: NativeType): boolean;
	/** The object shapes the translation writes: a question asked here requires none (`ShapeMap.question`). */
	untypedCastChecks(e: ts.Expression, t: NativeType): boolean;
	readonly shapes: { question<T>(f: () => T): T };
	/** A method whose native signature is its own: no base, interface or override shares it. */
	ownSignature(fn: ts.Node): fn is ts.MethodDeclaration;
	/** An object type a loose slot holds as an optional where it may be missing. */
	looseObjectType(t: NativeType): boolean;
	/** A sync function's result as the backend holds it carries a null its body gives where it gives nothing. */
	resultHoldsNull(d: ts.FunctionDeclaration | ts.MethodDeclaration): boolean;
	/** A read of a member only an augmentation declares: missing until set (`FormsOptions.augmented`). */
	augmentedMember(e: ts.PropertyAccessExpression): boolean;
	/** A plugin parameter's native type that must take nil though its declared type has no empty value. */
	nullableParameter(t: NativeType): boolean;
	/** `read` read untyped, from `code`, the read's own untyped translation; null where that is no such read. */
	nulledEntry(read: NulledRead, code: () => string): string | null;
	/** The keyed field a member read whose type holds null and undefined is noted under (`jsNulls`), or null. */
	optionalShapeField(e: ts.PropertyAccessExpression): string | null;
	/**
	 * The type the backend holds what `x` reads as: its declaration's where it has one, made optional where the backend's
	 * own facts hold it so though TypeScript types it present. `heldOptional` and `placement` read it.
	 */
	heldType(x: ts.Expression): Held;
	/** A variable the backend declares optional though its type says present, known before it is translated. */
	declaredOptional(x: ts.Identifier): boolean;
	/** A kit property's value or method's result the kit holds optional where core's typings say present. */
	kitNil?(x: ts.Expression): boolean;
	/** The backend gives the class's objects key members (`subscript(jsKey:)`, `jsNulls`): shapes.ts `keyedClass`. */
	keyedClass(cls: ts.ClassLikeDeclaration): boolean;
}

export interface XmlMemberKeys {
	readonly keys: ReadonlySet<string>;
	readonly generated: ReadonlySet<string>;
}

/** Whether a function tests a parameter's truth, and whether a binding may take an unset regexp group's undefined. */
export interface ParameterChecks {
	truthTested(name: ts.Identifier): boolean;
	unsetElement(d: ts.Node): boolean;
}

/** `ValueStates.nulledRead`'s read: an array's element, a Map's value (`m.get(k)`), or a field by the key it is noted under. */
export type NulledRead = { kind: 'element'; read: ts.ElementAccessExpression } | { kind: 'entry'; read: ts.CallExpression } | { kind: 'field'; read: ts.PropertyAccessExpression; name: string } | { kind: 'static'; read: ts.PropertyAccessExpression; name: string; flag: string };

/**
 * How a destructuring default meets the part it reads (`ValueStates.partDefault`):
 * - `empty`: the part's empty value is undefined, or it is untyped, where null is a value of its own: the default replaces it;
 * - `never`: the part holds null and never undefined: no default applies;
 * - `element`: an array's element held null, undefined only past the array's end: the default replaces only that;
 * - `keyed`: the part may hold null and undefined both: read by key, untyped, which tells them apart.
 */
export type PartDefault = 'empty' | 'never' | 'element' | 'keyed';

export class ValueStates {
	/** A non-strict app's variables given only a null result (`nullResult`) or a value: their empty value is null. The backends note them as they declare them. */
	readonly nullVars = new Set<ts.Symbol>();
	readonly libraryNullVars = new Map<ts.VariableDeclaration, { only: boolean } | null>();
	lenientNullFieldSet?: Set<ts.PropertyDeclaration>;
	nullishSlotSet?: NullishSlots;
	nullishHeldSet = new Set<ts.Declaration>();
	nullishElementSet = new Set<ts.Declaration>();
	formSet?: Forms;
	downcastSet?: ReturnType<typeof heldDowncasts>;
	looseSlotSet: LooseSlots | null = null;
	implementedInterfaceSet: Set<ts.Declaration> | null = null;
	scriptCalledFunctions?: (sig: ts.Node) => boolean;
	undefinedGiven = new Map<ts.ParameterDeclaration, boolean>();
	lenientAsyncs = new Map<ts.Node, boolean>();
	nullFieldSets = new Map<ts.ClassLikeDeclaration, Set<string>>();
	nullWrites?: Set<ts.Declaration>;
	/** The members of `nullWrites` written something other than the `undefined` literal. */
	nullLiteralWrites = new Set<ts.Declaration>();
	nullishBuilding = false;

	readonly backend: StateBackend;
	/** The build's: its adapter's runtime and its plugin bindings are packaged code. */
	private readonly build: { readonly adapter: ActiveAdapter; isBindingSource(file: string): boolean };

	constructor(backend: StateBackend, build: { readonly adapter: ActiveAdapter; isBindingSource(file: string): boolean }) {
		this.backend = tracedBackend(backend, BACKEND_INPUTS, HELD_TYPES);
		this.build = build;
		observers.states?.(this);
	}

	get checker(): ts.TypeChecker {
		return this.backend.checker;
	}

	plugin(n: ts.Node): boolean {
		return this.backend.pluginFiles.has(n.getSourceFile().fileName);
	}

	/** The app's own code, strict or a non-strict app's, where a foreign value whose type is tested is held untyped, and one entering a typed slot is checked. */
	appCode(n: ts.Node): boolean {
		const b = this.backend;
		return !b.library && !this.packaged(n) && (b.trust.strictFile(n.getSourceFile()) || b.lenientApp);
	}

	/**
	 * Code of another package than the app: a plugin's, an installed package's, a plugin's binding, or a library port the
	 * compiler or the framework's adapter ships (runtimes, a runtime module placed in the app's folder), decided by where
	 * its source is.
	 */
	packaged(n: ts.Node): boolean {
		const f = n.getSourceFile().fileName;
		return this.plugin(n) || /[\\/]node_modules[\\/]/.test(f) || this.build.adapter.isRuntimeModule(f) || this.build.adapter.isRuntimeSource(f) || this.build.isBindingSource(f) || this.backend.pluginRoots.some((r) => f.startsWith(r.endsWith('/') ? r : r + '/'));
	}

	primitive(t: NativeType): boolean {
		return isPrimitive(t);
	}

	/**
	 * Strict app code's variables, parameters and results that may hold null and undefined both, held untyped; and
	 * interface fields that may. Library and non-strict code have none: their checker types say nothing of null.
	 */
	nullish(): NullishSlots {
		if (this.nullishSlotSet) return this.nullishSlotSet;
		this.nullishBuilding = true;
		try {
			return this.nullishSlots();
		} finally {
			this.nullishBuilding = false;
		}
	}

	nullishSlots(): NullishSlots {
		const b = this.backend;
		const found: NullishSlots =
			b.lenient || b.library
				? { held: new Set(), fields: new Set(), refused: [], functions: new Map() }
				: nullishSlots(
						b.checker,
						b.sourceFiles,
						(f) => b.pluginFiles.has(f.fileName),
						(d) => this.formNullish(d),
						b.framework.hooks,
						(n) => b.framework.signalKind(n),
					);
		// An element, callback parameter or loop variable the analysis can't hold: one nil, read as undefined, where
		// nothing tells null from undefined in it; `JSNullish<T>` where something does.
		found.refused = found.refused.filter(([, , cover]) => {
			if (!cover) return true;
			const form = cover.kind === 'element' ? this.forms().formOfSlot(cover.slot).element : this.forms().formOfSlot(cover.slot);
			const shown = form && representation(form);
			if (shown === 'nullish') (cover.kind === 'element' ? this.nullishElementSet : this.nullishHeldSet).add(cover.slot);
			return !shown || !['present', 'undefined', 'null', 'nullish'].includes(shown);
		});
		// A function slot: `JSNullish` where null and undefined are told apart, else one nil read as undefined. One that may
		// hold another value too is refused where its own code compares it.
		for (const [d, what] of found.functions) {
			const shown = representation(this.forms().formOfSlot(d));
			if (shown === 'nullish') this.nullishHeldSet.add(d);
			else if (shown === 'foreign' && what) found.refused.push([d, what]);
		}
		// A variable, parameter or result held untyped for its null and undefined: `JSNullish<T>` where something tells them
		// apart, as every member of its group (a function type and its values, an override family) reads one form.
		for (const d of found.held)
			if (representation(this.forms().formOfSlot(d)) === 'nullish') {
				found.held.delete(d);
				this.nullishHeldSet.add(d);
			}
		for (const p of this.forms().defaultsGivenNull()) {
			const group = this.forms().groupOf(p);
			if (!group.some((q) => ts.isParameter(q) && this.defaultGivenNull(q))) continue;
			for (const q of group)
				if (ts.isParameter(q)) {
					found.held.delete(q);
					this.nullishHeldSet.add(q);
				}
		}
		// A foreign value whose type the program tests is held untyped, by every member of its group or by none.
		if (!b.lenient && !b.library) {
			for (const group of this.forms().typeTestedForeign()) {
				if (group.every((d) => this.holdsForeign(d)))
					for (const d of group)
						if (!this.untypedDeclaration(d)) {
							found.held.add(d);
							this.nullishHeldSet.delete(d);
						}
			}
			// A pattern's name for a field held untyped holds what the field holds, as a variable initialized from it would.
			const c = this.checker;
			const visit = (n: ts.Node): void => {
				if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && !n.dotDotDotToken && ts.isIdentifier(n.name)) {
					const key = n.propertyName ? literalKey(n.propertyName, c) : n.name.text;
					const prop = key !== null ? c.getTypeAtLocation(n.parent).getProperty(key) : undefined;
					const field = prop?.valueDeclaration ?? prop?.declarations?.[0];
					if (field && found.held.has(field) && !this.nullishHeldSet.has(field) && this.holdsForeign(n) && !this.untypedDeclaration(n)) {
						found.held.add(n);
						this.nullishHeldSet.delete(n);
					}
				}
				ts.forEachChild(n, visit);
			};
			for (const f of b.sourceFiles) if (!f.isDeclarationFile && this.appCode(f)) visit(f);
		}
		// A class field set to a null its type leaves out holds null and undefined both: held as `JSNullish<T>`, its member on
		// every class kind, with the members of its group (the interface property it implements, its overrides).
		if (!b.lenient && !b.library) {
			const visit = (n: ts.Node): void => {
				if (ts.isClassLike(n) && !this.plugin(n)) {
					for (const m of this.nullSetFields(n)) {
						const group = this.forms()
							.groupOf(m)
							.filter((d) => ts.isPropertyDeclaration(d) || ts.isPropertySignature(d));
						if (group.every((d) => !d.getSourceFile().isDeclarationFile && this.appCode(d) && !found.held.has(d))) for (const d of group) this.nullishHeldSet.add(d);
					}
				}
				ts.forEachChild(n, visit);
			};
			for (const f of b.sourceFiles) if (!f.isDeclarationFile && !b.pluginFiles.has(f.fileName)) visit(f);
		}
		this.nullishSlotSet = found;
		// A class without key members can't note a field's null by name: the fields it would note hold `JSNullish<T>`, with their group.
		if (!b.lenient && !b.library) {
			const visit = (n: ts.Node): void => {
				if (ts.isClassLike(n) && !this.plugin(n) && !b.keyedClass(n)) {
					for (const m of this.unheldNullFields(n)) {
						if (this.nullishHeldSet.has(m)) continue;
						const group = this.forms()
							.groupOf(m)
							.filter((d) => ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isParameter(d));
						if ([m, ...group].every((d) => !d.getSourceFile().isDeclarationFile && this.appCode(d) && !found.held.has(d))) for (const d of [m, ...group]) this.nullishHeldSet.add(d);
					}
				}
				ts.forEachChild(n, visit);
			};
			for (const f of b.sourceFiles) if (!f.isDeclarationFile && !b.pluginFiles.has(f.fileName)) visit(f);
		}
		// A method or function returning a field (or another such result) held as `JSNullish<T>` returns it in that form,
		// with its group, so null and undefined stay apart through the call.
		if (!b.lenient && !b.library) {
			const c = this.checker;
			const heldRead = (e: ts.Expression): boolean => {
				const x = ts.skipOuterExpressions(e);
				const d = ts.isPropertyAccessExpression(x) ? accessedDeclaration(c.getSymbolAtLocation(x.name), false) : ts.isCallExpression(x) ? c.getResolvedSignature(x)?.getDeclaration() : undefined;
				return !!d && (ts.isPropertyDeclaration(d) || ts.isGetAccessorDeclaration(d) || ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) && this.nullishHeldSet.has(d);
			};
			const returnsHeld = (fn: ts.FunctionLikeDeclaration): boolean => {
				let hit = false;
				const scan = (n: ts.Node): void => {
					if (hit || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
					if (ts.isReturnStatement(n) && n.expression && heldRead(n.expression)) hit = true;
					else ts.forEachChild(n, scan);
				};
				if (fn.body) ts.forEachChild(fn.body, scan);
				return hit;
			};
			const fns: (ts.MethodDeclaration | ts.FunctionDeclaration)[] = [];
			const collect = (n: ts.Node): void => {
				if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.body && !n.asteriskToken && !isAsync(n) && !this.plugin(n)) fns.push(n);
				ts.forEachChild(n, collect);
			};
			for (const f of b.sourceFiles) if (!f.isDeclarationFile && !b.pluginFiles.has(f.fileName) && this.appCode(f)) collect(f);
			for (let changed = true; changed;) {
				changed = false;
				for (const fn of fns) {
					if (this.nullishHeldSet.has(fn) || !returnsHeld(fn)) continue;
					const group = this.forms().groupOf(fn);
					if ([fn, ...group].every((d) => !d.getSourceFile().isDeclarationFile && this.appCode(d) && !found.held.has(d))) {
						for (const d of [fn, ...group]) this.nullishHeldSet.add(d);
						changed = true;
					}
				}
			}
		}
		if (this.nullishElementSet.size) {
			const text = (e: ts.Expression) => this.checker.typeToString(this.checker.getTypeAtLocation(e));
			// Script writes into what it holds untyped as it likes, which elements held as `JSNullish<T>` can't take.
			for (const e of this.forms().untypedPlacements()) {
				if (this.nullishElements(e)) found.refused.push([e, `an array, Map or Set whose elements may be null or undefined both (\`${text(e)}\`), given where its type isn't known (declare the slot it goes to with that type)`]);
			}
			// A Map's entries spread into a literal (`[...map.entries()]`): pairs, whose value no slot of its own holds.
			const scan = (n: ts.Node): void => {
				if (ts.isSpreadElement(n) && ts.isArrayLiteralExpression(n.parent)) {
					const x = ts.skipOuterExpressions(n.expression);
					const map = ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'entries' && !x.arguments.length ? x.expression.expression : x;
					if (this.checker.getNonNullableType(this.checker.getTypeAtLocation(map)).getSymbol()?.name === 'Map' && this.nullishElements(map)) {
						found.refused.push([n.parent, `an array, Map or Set element (or other type argument) that may be null or undefined both (a value of \`${text(map)}\` in \`${text(n.parent)}\`)`]);
					}
				}
				ts.forEachChild(n, scan);
			};
			for (const f of this.backend.sourceFiles) if (!f.isDeclarationFile) scan(f);
		}
		return found;
	}

	/**
	 * An app slot whose type admits one empty state but whose form holds both, observed apart, where the other
	 * comes from the program's own missing value (`Form.absent`), as `widenedField` asks of fields: what a package's code
	 * brings into a slot its type says can't hold it keeps the declared form.
	 */
	formNullish(d: ts.Declaration): boolean {
		if (!this.appCode(d)) return false;
		const form = this.forms().formOfSlot(d);
		return form.absent && representation(form) === 'nullish';
	}

	/** The program's value forms, built when first asked. */
	forms(): Forms {
		const b = this.backend;
		const keyed = b.xmlMemberKeys;
		return (this.formSet ??= new Forms(b.sourceFiles, b.checker, (f) => b.trust.strictFile(f), { library: !!b.library, assignFields: assignsClassFields(b), native: (d) => b.trust.nativeDeclaration(d), nativeNil: (d) => !!b.native?.holdsNil?.(d), ownCode: (n) => !this.packaged(n), augmented: (e) => b.augmentedMember(e), signalKind: (name) => b.framework.signalKind(name), calledByFramework: b.framework.hooks.calledByFramework, unsetMembers: b.framework.hooks.unsetMembers, ...(keyed ? { keyedFile: (f: ts.SourceFile) => keyed.generated.has(f.fileName) } : {}) }));
	}

	/**
	 * A parameter, variable or function result that may hold null and undefined both, which the program tells apart: held
	 * as `JSNullish<T>`, read as `T?` except where null and undefined are told apart or kept.
	 */
	nullishHeld(d: ts.Node): boolean {
		return this.nullish() && this.nullishHeldSet.has(d as ts.Declaration);
	}
	optionalElementSet = new Map<ts.Node, boolean>();
	optionalNestedElementSet = new Map<ts.Node, boolean>();
	readonly optionalVars = new Map<ts.Declaration, boolean>();

	/** The slot an expression's value goes to, through parentheses, conditionals and defaults: a declaration, or a new Set's expression. */
	placement(e: ts.Expression): ts.Node | null {
		let x: ts.Node = e;
		for (let p = x.parent; ; x = p, p = p.parent) {
			if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || (ts.isConditionalExpression(p) && p.condition !== x)) continue;
			if (ts.isBinaryExpression(p) && p.right === x && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind)) continue;
			break;
		}
		const p = x.parent;
		if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.initializer === x) return p;
		if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === x) return p.left;
		if (ts.isReturnStatement(p)) return ts.findAncestor(p, ts.isFunctionLike) ?? null;
		if (ts.isArrowFunction(p) && p.body === x) return p;
		if (ts.isPropertyAssignment(p) && p.initializer === x && ts.isObjectLiteralExpression(p.parent)) {
			const d = this.checker.getContextualType(p.parent)?.getProperty(p.name.getText())?.valueDeclaration;
			return d && ts.isPropertySignature(d) && !d.getSourceFile().isDeclarationFile ? d : null;
		}
		if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== x) {
			const k = p.arguments!.indexOf(x as ts.Expression);
			if (ts.isNewExpression(p) && k === 0 && ts.isIdentifier(p.expression) && p.expression.text === 'Set') return p;
			if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'concat' && this.literalElementType(x as ts.ArrayLiteralExpression)) return p;
			const sig = this.checker.getResolvedSignature(p)?.getDeclaration();
			const param = sig && !ts.isJSDocSignature(sig) ? sig.parameters[k] : undefined;
			return param && !param.dotDotDotToken && !param.getSourceFile().isDeclarationFile ? param : null;
		}
		return null;
	}

	/**
	 * A function's result type: a function value without its own annotation gives what the function type it is placed
	 * in declares (`give() { return null; }` for `give(): number | null | undefined`).
	 */
	resultType(fn: ts.SignatureDeclaration): ts.Type {
		const own = this.checker.getSignatureFromDeclaration(fn)!.getReturnType();
		if (fn.type || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || (ts.isMethodDeclaration(fn) && ts.isObjectLiteralExpression(fn.parent)))) return own;
		const contextual = ts.isMethodDeclaration(fn)
			? (() => {
					const o = this.checker.getContextualType(fn.parent as ts.ObjectLiteralExpression);
					const m = o && ts.isIdentifier(fn.name) ? o.getProperty(fn.name.text) : undefined;
					return m ? this.checker.getTypeOfSymbolAtLocation(m, fn) : undefined;
				})()
			: this.checker.getContextualType(fn as ts.Expression);
		return contextual?.getNonNullableType().getCallSignatures()[0]?.getReturnType() ?? own;
	}

	/** A value placed in a `JSNullish<T>` slot: a variable, parameter or result `nullishHeld` holds, or an element `nullishElements` holds. */
	nullishPlaced(e: ts.Expression): boolean {
		if (this.backend.library || this.backend.lenient || !e.parent) return false;
		const slot = slotOf(e, this.checker);
		if (slot && this.nullishHeld(slot)) return true;
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (ts.isArrayLiteralExpression(p)) return this.nullishElements(p);
		if (ts.isBinaryExpression(p) && p.right === x && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(p.left)) {
			const key = ts.isStringLiteralLike(p.left.argumentExpression) ? this.checker.getTypeAtLocation(p.left.expression).getProperty(p.left.argumentExpression.text) : undefined;
			const field = key?.valueDeclaration;
			if (field && (ts.isPropertyDeclaration(field) || ts.isGetAccessorDeclaration(field) || ts.isSetAccessorDeclaration(field))) return this.nullishHeld(field);
			return this.nullishElements(p.left.expression);
		}
		return ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.arguments.includes(x as ts.Expression) && this.nullishElements(p.expression.expression);
	}
	readonly fallbackVariables = new Map<ts.Declaration, boolean>();
	readonly fallbackResults = new Map<ts.Node, boolean>();

	/**
	 * Strict code's strings, numbers and booleans an untrusted value is placed in: optional, as they may hold undefined,
	 * and read as JavaScript reads undefined where a value is needed. With them, the app's objects a native nil reaches
	 * (`nilSlots`).
	 */
	get looseSlots(): Pick<LooseSlots, 'has'> {
		return (this.looseOrNil ??= { has: (d) => this.untrustedSlots.has(d) || this.nilSlots.has(d) });
	}
	looseOrNil: Pick<LooseSlots, 'has'> | null = null;

	get untrustedSlots(): LooseSlots {
		const b = this.backend;
		return (this.looseSlotSet ??= new LooseSlots(
			b.sourceFiles,
			b.checker,
			(e) => b.shapes.question(() => this.untrustedValue(e)),
			(d) => b.shapes.question(() => this.holdsLoose(d)),
			() => this.widenedFields(),
		));
	}

	/**
	 * M3: the app's object variables, parameters and (in strict code) fields an object the platform or the kit may give as
	 * nil is placed in, whatever core's or the platform's typings say, closed over reads of them: held optional, a member
	 * read of one JavaScript's TypeError where it is missing.
	 */
	get nilSlots(): LooseSlots {
		const b = this.backend;
		return (this.nilSlotSet ??= new LooseSlots(
			b.sourceFiles,
			b.checker,
			(e) => b.shapes.question(() => this.nilValue(e)),
			(d) => b.shapes.question(() => this.holdsNilObject(d)),
		));
	}
	nilSlotSet: LooseSlots | null = null;
	readonly widenedGiven = new Map<ts.VariableDeclaration, ts.SignatureDeclaration[]>();
	readonly defaultsGiven = new Map<ts.ParameterDeclaration, boolean>();
	readonly nullPastDefault = new Map<ts.ParameterDeclaration, boolean>();
	readonly nullGiven = new Map<ts.ParameterDeclaration, boolean>();
	readonly decidedParams = new Map<ts.ParameterDeclaration, boolean>();
	readonly widenedParams = new Map<ts.ParameterDeclaration, boolean>();
	readonly widenedFieldSet = new Map<ts.Declaration, boolean>();
	readonly widenedResults = new Map<ts.SignatureDeclaration, boolean>();
}
export interface ValueStates extends ElementsMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(elementsMethods));
export interface ValueStates extends ByNameMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(byNameMethods));
export interface ValueStates extends FieldsMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(fieldsMethods));
export interface ValueStates extends LenientMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(lenientMethods));
export interface ValueStates extends ForeignMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(foreignMethods));
export interface ValueStates extends ReadsMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(readsMethods));
export interface ValueStates extends NilMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(nilMethods));
export interface ValueStates extends UntrustedMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(untrustedMethods));
export interface ValueStates extends MissingMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(missingMethods));
export interface ValueStates extends ParametersMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(parametersMethods));
export interface ValueStates extends ResultsMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(resultsMethods));
export interface ValueStates extends UntypedMethods {}
Object.defineProperties(ValueStates.prototype, Object.getOwnPropertyDescriptors(untypedMethods));
traceClass(ValueStates.prototype, 'states', ['parameterChecks', 'nullableEntry']);
