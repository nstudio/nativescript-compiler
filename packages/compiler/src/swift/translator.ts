import ts from 'typescript';
import { heldLoss } from '../semantics/losses.ts';
import { SWIFT_LEDGER } from '../semantics/ledger.ts';
import { buildOf, configFields, type ConfigFields } from '../semantics/config.ts';
import { ProgramFacts } from '../semantics/facts.ts';
import { AsyncLowering, type AsyncCtx, type AsyncSyntax, type AsyncTranslator } from '../semantics/async.ts';
import { functionValueCall, typedButHeldUntyped, untypedContext, type AwaitSlot, type ConditionBackend, type PlacementBackend, type ReceiverBackend, type ReturnBackend } from '../semantics/placement.ts';
import { SPELLING, PRIMITIVE_CLASSES, SWIFT_SYNTAX, blockNamesUnique, declaresUndefined, escapingParam, functionParts, ident, isOptional, optionalType, postfixChain, postfixOnly, swiftString, type CellStatic, RT } from './syntax.ts';
import { isKit, isNamed, isUntyped, parseNativeType, spelledType, type TypeView } from '../semantics/types.ts';
import { CoreAPI } from './core-api.ts';
import { Framework } from '../adapters/hooks.ts';
import type { KitDeclarations, RecordedMember } from '../kit/manifest.ts';
import { NativeAPI } from './native/api.ts';
import { recognizePatterns, type Patterns } from '../program/patterns.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';
import { ShapeMap, type ShapeFacts } from '../semantics/shapes.ts';
import type { SwiftTranslatorView } from '../api/adapter-api.ts';
import { Throws, isStatic } from '../semantics/throws.ts';
import { assertedOperand, implementedInterfaces, substitutedExpr, uncheckedMatch } from '../semantics/lang.ts';
import { unsetGroupTyping, type UnsetGroupTyping } from '../semantics/regexp.ts';
import { strictFile, type TrustScope } from '../semantics/trust.ts';
import { ValueStates } from '../semantics/states/value-states.ts';
import { hasModifier, thisNodes, isWriteTarget } from '../semantics/ast.ts';
import { ClassExprRegistry, constClassExpr, programBase } from '../semantics/classes.ts';
import { SwiftMarks } from './marks.ts';
import { LIB_CONSTANT_PATHS } from './library.ts';
import { observers } from '../semantics/observers.ts';
import { refusedString } from '../semantics/limits.ts';
import { programClassName } from '../semantics/top-names.ts';
import { mixins, type Mixins } from './install.ts';
import type { SwiftConfig, ShapeField, ComponentInfo, PendingReturn, ClosingLoop, SwiftLibrary } from './translator-types.ts';
export type { PendingReturn, ClosingLoop, ComponentInfo, SwiftLibrary, SwiftConfig, TypeofCell, IteratorMethod, DynamicMembers, ShapeField } from './translator-types.ts';

export class Translator implements AsyncTranslator {
	/** What this translation recorded of the code it emitted (swift/marks.ts), made before anything is spelled. */
	readonly marks = new SwiftMarks(LIB_CONSTANT_PATHS);
	/** What the translator was given when it was made, its build's defaults filled in. */
	readonly config: SwiftConfig & Required<Pick<SwiftConfig, 'adapter' | 'refusals' | 'isBindingSource'>>;
	/** While the kit is generated from core: the hand-written kit files the generated code replaces, left out of what it may name. */
	readonly kitExclude: RegExp | null;
	readonly syntax: AsyncSyntax = { ...SWIFT_SYNTAX, unwrap: (code) => this.marks.unwrappedCode(code) };
	/** The component class being translated: its props read as `self.<prop>.value`. */
	props = new Set<string>();
	/** Named types translated code uses: an interface becomes a class only if something does. */
	readonly used = new Set<string>();
	interfaces = new Map<string, { file: string; code: () => string }>();
	readonly shapes = new ShapeMap<{ name: string; fields: ShapeField[] }>();
	shaping = new Set<ts.Type>();
	/** The types `type()` is spelling, outermost first, each with whether it is on a cycle. */
	spelling: { type: ts.Type; cycle: boolean }[] = [];
	/** A component's memo fields (`computed(fn)`), translated as getters: `this.total()` reads `self.total`. */
	computed = new Set<string>();
	/** A component's or service's fields holding a read-only signal it made (`toSignal`): read through `.value`. */
	signalFields = new Set<string>();
	/** Variables initialized from an element read (`const r = xs[i]`): Swift optionals, unwrapped where they are used. */
	undefinedVars = new Map<ts.Symbol, string>();
	/** Optional chain reads whose undefined the context tests rather than converts (`a?.b || x`). */
	optionalReads = new Map<ts.Node, boolean>();
	/** Whether `e` is read as the optional it may be (an operand only tested); records that it was. */
	readOptional(e: ts.Node): boolean {
		if (!this.optionalReads.has(e)) return false;
		this.optionalReads.set(e, true);
		return true;
	}
	/** The names of the type parameters the translated code declares. */
	genericNames = new Set<string>();

	/** A binding Swift holds as optional though TypeScript types it present (a native method's nullable parameter): reads unwrap it as undefined would read. */
	bindsOptional(name: ts.Node, type: string): string {
		const sym = this.resolve(name);
		const t = optionalType(type);
		if (sym) this.undefinedVars.set(sym, t);
		return t;
	}
	/** A tagged template's strings, one constant per call site, as JavaScript caches them. */
	templateObjects: string[] = [];
	/** Accessors for module-level variables a class member of the same name hides from Swift (`__global_fruits`). */
	globalAliases = new Map<string, string>();
	/** The type of each of `globalAliases`. */
	globalAliasTypes = new Map<string, string>();
	/** The globals `templateObjects` declares. */
	templateSites: string[] = [];
	/** App classes another app class extends: they stay open. */
	extended = new Set<string>();
	/** Classes some class extends, by declaration (an import may rename them). */
	extendedDecls = new Set<ts.Node>();
	classExprs = new ClassExprRegistry();
	/** Interfaces an app class implements: Swift protocols, with a class for their object literals. */
	protocols = new Set<string>();
	/** Interfaces an app class meets without naming them, where its objects are given for one (`assertMeasure(button)`): conformed to as if implemented. */
	structural = new Map<ts.ClassLikeDeclaration, Set<ts.InterfaceDeclaration>>();
	indent = '';
	/** Expressions already evaluated into a Swift name (awaited values, operands read before an await). */
	readonly subst = new Map<ts.Node, string>();
	/** A literal an assignment expression stores, made once and held by the temporary named here. */
	readonly storedLiterals = new Map<ts.Node, { code: string; type: string }>();
	asyncCtx: AsyncCtx | null = null;
	/** Enclosing statements that own a plain `break` / `continue` inside a lowered async region. */
	plainBreak = 0;
	plainContinue = 0;
	/** What a plain `break` leaves, innermost last: a loop or Swift switch (null), or a switch lowered to a labeled block. */
	breakTargets: (string | null)[] = [];
	returnType = 'Void';
	/** A Promise executor's `resolve` parameter → its JSResolvers, so resolving with a promise adopts it. */
	resolvers = new Map<ts.Symbol, { name: string; type: string }>();
	/** A Promise executor's `resolve` named by `e`: the resolvers' Swift name and the promise's value type. */
	promiseResolver(e: ts.Expression): { name: string; type: string } | null {
		const sym = ts.isIdentifier(e) ? this.resolve(e) : undefined;
		return (sym && this.resolvers.get(sym)) ?? null;
	}
	/** Template methods take their loop variables with defaults only so the checker can type them. */
	templateParams = false;
	readonly throwsInfo: Throws;
	readonly sourceFiles: readonly ts.SourceFile[];
	lowering: AsyncLowering;
	readonly core: CoreAPI;
	readonly native: NativeAPI;
	/** Whether the SDK binding declares `d`: one of its tables' modules does, or an app's declaration of an SDK type newer than the typings. */
	readonly nativeDeclared = (d: ts.Declaration): boolean => !!this.native.module(d);
	isKitType(name: string): boolean {
		return this.core.declares(name);
	}
	programTypeNames: Set<string> | null = null;

	/** The program's whole-program answers, shared with any translator of the same checker and files. */
	readonly facts: ProgramFacts;
	readonly checker: ts.TypeChecker;
	components: Map<string, ComponentInfo>;

	/** Which empty states a value or slot may hold (value-states.ts). */
	readonly states: ValueStates;
	readonly patterns: Patterns;
	/** Inside a class extending a native one, whose base's nested types (`UIViewController.Transition`) hide the module's of their names. */
	inNativeClassBody = false;

	/** Fields of a native type newer than the deployment target, with the iOS version their accessor needs. */
	gatedFields = new Map<ts.Node, number>();

	ownCalls = new Set<ts.Node>();

	compiledSymbols = new Map<ts.Symbol, ts.Symbol | null>();
	/** Library mode: generated classes whose names the hand-ported kit also declares. */
	readonly kitClashes: string[] = [];

	/** Kit generation: the declarations the generated code makes public, recorded as they are written (kit/manifest.ts). */
	readonly declarations: KitDeclarations | null;
	/** The type whose members are being written, by its qualified Swift name (`Utils.layout`), while declarations are recorded. */
	declOwner: string | null = null;
	/** The signature of the function `func` wrote last, which a member's site records once the function is written. */
	lastSignature: RecordedMember | null = null;

	get declOwnerName(): string | null {
		return this.declOwner;
	}

	/** Records a member of the type being written. */
	declare(name: string, m: RecordedMember, owner = this.declOwner) {
		if (!owner || !this.declarations) return;
		// By its Swift name (`['class']` is `__class__`), without the backquotes a keyword takes.
		const plain = name.replace(/^`(.*)`$/, '$1');
		this.declarations.member(owner, /^[A-Za-z_]\w*$/.test(plain) ? plain : ident(plain).replace(/^`(.*)`$/, '$1'), m);
	}

	declareInit(params: string, throws: boolean, failable = false) {
		if (this.declOwner) this.declare('init', { kind: 'init', params, throws, type: `${this.declOwner}${failable ? '?' : ''}` });
	}

	/**
	 * References held weakly, as `Class.field`: `fields`, back references up an ownership tree (a view's `parent`);
	 * `captures`, fields assigned a closure over `this` that only the object itself runs or registers. Script's
	 * garbage collector frees such cycles; reference counting frees them only when one side is weak.
	 */
	readonly weak: { fields: Set<string>; captures: Set<string> };

	constructor(checker: ts.TypeChecker, components: Map<string, ComponentInfo>, files: readonly ts.SourceFile[], config: SwiftConfig = {}) {
		const c = (this.config = buildOf(config));
		Object.assign(this, configFields(c, SWIFT_LEDGER));
		this.kitExclude = c.kitExclude ?? null;
		this.framework = new Framework(c.hooks);
		this.appSwiftNames = new Set(c.appSwiftNames ?? []);
		this.nativeModules = ['Foundation', 'UIKit', ...(c.nativeModules ?? [])];
		this.weak = { fields: new Set(c.weak?.fields ?? []), captures: new Set(c.weak?.captures ?? []) };
		this.lenientAll = c.lenient ?? false;
		this.compiledFiles = c.compiledFiles ?? null;
		this.appNativeClasses = new Set(c.appNativeClasses ?? []);
		this.pluginNativeClasses = new Map(c.pluginNativeClasses ?? []);
		this.pluginModules = [...(c.pluginModules ?? [])];
		this.declarations = c.declarations ?? null;
		this.patterns = recognizePatterns(checker, files);
		this.checker = checker;
		this.components = components;
		this.sourceFiles = files;
		this.facts = ProgramFacts.of(checker, files, { library: this.library, pluginFiles: this.pluginFiles });
		this.states = new ValueStates(this.stateBackend(), c);
		observers.translator?.(this, this.states);
		this.lowering = new AsyncLowering(this);
		this.core = new CoreAPI(this);
		this.native = new NativeAPI(this);
		this.throwsInfo = new Throws(
			checker,
			files,
			(n) => this.heldUntyped(n),
			(c) => (ts.isCallExpression(c) && (this.native.throwingCall(c) || this.replaceableCall(c) || (ts.isElementAccessExpression(c.expression) && !!this.setNativeOf(c.expression.argumentExpression) && this.keyedSetNative(c.expression.expression)))) || (!this.library && this.core.throwingCall(c)),
			(d) => this.compiledMember(d),
			(e) => {
				try {
					return this.isExpando(e) || (!this.library && ((!isWriteTarget(e) && this.core.throwingAccess(e)) || (!e.questionDotToken && this.core.optionalKitValue(e.expression))));
				} catch (e) {
					rethrowUnlessRefused(e);
					return false;
				}
			},
			(cls) => {
				const kit = this.library ? null : this.kitRootOf(cls);
				return !!kit && this.core.initThrows(kit);
			},
			(fn) => ts.isFunctionLike(fn) && (((!!this.memberCounterpart(fn as ts.FunctionLikeDeclaration) || !!this.functionCounterpart(fn)) && this.counterpartThrows(fn) !== false) || this.selfRecursive(fn)),
			(n) => this.castThrows(n) || (ts.isPropertyAccessExpression(n) && this.assertedRead(n)) || this.adaptsElementCallback(n) || this.adaptsLiteralCallback(n),
			(c) => this.native.overrideCall(c),
			(n) => this.unevaluated(n),
			(fn) => this.counterpartThrows(fn),
			(a, throws) => this.reportedAccessor(a, throws),
			(n) => this.plainHelper(n),
			(n) => this.checkedThrows(n),
			(st) => !this.reach || this.reach.keeps(st),
			() => this.framework,
		);
		for (const f of files) {
			const visit = (n: ts.Node) => {
				if (ts.isClassLike(n)) {
					const base = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
					if (base && ts.isIdentifier(base.expression)) {
						this.extended.add(base.expression.text);
						const d = this.resolve(base.expression)?.valueDeclaration;
						if (d) this.extendedDecls.add(d);
						const ce = constClassExpr(base.expression, this.checker);
						if (ce) this.extendedDecls.add(ce);
					}
					for (const i of implementedInterfaces(this.checker, n)) this.protocols.add(this.heritageName(i));
				}
				const given = ts.isCallExpression(n) || ts.isNewExpression(n) ? (n.arguments ?? []) : ts.isVariableDeclaration(n) && n.type && n.initializer ? [n.initializer] : ts.isReturnStatement(n) && n.expression ? [n.expression] : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken ? [n.right] : [];
				if (!this.library) for (const x of given) this.noteStructural(x);
				ts.forEachChild(n, visit);
			};
			visit(f);
		}
	}

	/**
	 * An implemented interface's name as Swift has it: a module's (`TKUnit.TestInfoEntry` of `import * as TKUnit`) by its own name,
	 * one imported under an alias (`SQLiteDatabase as ISQLiteDatabase`) by its declaration's.
	 */
	heritageName(i: ts.ExpressionWithTypeArguments): string {
		const e = i.expression;
		let s = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
		if (s && s.flags & ts.SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
		const decl = s?.declarations?.find(ts.isInterfaceDeclaration);
		if (decl && !decl.getSourceFile().isDeclarationFile) return this.topName(decl, decl.name.text);
		if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
			const m = this.checker.getSymbolAtLocation(e.expression);
			const target = m && m.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(m) : m;
			if (target?.valueDeclaration && ts.isSourceFile(target.valueDeclaration)) return e.name.text;
		}
		return e.getText();
	}

	noteStructural(x: ts.Expression): void {
		const contextual = this.checker.getContextualType(x)?.getSymbol();
		const iface = contextual && !(contextual.flags & ts.SymbolFlags.Class) ? contextual.declarations?.find(ts.isInterfaceDeclaration) : undefined;
		if (!iface || iface.getSourceFile().isDeclarationFile || iface.typeParameters?.length || iface.heritageClauses?.length) return;
		const cls = this.checker.getTypeAtLocation(x).getSymbol()?.valueDeclaration;
		if (!cls || !ts.isClassLike(cls) || cls.getSourceFile().isDeclarationFile || implementedInterfaces(this.checker, cls).some((i) => this.heritageName(i) === this.topName(iface, iface.name.text))) return;
		if (!this.conformsProtocolFields(cls, iface)) return;
		(this.structural.get(cls) ?? this.structural.set(cls, new Set()).get(cls)!).add(iface);
		this.protocols.add(this.topName(iface, iface.name.text));
	}

	/** Whether a class's members hold every property of an interface at the type its protocol requires. */
	conformsProtocolFields(cls: ts.ClassLikeDeclaration, iface: ts.InterfaceDeclaration): boolean {
		const member = (name: string): { field?: ts.PropertyDeclaration | ts.ParameterDeclaration; getter?: ts.GetAccessorDeclaration; setter?: ts.SetAccessorDeclaration; method?: ts.MethodDeclaration } => {
			for (let c: ts.ClassLikeDeclaration | undefined = cls; c; c = programBase(c, this.checker)) {
				const byName = c.members.filter((m) => !isStatic(m) && m.name?.getText() === name);
				const ctor = c.members.find(ts.isConstructorDeclaration);
				const param = ctor?.parameters.find((p) => ts.isParameterPropertyDeclaration(p, ctor) && ts.isIdentifier(p.name) && p.name.text === name);
				const field = byName.find(ts.isPropertyDeclaration) ?? param;
				const getter = byName.find(ts.isGetAccessorDeclaration);
				const setter = byName.find(ts.isSetAccessorDeclaration);
				const method = byName.find(ts.isMethodDeclaration);
				if (field || getter || setter || method) return { field, getter, setter, method };
			}
			return {};
		};
		for (const req of iface.members) {
			const name = req.name?.getText();
			if (!name || (!ts.isPropertySignature(req) && !ts.isMethodSignature(req))) return false;
			const { field, getter, setter, method } = member(name);
			if (ts.isMethodSignature(req)) {
				if (!method) return false;
				continue;
			}
			if (!field && !getter) return false;
			if (!field && !setter && !hasModifier(req, ts.SyntaxKind.ReadonlyKeyword)) return false;
			const want = req.questionToken ? optionalType(this.typeOf(req)) : this.typeOf(req);
			const root = field && (ts.isPropertyDeclaration(field) || ts.isParameter(field)) ? this.redeclaredField(field) : null;
			const fieldType = field ? (ts.isParameter(field) && !!field.questionToken && !isOptional(this.typeOf(field.name)) && !isUntyped(spelledType(this.typeOf(field.name))) ? optionalType(this.typeOf(field.name)) : this.typeOf(field.name)) : null;
			const have = getter ? (this.narrowedFrom(getter) ?? this.returnTypeOf(getter)) : root ? this.redeclaredType(root) : fieldType;
			if (have !== want) return false;
		}
		return true;
	}

	/**
	 * A temporary's name (`__switch1`), numbered within its module, or across the program outside one (shapes, code
	 * shared by files). Always numbered: the translator writes unnumbered ones of its own (`__v`, `__r`, `__value`) as
	 * closure parameters. A one-letter prefix takes a `_` before its number, apart from the positional `__a0` and `__p0`.
	 */
	fresh(prefix: string): string {
		const counts = this.freshCounts ?? this.programFreshCounts;
		const n = (counts.get(prefix) ?? 0) + 1;
		counts.set(prefix, n);
		return /^__[a-z]$/.test(prefix) ? `${prefix}_${n}` : `${prefix}${n}`;
	}
	freshCounts: Map<string, number> | null = null;
	programFreshCounts = new Map<string, number>();

	nested<T>(body: () => T): T {
		const saved = this.indent;
		this.indent += '    ';
		try {
			return body();
		} finally {
			this.indent = saved;
		}
	}

	/** Translates a function's body: no async region or loop of the enclosing function reaches into it. */
	inFunction<T>(returnType: string, body: () => T): T {
		const refined = this.refinedVersion;
		try {
			return this.inFunctionScope(returnType, body);
		} finally {
			this.refinedVersion = refined;
		}
	}

	/** The iOS version the code being translated is already checked for (`if #available`, `guard #available`). */
	refinedVersion = 0;

	/** Translates code that runs only on iOS `version` or newer (a method declared `@available`): it checks for no older version. */
	availableFrom<T>(version: number, body: () => T): T {
		const saved = this.refinedVersion;
		this.refinedVersion = Math.max(saved, version);
		try {
			return body();
		} finally {
			this.refinedVersion = saved;
		}
	}

	/** How many function bodies enclose the code being translated: none in a stored property's or global's initializer. */
	functionDepth = 0;

	inFunctionScope<T>(returnType: string, body: () => T): T {
		this.functionDepth++;
		try {
			return this.inOwnFunctionScope(returnType, body);
		} finally {
			this.functionDepth--;
		}
	}

	inOwnFunctionScope<T>(returnType: string, body: () => T): T {
		const saved = [this.asyncCtx, this.plainBreak, this.plainContinue, this.returnType, this.breakTargets, this.pendingReturn, this.closingLoops] as const;
		this.pendingReturn = null;
		this.closingLoops = [];
		this.asyncCtx = null;
		this.plainBreak = 0;
		this.plainContinue = 0;
		this.returnType = returnType;
		this.breakTargets = [];
		try {
			return body();
		} finally {
			[this.asyncCtx, this.plainBreak, this.plainContinue, this.returnType, this.breakTargets, this.pendingReturn, this.closingLoops] = saved;
		}
	}

	// ---- Types -----------------------------------------------------------------------------

	/** The plugin files the build compiles; a class or interface only the others declare is no Swift type. */
	readonly compiledFiles: ReadonlySet<string> | null;

	compiledClasses: Map<string, ts.ClassDeclaration[]> | null = null;

	/** Whether `JSArray<T>` of `t` has no empty slot: one is an optional, a number or a string (`JSArray.hole`). */
	readonly holeless = (t: ts.Type): boolean => {
		const s = this.type(t);
		return !s.endsWith('?') && s !== 'Double' && s !== 'String';
	};

	holdingNullVisits = new Set<ts.Node>();

	nullishTested = new Map<ts.VariableDeclaration, boolean>();

	widenedParameters = new Map<ts.Node, boolean>();

	numberKeyedArrays = new Map<ts.Node, string | null>();

	untypedRecords = new Map<ts.Node, boolean>();

	methodValued = new Map<ts.Node, boolean>();

	methodCarried = new Map<ts.Node, boolean>();

	/** `this` nodes that read an untyped object (a method of an object literal typed `any`). */
	untypedThis = new Set<ts.Node>();

	/** The app's interfaces, for object literals TypeScript checks against one without naming it. */
	appInterfaces: { name: string; type: ts.Type }[] | null = null;
	hoistedExtensions: string[] = [];

	/** The plugins' native modules, whose protocols `Cls.extend(…, { protocols })` names. */
	readonly pluginModules: readonly string[];
	extendedClasses: string[] = [];
	/** What each of `extendedClasses` declares, recorded when the shapes are written. */
	extendedRecords: { name: string; base: string; members: [string, RecordedMember][] }[] = [];

	functionCells = new Map<string, string>();
	/** The static members of each function cell (`script`, `fromScript`): their bodies, each under the name it is written as. */
	cellStatics = new Map<string, { kind: CellStatic; name: string; body: string; from?: string; orNil?: boolean }[]>();

	/** Set while a shape's class is written. */
	inShape = false;
	/** Shape classes some placement reads another object as, which get a view mode (`T.jsView`), and those written already. */
	viewed = new Set<string>();
	shapesWritten = new Set<string>();
	/** Shape classes written without a view mode whatever their uses: those holding a symbol-keyed member. */
	unviewable = new Set<string>();
	/**
	 * Set while a shape's dynamic setter converts the value it stores. TypeScript writes a shape's field through any view
	 * of the object it allows (`data.object = data.object || this` where `data` is a `T extends Optional<EventData,
	 * 'object'>`), whose field may be a class unrelated to the one the shape's literal gave it, so the store's cast to one
	 * of core's classes stays conditional.
	 */
	shapeStore = false;

	/** Set where `fromAnyCode` was asked to check: the outermost cast to a type with no lenient conversion throws (see `checkedCast`). */
	throwingCast = false;

	/**
	 * Core's own code: set while conversions are written where a `try` may stand (`throwingConverts`): `covered` where the
	 * statement's own `try` covers them (the throws analysis counts the value as throwing), `own` where they lead with
	 * their own, `operand` where that `try` is parenthesized (an operator's right side, which `try` can't lead).
	 */
	libraryChecked: false | 'covered' | 'own' | 'operand' = false;

	/**
	 * Set while a conversion `castThrows` approved is written: the value's outermost cast throws
	 * a TypeError (`jsChecked`) rather than trapping. The conversions nested in closures stay unchecked.
	 */
	checkedCast = false;

	castDecisions = new WeakMap<ts.Node, boolean>();

	readonly rawHeld = new Set<ts.Node>();

	/** The constructor being written's notes after its statements that make keys (`initKeyNotes`). */
	keyNotes: Map<ts.Statement, string> | null = null;
	shapeFactSet: ShapeFacts | null = null;

	/** Nested function declarations read as values, each with the local its reads stand for (`JSFunctionDeclaration`). */
	localDeclarations = new Map<ts.FunctionDeclaration, string>();
	opaqueArrays = new Map<ts.ParameterDeclaration, string | null>();
	optionalDefaults = new Set<ts.ParameterDeclaration>();

	undefinedReturns = new Map<ts.Node, boolean>();
	readonly awaitSlots = new Map<ts.Node, AwaitSlot>();

	untypedLinks = new Set<ts.Node>();

	/** Calls whose undefined result the context reads as an optional (see `maybeUndefined`). */
	rawOptional = new Set<ts.Node>();
	genericFunctions = new Map<ts.Node, boolean>();

	/** The newest iOS version an API used by the function or statement being translated needs, innermost last. */
	availability: number[] = [];
	/** Every native type newer than the deployment target looked up: what a declaration outside any function naming it needs. */
	gatedTypes = new Map<string, number>();
	/** By the depth of a statement's frame in `availability`: the newer types its translation looked up, which need the OS only where its code names them. */
	statementTypes = new Map<number, Map<string, number>>();
	moduleAvailability = 0;

	/** Functions whose signatures name native types newer than the deployment target: the iOS version they need. */
	gatedFunctions = new Map<ts.Node, number>();

	/** Closures passed for a kit parameter of a known Swift function type: that type's parameters, which the closure takes whatever TypeScript's slot says. */
	readonly closureSlots = new Map<ts.Node, string[]>();

	/** `writtenProperties`'s cache. */

	/** Whether the build compiles a class of the program's sources: a plugin file's only where it is reached. */
	compiles = (decl: ts.ClassDeclaration): boolean => {
		const file = decl.getSourceFile().fileName;
		return !this.pluginFiles.has(file) || !this.reach || (this.reach.modules.has(file) && this.reach.keeps(decl));
	};

	valueClasses: Set<ts.Symbol> | null = null;
	/** The statics script reads of an instance's class (`instance.constructor[KNOWN_FUNCTIONS]`), by name. */
	constructorKeys = new Set<string>();
	readonly constructionWarned = new Set<ts.Node>();

	// ---- Statements --------------------------------------------------------------------------------

	/** Variables a function declared before them reads: declared first, assigned where they are declared. */
	forwardDeclared = new Set<ts.VariableDeclaration>();

	/**
	 * A block run as a scope of its own: its statements where it stands when no name it declares is spelled anywhere else in
	 * the file (nothing it declares could shadow, or clash with, a name around it), else `do { … }`.
	 */
	scope(b: ts.Statement): string {
		const i = this.indent;
		if (ts.isBlock(b) && blockNamesUnique(b)) {
			const body = this.statements([...b.statements]);
			if (!body.some((l) => l.startsWith(i + 'defer '))) return body.join('\n');
		}
		return `${i}do ${this.block(b)}`;
	}

	/** The app's own Swift classes, and those an untyped `declare const X: any` names (`__AppNative.swift`). */
	readonly appNativeClasses: ReadonlySet<string>;
	readonly usedAppNative = new Set<string>();

	/** The plugins' native classes by their Objective-C names, each with its Swift name. */
	readonly pluginNativeClasses: ReadonlyMap<string, string>;

	/** Classes whose translated `init` throws (a field initializer that can). */
	readonly throwingInits = new Set<string>();

	/** The build's framework, as its adapter's translator hooks describe it. */
	readonly framework: Framework<SwiftTranslatorView>;

	/** Code checked without strictNullChecks (core): an undefined where a value type is declared reads as the type's zero. */
	get lenient(): boolean {
		return this.lenientAll || (!!this.currentFile && this.lenientFiles.has(this.currentFile));
	}
	readonly lenientAll: boolean;
	currentFile: string | null = null;

	/** The trust rule's view of this program (lang.ts): which files are strict, which declarations are the platform's. */
	trustScope: TrustScope | null = null;
	get trust(): TrustScope {
		return (this.trustScope ??= {
			checker: this.checker,
			strictFile: (f) => strictFile(f.fileName, { lenient: this.lenientAll, lenientApp: this.lenientApp, pluginFiles: this.pluginFiles, lenientFiles: this.lenientFiles, ledger: this.ledger }),
			nativeDeclaration: (d) => /[\\/]objc![^\\/]+\.d\.ts$/.test(d.getSourceFile().fileName),
			looseSlot: (d) => this.states.looseSlots.has(d),
		});
	}

	unsetTyping?: UnsetGroupTyping;
	get unset(): UnsetGroupTyping {
		return (this.unsetTyping ??= unsetGroupTyping(
			this.checker,
			(n) => this.resolve(n),
			(e) => isNamed(spelledType(this.typeOf(e)), 'JSMatch'),
		));
	}

	/** Classes declared inside functions that the module declares instead. */
	hoisted: string[] = [];

	/** The label of the loop being translated (`outer:`), placed on the Swift loop that implements it. */
	label: string | null = null;

	writes = new Map<ts.SourceFile, { vars: Set<ts.Symbol>; members: Set<ts.Symbol> }>();
	allWrites = new Map<ts.SourceFile, { vars: Set<ts.Symbol>; members: Set<ts.Symbol> }>();

	reads = new Map<ts.SourceFile, Set<ts.Symbol>>();

	/** A `var` declaring a variable an earlier `var` of the same block declared. */
	askingHeld = new Set<ts.VariableDeclaration>();

	/** Try statements whose block cannot throw: written without their catch, which could never run. */
	catchless = new Set<ts.Block>();

	/** The return a `try` whose finally throws, or a stepped loop, turns into. */
	pendingReturn: PendingReturn | null = null;

	/**
	 * The stepped `for…of` loops (`forOfSteps`) being translated, innermost last: a labeled jump out of one is recorded in
	 * its `jump` variable and leaves through its `label`, so the loop closes its iterator before the jump is made.
	 */
	closingLoops: ClosingLoop[] = [];

	returnsSet?: ReturnBackend;

	/** What the shared `return` cells (placement.ts) read of this translator. */
	get returns(): ReturnBackend {
		const t = this;
		return (this.returnsSet ??= {
			typeOf: (n) => t.typeOf(n),
			emptyReturn: (e, slot) => {
				const ret = slot.target;
				if (ret === 'Void') return '';
				// Lenient code returning undefined from a function of a value type: read as the type's zero, as its fields are.
				if (e && !((t.lenient || t.lenientApp) && !ret.endsWith('?') && !isUntyped(spelledType(ret)))) return null;
				// Declared `T[] | undefined` (held `JSArray<…>!`): callers test the result (`if (expanded)`), which a zero value would pass.
				if (t.lenient && /^JS(Array|Map|Set|Object)\b/.test(ret) && declaresUndefined(slot.fn)) return 'nil';
				if ((t.lenient || t.lenientApp) && ret !== 'Void' && !ret.endsWith('?') && t.zero(ret) !== null) return t.zero(ret);
				// A native struct has no undefined: its zero value.
				if (t.lenient && t.native.isStructType(ret)) return `${ret}()`;
				return e ? null : ret?.endsWith('?') ? 'nil' : '';
			},
			voidValue: (e, slot) => (!ts.isCallExpression(e) ? null : isOptional(slot.target) || isUntyped(spelledType(slot.target)) ? 'nil' : t.zero(slot.target)),
			returnBefore: (e) => (ts.isIdentifier(e) && t.holeyArrays.has(t.resolve(e)!) ? { step: 'value', e, code: `${RT.jsFilled}(${t.refName(e)})` } : null),
		});
	}

	typeViewSet?: TypeView;

	/** What the front's type mapping (`nativeTypeOf`) reads of this translator, and its spelling. */
	get typeView(): TypeView {
		const t = this;
		const held = (s: string | null) => (s === null ? null : parseNativeType(s));
		return (this.typeViewSet ??= {
			get checker() {
				return t.checker;
			},
			spelling: SPELLING,
			get ledger() {
				return t.ledger;
			},
			get lenient() {
				return t.lenient;
			},
			of: (x, at) => parseNativeType(t.type(x, at)),
			leading: (x, at) => held(t.leadingType(x, at)),
			typeParameter: (x, at) => parseNativeType(t.typeParameterType(x, at)),
			intersection: (x, at) => held(t.intersectionType(x, at)),
			commonType: () => null,
			tuple: (x, at) => parseNativeType(t.tupleType(x, at)),
			named: (x, at) => parseNativeType(t.namedType(x, at)),
		});
	}

	placementSet?: PlacementBackend;

	/** What the shared placement front (placement.ts) reads of this translator, and Swift's spelling of its cells. */
	get placement(): PlacementBackend {
		const t = this;
		return (this.placementSet ??= {
			get checker() {
				return t.checker;
			},
			spelling: SPELLING,
			get sourceFiles() {
				return t.sourceFiles;
			},
			get library() {
				return t.library;
			},
			get lenient() {
				return t.lenient;
			},
			get states() {
				return t.states;
			},
			readHeld: (e) => this.readHeld(e),
			untypedRead: (code, target) => this.convert(code, 'Any?', target),
			cells: {
				jsAny: (name) => `${name}.jsAny`,
				present: (name, key) => this.marks.ownTried(`${name}.present(${swiftString(key)})`),
				type: (target, _into, code) => `${target}(${code})`,
				upcast: (target, code) => `${target}.jsNullish(${code}.jsAny)!`,
				nullishOf: (target, _into, code, isNull) => (isNull ? `${target}(null: ${code})` : `${target}(${code})`),
				// `castThrows` counts these conversions as throwing (`nullishPlaced`).
				nullishOfAny: (target, _into, code, entry) => this.marks.tryCode(`${target}(any: ${entry ? (this.marks.afterTry(code) ?? code) : code})`),
				empty: (isNull) => (isNull ? '.null' : '.undefined'),
				nulled: (code) => {
					const inner = this.marks.afterTry(code);
					return inner !== null ? this.marks.tryCode(`${RT.jsNulled}(${inner})`) : `${RT.jsNulled}(${code})`;
				},
				checked: (e, target, slot) => this.checkedPlacement(e, target, undefined, slot),
				checkedCode: (code, slot) => this.checkedCode(code, slot),
				marker: (code) => `${RT.jsEmptyMarker}(${code})`,
			},
			typeOf: (n) => this.typeOf(n),
			expr: (e) => this.expr(e),
			resolve: (n) => this.resolve(n),
			error: (n, what) => this.error(n, what),
			optionalType,
			coerce: (e, target) => this.coerce(e, target),
			coerceTyped: (e, target) => this.coerceTyped(e, target),
			undefinedConverted: (code) => this.undefinedConverted(code),
			convert: (code, from, to) => this.convert(code, from, to),
			fromAnyCode: (code, type) => this.fromAnyCode(code, type),
			unsetGroups: (n) => this.unsetGroups(n),
			unsetMatch: (e) => this.unsetMatch(e),
			nullishCode: (e) => this.nullishCode(e),
			nullishSlotType: (d) => this.nullishSlotType(d),
			before: (e, target) => {
				const held = this.heldValues.get(e);
				if (held !== undefined) return this.convert(this.subst.get(e)!, held, target);
				const sub = substitutedExpr(this.subst, e, true);
				return sub ? this.convert(sub.code, this.typeOf(sub.bare), target) : null;
			},
			untypedRoot: (e, code) => (!this.library && (this.isObjectShape(this.typeOf(e).replace(/[?!]$/, '')) || functionValueCall(e, (n) => this.resolve(n)) || typedButHeldUntyped(this.checker, e, this.typeOf(e))) && untypedContext(this.checker, e) && !code.startsWith(`${RT.jsIdentity}(`) ? `${RT.jsIdentity}(${code})` : code),
			after: (e, target) => {
				this.checkFieldsMet(e, target);
				this.checkAnyArgument(e, target);
				return null;
			},
			shortcut: (e, target) => {
				if (target === 'JSArray<String?>' && /^JSMatch[?!]?$/.test(this.typeOf(e))) return this.convert(this.expr(e), this.typeOf(e), target);
				const bare = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
				if (ts.isVoidExpression(bare) && !isUntyped(spelledType(target)) && isOptional(target)) {
					const tp = this.throwsInfo.expr(bare.expression) ? 'try ' : '';
					return `{ () ${tp ? 'throws ' : ''}-> ${target} in _ = ${tp}${this.expr(bare.expression)}; return nil }()`;
				}
				return null;
			},
			branches: (bare, target) => this.ternary(bare, target, (x) => this.coerce(x, target)),
			result: (e, slot) => this.resultRead(e, slot),
			argument: (e, slot) => (slot.native ? (slot.rest ? this.expr(e) : this.native.toSwift(e, slot.target)) : this.argumentRead(e, slot)),
			observed: (e) => this.observed(e),
		});
	}

	/** Calls of a `JSNullish` result being written as they are, not read as the optional. */
	nullishCalls = new Set<ts.Node>();

	/** Code a method reference is called by name in (`obj.method(…)`), not read as a value. */
	namedCall = false;

	classesByName: Map<string, ts.ClassLikeDeclaration> | null = null;

	get conditions(): ConditionBackend {
		return (this.conditionSet ??= {
			bare: false,
			isBool: (n) => this.isBool(n),
			maybeUndefined: (e) => this.maybeUndefined(e),
			decided: (e) => {
				const and = e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
				return this.staticTypeof(e.right) === and ? e.left : this.staticTypeof(e.left) === and && this.pure(e.left) ? e.right : null;
			},
		});
	}
	conditionSet?: ConditionBackend;

	/**
	 * A name or member read's truthiness from the carrier its code holds (`readHeld`). Null in lenient code and for an
	 * optional chain, whose code may hold nil where the carrier is present, and for a present object: a parameter given
	 * undefined beyond its declared type is held optional where its carrier reads present.
	 */
	heldTruthy(x: ts.Expression, code: string): string | null {
		const e = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
		if (this.lenient || (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e))) return null;
		for (let link: ts.Expression = e; ts.isPropertyAccessExpression(link); link = link.expression) if (link.questionDotToken) return null;
		const { type, rep } = this.readHeld(e);
		if (rep === 'foreign' || type.implicit) return null;
		const operand = postfixOnly(code) ? code : `(${code})`;
		// A non-strict app may hold a string or boolean optional where its carrier reads present.
		if (type.kind === 'string' && !type.optional && !this.lenientApp) return `!${operand}.isEmpty`;
		if (type.kind === 'boolean' && !type.optional && !this.lenientApp) return code;
		// A native enum or struct, or an integer the kinds don't name, is not tested by presence; nor is a class whose
		// objects script reads as numbers or strings (`NSNumber` 0 and `NSString` "" are falsy), or one of their bases.
		if (type.kind !== 'object' || !type.optional || this.native.isEnumType(type.name) || this.native.isStructType(type.name) || !this.isObjectRef(e) || PRIMITIVE_CLASSES.has(type.name)) return null;
		return `${postfixChain(code) ? code : operand} != nil`;
	}

	// ---- Expressions -----------------------------------------------------------------------------

	/** Held parts of a member's compound assignment (`readWriteCode`): their code, bound in their place, is final. */
	readonly heldParts = new Set<ts.Node>();
	/** A logical assignment's right side bound once (`readWriteValue`), with its Swift type: every placement converts that binding. */
	readonly heldValues = new Map<ts.Node, string>();

	readonly nullishReceivers = new Set<ts.Expression>();

	/** Lenient code: whether the value `coerce` is converting goes where Swift holds it optional, so a missing function stays missing. */
	optionalSlot = false;
	/** The value `coerce` converts, where it is a function literal or a declared function: Swift holds it present whatever lenient code's types say. */
	presentFunction: ts.Expression | null = null;

	/** Set for the one value a module constant Swift holds present is initialized with (see `storedInit`). */
	presentSlot = false;

	/** Set while code is written inside a call's `try` (an adapter's arguments): a conversion there may throw. */
	underTry = false;

	/** Expressions translated as a temporary their value was checked present into (see `defineProperties`). */
	checkedNodes = new Set<ts.Node>();

	/** Set where code runs that cannot throw (a symbol method's key): a loose receiver's member is read through an optional chain. */
	chainingLoose = false;
	presentConstants = new Map<ts.VariableDeclaration, boolean>();

	/** Whether a stored initializer being translated holds a declared function as a value (see `storedInit`). */
	isolatedInit = false;
	/** Set while a stored initializer is translated, its closures included: a declared function as a value in one of them needs it isolated too. */
	inStoredInit = false;

	renamedTop: Map<ts.Node, string> | null = null;
	topTaken = new Set<string>();

	/** Foundation, UIKit, and the plugins' and pods' modules the program declares something of (`PluginNative.modules`). */
	readonly nativeModules: readonly string[];
	importedTypes?: Set<string>;

	/** App mode: the identifiers the Swift compiled into the app's module spells (`PluginNative.appNames`). */
	readonly appSwiftNames: ReadonlySet<string>;

	/** Locals made with empty slots of an element type that cannot hold undefined (`const merged: T[] = new Array(n)`). */
	holeyArrays = new Set<ts.Symbol>();

	receiversSet?: ReceiverBackend;

	/** What the shared receiver cells (placement.ts) read of this translator. */
	get receivers(): ReceiverBackend {
		const t = this;
		return (this.receiversSet ??= {
			checker: t.checker,
			states: t.states,
			expr: (e) => t.expr(e),
			maybeUndefined: (e) => t.maybeUndefined(e),
			awaited: (e) => t.awaited(e),
			assertedUntyped: (e) => t.assertedUntyped(e),
			held: (x) => {
				if (t.typeOf(x).endsWith('?') || t.optionalResult(x)) return t.expr(x);
				if (!t.states.presentTypedEmpty(x)) return null;
				const code = t.expr(x),
					m = this.marks.markOf(code);
				return m?.op === 'unwrap' ? m.of.code : code;
			},
			receiverBefore: ({ target, x, chained }) => {
				if (t.loose(target) && !uncheckedMatch(target, t.checker)) return { cell: 'asIs' };
				if (chained) return null;
				if (t.definiteReceiver(x) || t.widenedParameterRead(x)) return { cell: 'present', code: t.expr(x), isNull: t.states.presentTypedEmpty(x) === 'null' };
				return uncheckedMatch(x, t.checker) ? { cell: 'present', code: t.expr(x), isNull: true } : null;
			},
		});
	}

	/** The assignments of a module-level class's static fields whose initializers throw, run in the module's order. */
	staticInits: string[] | null = null;

	/** `$showModal(Component, { props, fullscreen, animated, cancelable, closeCallback })`; a `.then(fn)` is the close callback. */
	showModal(e: ts.CallExpression, then?: ts.Expression): string {
		const component = (e.arguments[0] as ts.Identifier).text;
		const info = this.components.get(component);
		if (!info) throw this.error(e, `a modal of ${component}: not a component`);
		const options = e.arguments[1];
		const given = new Map<string, string>();
		const settings: string[] = [];
		let callback = then;
		if (options && ts.isObjectLiteralExpression(options)) {
			for (const p of options.properties) {
				if (!ts.isPropertyAssignment(p)) continue;
				const key = (p.name as ts.Identifier).text;
				if (key === 'props' && ts.isObjectLiteralExpression(p.initializer)) {
					for (const q of p.initializer.properties) {
						if (ts.isShorthandPropertyAssignment(q)) given.set(q.name.text, this.shorthandValue(q));
						else if (ts.isPropertyAssignment(q)) given.set((q.name as ts.Identifier).text, this.expr(q.initializer));
					}
				} else if (key === 'fullscreen' || key === 'animated' || key === 'cancelable') {
					settings.push(`${key}: ${this.expr(p.initializer)}`);
				} else if (key === 'closeCallback') {
					callback = p.initializer;
				}
			}
		}
		if (callback) {
			if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) throw this.error(callback, 'a modal close callback that is not a function literal');
			const closure = this.closure(callback);
			const first = callback.parameters[0];
			const t = first ? this.typeOf(first.name) : '';
			// A modal closed without a result (swiped away) passes undefined, which reads as "undefined" or NaN.
			const undefinedValue: Record<string, string> = { String: '"undefined"', Double: '.nan', Bool: 'false' };
			const cast = t in undefinedValue ? (heldLoss('modalResult', undefinedValue[t], { node: first }), `((value as? ${t}) ?? ${undefinedValue[t]})`) : `(value as! ${t})`;
			const call = !first ? `{ _ in (${closure})() }` : t === 'Any' ? closure : t.endsWith('?') ? `{ value in (${closure})(value as? ${t.slice(0, -1)}) }` : `{ value in (${closure})${cast} }`;
			settings.push(`closeCallback: ${call}`);
		}
		const args = info.props.map((p) => `${ident(p)}: ${given.get(p) ?? 'nil'}`).join(', ');
		return `Modal.show(${settings.join(', ')}) { try ${programClassName(this, component)}(${args}).${info.members.render}() }`;
	}

	/** `join`'s separator: only undefined reads as the comma; null, as any other value, joins as its string. */
	joinSeparator(a: ts.Expression): string {
		const untyped = (x: ts.Expression) => assertedOperand(x, (y) => this.isAny(y));
		const leaves = (x: ts.Expression): ts.Expression[] => {
			const b = ts.skipParentheses(x);
			return ts.isConditionalExpression(b) ? [...leaves(b.whenTrue), ...leaves(b.whenFalse)] : [x];
		};
		const loose = (x: ts.Expression) => {
			const t = this.typeOf(x);
			return ts.skipParentheses(x).kind === ts.SyntaxKind.NullKeyword || !!untyped(x) || t.endsWith('?') || isKit(spelledType(t), 'JSNullish');
		};
		if (!leaves(a).some(loose)) return this.expr(a);
		// A nested conditional is typed `Any?` itself: Swift types its branches (JSNull, String) without the outer context.
		const held = (x: ts.Expression, nested = false): string => {
			const b = ts.skipParentheses(x);
			if (ts.isConditionalExpression(b)) {
				const code = this.ternary(b, 'Any?', (y) => held(y, true));
				return nested ? `(${code} as Any?)` : code;
			}
			if (b.kind === ts.SyntaxKind.NullKeyword) return 'jsNull';
			const op = untyped(x);
			if (op) return this.expr(op);
			return this.typeOf(x).endsWith('?') ? this.expr(x) : this.coerce(x, 'Any?');
		};
		return `${RT.jsJoinSeparator}(${held(a)})`;
	}

	/** `new (Cls as any)(…)` constructs Cls: the type of the expression made without the cast. */
	constructedTypes = new Map<ts.Node, string>();

	/** The object literals being written as plain JavaScript objects, whose values are stored as they are, undefined included. */
	dynamicLiterals = new Set<ts.Node>();

	/** A method of an untyped object literal: a function value, or one taking `this` when its body reads it. */
	untypedMethod(p: ts.MethodDeclaration): string {
		const ret = this.returnTypeOf(p);
		// A `this` parameter is no argument.
		const own = p.parameters.filter((q) => !(ts.isIdentifier(q.name) && q.name.text === 'this'));
		const type = `(${own.map((q) => escapingParam(this.paramType(q))).join(', ')}) throws -> ${ret}`;
		const cparams = this.readsArguments(p) ? '__arguments: JSArray<Any?>' : own.map((q, k) => `${ts.isIdentifier(q.name) ? ident(q.name.text) : `__p${k}`}: ${escapingParam(this.paramType(q))}`).join(', ');
		if (!thisNodes(p).length)
			return this.boxFunction(
				`{ (${cparams}) throws -> ${ret} in${this.functionBody(p, ret, this.indent).slice(1)}`,
				type,
				own.findIndex((q) => q.dotDotDotToken),
			);
		const forwarding = this.forwardingSetter(p);
		if (forwarding) return forwarding;
		const fn = functionParts(type)!;
		const binds = fn.params.map((t, k) => `let ${ident((own[k].name as ts.Identifier).text)}: ${t} = ${own[k].dotDotDotToken ? `${t}(__a.dropFirst(${k}).map { ${this.fromAnyCode('$0', t.replace(/^JSArray<(.*)>$/, '$1'), true)} })` : this.fromAnyCode(`${RT.jsArg}(__a, ${k})`, t, true)}`);
		const body = this.withThis(p, '__this', true, () => this.functionBody(p, ret, this.indent + '    '));
		const call = this.marks.tryCode(`{ () throws -> ${ret} in${body.slice(1)}()`);
		const result = ret === 'Void' ? `${call}; return nil` : `return ${this.convert(call, ret, 'Any?')}`;
		return `({ (__this: Any?, __a: [Any?]) throws -> Any? in ${binds.join('; ')}${binds.length ? '; ' : ''}${result} } as JSMethod)`;
	}

	/** A literal's text, which a Swift string holds only without lone surrogates (it would hold U+FFFD for one). */
	wellFormed(n: ts.Node, text: string): string {
		if (refusedString(text, this.ledger)) throw this.limit(n, 'lone-surrogate', 'a string with a lone surrogate');
		return text;
	}
}
export interface Translator extends ConfigFields<SwiftLibrary> {}
export interface Translator extends Mixins {}
for (const methods of mixins) Object.defineProperties(Translator.prototype, Object.getOwnPropertyDescriptors(methods));
