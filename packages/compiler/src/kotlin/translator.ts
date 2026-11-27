import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { KOTLIN_LEDGER } from '../semantics/ledger.ts';
import { buildOf, configFields, type ConfigFields } from '../semantics/config.ts';
import { ProgramFacts } from '../semantics/facts.ts';
import { AsyncLowering, type AsyncCtx, type AsyncSyntax, type AsyncTranslator } from '../semantics/async.ts';
import { functionValueCall, typedButHeldUntyped, untypedContext, type AwaitSlot, type ConditionBackend, type PlacementBackend, type ReceiverBackend, type ReturnBackend } from '../semantics/placement.ts';
import { SPELLING, FALSY_CAPABLE, KOTLIN_SYNTAX, OBJECT_REQUIRED, branch, functionTypeParts, grouped, infixOperand, isNullable, kotlinString, negated, optionalType, postfixable, RT } from './syntax.ts';
import { Framework } from '../adapters/hooks.ts';
import type { KotlinTranslatorView } from '../api/adapter-api.ts';
import { CodeMarks } from '../semantics/marks.ts';
import { isKit, isNamed, isUntyped, parseNativeType, spelledType, type TypeView } from '../semantics/types.ts';
import type { ModuleThread } from '../semantics/threading.ts';
import { recognizePatterns, type Patterns } from '../program/patterns.ts';
import { ShapeMap, type ShapeFacts } from '../semantics/shapes.ts';
import { assertedOperand, implementedInterfaces, substitutedExpr, uncheckedMatch } from '../semantics/lang.ts';
import { unsetGroupTyping, type UnsetGroupTyping } from '../semantics/regexp.ts';
import { strictFile, type TrustScope } from '../semantics/trust.ts';
import { ValueStates } from '../semantics/states/value-states.ts';
import { callbackArity, hasModifier } from '../semantics/ast.ts';
import { Throws, isStatic } from '../semantics/throws.ts';
import { observers } from '../semantics/observers.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { ClassExprRegistry, constClassExpr, programBase } from '../semantics/classes.ts';
import { mixins, type Mixins } from './install.ts';
import type { KotlinConfig, ShapeField, KotlinCore, KotlinNative, ComponentInfo, KotlinLibrary } from './translator-types.ts';
export type { ComponentInfo, KotlinNative, KotlinLibrary, KotlinCore, KotlinConfig, CallParams, DynamicMembers, ShapeField } from './translator-types.ts';

export class Translator implements AsyncTranslator {
	/** What this translation recorded of the code it emitted (semantics/marks.ts), made before anything is spelled. */
	readonly marks = new CodeMarks();
	/** What the translator was given when it was made, its build's defaults filled in. */
	readonly config: KotlinConfig & Required<Pick<KotlinConfig, 'adapter' | 'refusals' | 'isBindingSource'>>;
	readonly syntax: AsyncSyntax = { ...KOTLIN_SYNTAX, unwrap: (code) => this.asserted(code) };
	/** The component class being translated: its props read as `this.<prop>.value`. */
	props = new Set<string>();
	/** Named types translated code uses: an interface becomes a class only if something does. */
	readonly used = new Set<string>();
	interfaces = new Map<string, { file: string; code: () => string }>();
	readonly shapes = new ShapeMap<{ name: string; fields: ShapeField[] }>();
	/** Kotlin function types ending in an array, by what the TypeScript signatures giving them declare it: a rest parameter, an array, or both. */
	restFunctionTypes = new Map<string, 'rest' | 'array' | 'both'>();
	shaping = new Set<ts.Type>();
	/** The types `type()` is spelling, outermost first, each with whether it is on a cycle. */
	spelling: { type: ts.Type; cycle: boolean }[] = [];
	/** Variables initialized from an element read (`const r = xs[i]`): nullable, unwrapped where they are used. */
	undefinedVars = new Map<ts.Symbol, string>();
	/** Function-local `let s: string` variables only mutated via `+=` in a loop: lowered to `StringBuilder`. */
	stringBuilders = new Set<ts.Symbol>();
	/** A binding Kotlin holds as nullable though TypeScript types it present: reads take it as the undefined it may be. */
	bindsOptional(name: ts.Identifier, type: string): string {
		const sym = this.checker.getSymbolAtLocation(name);
		const t = optionalType(type);
		if (sym) this.undefinedVars.set(sym, t);
		return t;
	}
	/** A tagged template's strings, one constant per call site, as JavaScript caches them. */
	templateObjects: string[] = [];
	/** Labels of labeled blocks in scope: `break label` returns from the block's lambda. */
	blockLabels = new Set<string>();
	/** Accessors for module-level variables a class member of the same name hides (`__global_fruits`). */
	globalAliases = new Map<string, string>();
	/** App classes another app class extends: they stay open. */
	extended = new Set<string>();
	/** Interfaces an app class implements: Kotlin interfaces, with a class for their object literals. */
	protocols = new Set<string>();
	/** Interfaces an app class meets without naming them, where its objects are given for one (`measure(box)`): implemented as if named. */
	structural = new Map<ts.ClassLikeDeclaration, Set<ts.InterfaceDeclaration>>();
	indent = '';
	tmp = 0;
	/** Expressions already evaluated into a Kotlin name (awaited values, operands read before an await). */
	readonly subst = new Map<ts.Node, string>();
	asyncCtx: AsyncCtx | null = null;
	plainBreak = 0;
	plainContinue = 0;
	returnType = 'Unit';
	/**
	 * The statements a plain `break`/`continue` targets, innermost last: a loop
	 * (with the label its body has when `continue` must skip to a do-while's
	 * condition) or a switch block, which `break` leaves.
	 */
	jumps: ({ kind: 'loop'; continueLabel?: string } | { kind: 'switch'; label: string })[] = [];
	/** A Promise executor's `resolve` parameter → its JSResolvers, so resolving with a promise adopts it. */
	resolvers = new Map<ts.Symbol, { name: string; type: string }>();
	/** Template methods take their loop variables with defaults only so the checker can type them. */
	templateParams = false;
	readonly sourceFiles: readonly ts.SourceFile[];
	lowering: AsyncLowering;
	readonly core: KotlinCore | null;
	readonly native: KotlinNative | null;
	/** Whether the Android binding declares `d`: a class file of the classpath does. */
	readonly nativeDeclared = (d: ts.Declaration): boolean => !!this.native?.isNativeDeclaration(d);
	/** The innermost statement or expression being translated: where code made from a type alone is placed. */
	translating: ts.Node | undefined;
	/** The generated kit: a module's name for `AppModules.runImport`, set where modules `await import(…)` reaches run when imported. */
	readonly moduleKey?: (file: string) => string;

	/** The program's whole-program answers, shared with any translator of the same checker and files. */
	readonly facts: ProgramFacts;
	readonly checker: ts.TypeChecker;
	components: Map<string, ComponentInfo>;

	/** Which empty states a value or slot may hold (value-states.ts). */
	readonly states: ValueStates;
	readonly patterns: Patterns;
	/** Classes some class extends, by declaration (an import may rename them). */
	extendedDecls = new Set<ts.Node>();
	classExprs = new ClassExprRegistry();
	/**
	 * Parameters and fields Kotlin declares nullable where TypeScript's type is
	 * not: plugin code checked without strictNullChecks passes null and
	 * undefined for objects, and a property a plugin registers may be unset.
	 * A read unwraps them unless it only tests or passes the value on.
	 */
	nullableDecls = (() => {
		// By declaration: a generic class's member is another symbol where an instantiation reads it.
		const decls = new Set<ts.Node | ts.Symbol>();
		const key = (s: ts.Symbol) => s.valueDeclaration ?? s;
		return {
			add: (s: ts.Symbol) => {
				decls.add(key(s));
			},
			has: (s: ts.Symbol) => decls.has(key(s)),
		};
	})();
	/** Expressions whose value lands where null is fine (an optional slot): a nullable declaration is read as it is. */
	nullOk = new Set<ts.Node>();
	/** What `this` is in an arrow function inside a Kotlin object expression, where Kotlin's `this` is the object. */
	thisAlias: string | null = null;

	/** Classes declared under Java names of other packages (`com.tns.NativeScriptActivity`), each in a file of its package. */
	readonly foreign: { name: string; code: string }[] = [];
	/** Code checked without strictNullChecks, as core is: any declaration may hold null or undefined. */
	readonly lenient: boolean;

	trustScope: TrustScope | null = null;
	/** The trust rule's view of this program (lang.ts): which files are strict, which declarations are the platform's. */
	get trust(): TrustScope {
		return (this.trustScope ??= {
			checker: this.checker,
			strictFile: (f) => strictFile(f.fileName, this),
			nativeDeclaration: (d) => !!this.native?.isNativeDeclaration(d),
			looseSlot: (d) => this.states.looseSlots.has(d),
		});
	}

	unsetTyping?: UnsetGroupTyping;
	/** App mode: a match's groups that took no part, though TypeScript types them strings (see `unsetGroupTyping`). */
	get unset(): UnsetGroupTyping {
		return (this.unsetTyping ??= unsetGroupTyping(
			this.checker,
			(n) => this.resolve(n),
			(e) => isNamed(spelledType(this.shapes.question(() => this.typeOf(e))), 'JSMatch', false),
		));
	}

	constructor(checker: ts.TypeChecker, components: Map<string, ComponentInfo>, files: readonly ts.SourceFile[], config: KotlinConfig = {}) {
		const c = (this.config = buildOf(config));
		Object.assign(this, configFields(c, KOTLIN_LEDGER));
		this.framework = new Framework(c.hooks);
		this.checker = checker;
		this.lenient = c.lenient ?? false;
		this.moduleThread = c.moduleThread ?? null;
		this.moduleKey = c.moduleKey;
		this.components = components;
		this.sourceFiles = files;
		this.facts = ProgramFacts.of(checker, files, { library: this.library, pluginFiles: this.pluginFiles });
		this.states = new ValueStates(this.stateBackend(), c);
		observers.translator?.(this, this.states);
		// Before the constructor's passes: the names they take (`topNames`) step aside for the kit's types.
		this.core = c.core?.(this) ?? null;
		this.native = c.native?.(this) ?? null;
		this.patterns = recognizePatterns(checker, files);
		this.lowering = new AsyncLowering(this);
		for (const f of files) {
			const visit = (n: ts.Node) => {
				if (ts.isClassLike(n)) {
					const base = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
					if (base && ts.isIdentifier(base.expression)) {
						this.extended.add(base.expression.text);
						const d = this.resolve(base.expression)?.valueDeclaration;
						if (d) this.extendedDecls.add(d);
						const baseExpr = constClassExpr(base.expression, this.checker);
						if (baseExpr) this.extendedDecls.add(baseExpr);
					}
					// `class Cache extends common.Cache`: a module's class read through its namespace import.
					if (base && ts.isPropertyAccessExpression(base.expression)) {
						const d = this.resolve(base.expression.name)?.valueDeclaration;
						if (d) this.extendedDecls.add(d);
					}
					// `implements TKUnit.TestInfoEntry`: the interface by its own name, as its module declares it.
					for (const i of implementedInterfaces(this.checker, n)) this.protocols.add(this.implementedName(i));
				}
				if (!this.library) {
					const given = ts.isCallExpression(n) || ts.isNewExpression(n) ? (n.arguments ?? []) : ts.isVariableDeclaration(n) && n.type && n.initializer ? [n.initializer] : ts.isReturnStatement(n) && n.expression ? [n.expression] : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken ? [n.right] : [];
					for (const x of given) this.noteStructural(x);
				}
				ts.forEachChild(n, visit);
			};
			visit(f);
		}
		// Mark unviewable interface object classes upfront before any module translates, so cross-file `fromAny` never emits `.jsView(...)` for one.
		for (const f of this.sourceFiles) {
			if (f.isDeclarationFile) continue;
			for (const st of f.statements) {
				if (!ts.isInterfaceDeclaration(st)) continue;
				const name = this.topName(st, st.name.text);
				const all = this.withInherited(st, st.members);
				if (this.protocols.has(name) && all.some(ts.isMethodSignature)) this.unviewable.add(`${name}Object`);
				else if (!this.protocols.has(name) && all.some((m) => !!m.name && ts.isComputedPropertyName(m.name))) this.unviewable.add(name);
			}
		}
	}

	/** A class whose methods and accessors are read by name: a substitution's, which untyped code reads as often as typed code does, or a `ValueStates.viewedClass`. */
	membersByName(cls: ts.ClassLikeDeclaration): boolean {
		return this.config.adapter.readsMembersByName(cls.getSourceFile().fileName) || this.states.viewedClass(cls);
	}

	/** A `membersByName` class's member read by name: a substitution's every one, else as `ValueStates.viewedMember` says. */
	memberByName(cls: ts.ClassLikeDeclaration, name: string): boolean {
		return this.config.adapter.readsMembersByName(cls.getSourceFile().fileName) || this.states.viewedMember(cls, name);
	}

	noteStructural(x: ts.Expression): void {
		const bare = ts.skipParentheses(x);
		if (ts.isConditionalExpression(bare)) {
			this.noteStructural(bare.whenTrue);
			this.noteStructural(bare.whenFalse);
			return;
		}
		const wanted = this.checker.getContextualType(x)?.getSymbol();
		const iface = wanted?.declarations?.find(ts.isInterfaceDeclaration);
		if (!iface || iface.getSourceFile().isDeclarationFile || iface.typeParameters?.length || iface.heritageClauses?.length) return;
		const cls = this.checker.getTypeAtLocation(x).getSymbol()?.valueDeclaration;
		if (!cls || !ts.isClassLike(cls) || cls.getSourceFile().isDeclarationFile || cls.typeParameters?.length || implementedInterfaces(this.checker, cls).some((i) => this.implementedName(i) === this.topName(iface, iface.name.text))) return;
		if (!this.meetsFields(cls, iface)) return;
		(this.structural.get(cls) ?? this.structural.set(cls, new Set()).get(cls)!).add(iface);
		this.protocols.add(this.topName(iface, iface.name.text));
	}

	/** Whether a class's own members hold every property of an interface as Kotlin can override it: the same type, writable where the interface's is. */
	meetsFields(cls: ts.ClassLikeDeclaration, iface: ts.InterfaceDeclaration): boolean {
		const ctor = cls.members.find(ts.isConstructorDeclaration);
		for (const req of iface.members) {
			const name = req.name?.getText();
			if (!name || (!ts.isPropertySignature(req) && !ts.isMethodSignature(req)) || req.questionToken) return false;
			const own = cls.members.filter((m) => m.name?.getText() === name && !isStatic(m));
			const param = ctor?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name && ts.canHaveModifiers(p) && !!ts.getModifiers(p)?.length);
			if (ts.isMethodSignature(req)) {
				if (!own.some(ts.isMethodDeclaration)) return false;
				continue;
			}
			const field = own.find(ts.isPropertyDeclaration) ?? param;
			const getter = own.find(ts.isGetAccessor);
			if (!field && !getter) return false;
			const writable = field ? !hasModifier(field, ts.SyntaxKind.ReadonlyKeyword) : own.some(ts.isSetAccessor);
			if (!hasModifier(req, ts.SyntaxKind.ReadonlyKeyword) && !writable) return false;
			if (this.typeOf(req) !== (field ? this.typeOf(field.name) : this.returnTypeOf(getter!))) return false;
		}
		return true;
	}

	/** Each condition as `cond` last wrote it, which a later read's smart cast (`smartCast`) depends on. */
	readonly condCodes = new Map<ts.Node, string>();

	/** Where each local `smartCast` asked about is written (`x = …`, `x++`, a pattern naming it). */
	readonly localWrites = new Map<ts.Symbol, ts.Node[]>();

	/** Switches written as a `when` every branch of which, the default's included, returns or throws (`exits`). */
	readonly endingWhens = new Set<ts.Node>();

	/** Code that constructs a new object of a Kotlin class (`JSArray<T>()`, an object literal's shape class), by the type it makes. */
	readonly constructed = new Map<string, string>();

	construction(code: string, type: string): string {
		this.constructed.set(code, type);
		return code;
	}

	/** Whether code makes a new object of exactly `type` (non-null): converting it to that type gives it back unchanged. */
	constructs(code: string, type: string): boolean {
		return this.constructed.get(code) === type.replace(/\?$/, '');
	}

	/** A value Kotlin holds nullable where JavaScript goes on with it as an object: the value, or V8's TypeError when it is missing. */
	asserted(code: string): string {
		return this.isAsserted(code) ? code : this.marks.marked(`(${code}${OBJECT_REQUIRED}`, { op: 'asserted', of: this.marks.valueOf(code) });
	}

	/** `jsUnchecked<T>(x)`: the value passed for a `T` whatever it holds. */
	unchecked(type: string, code: string): string {
		return this.marks.marked(`${RT.jsUnchecked}<${type}>(${code})`, { op: 'cast', to: parseNativeType(type), optional: type.endsWith('?'), implicit: false, of: this.marks.valueOf(code), unchecked: true });
	}

	/** `x!!`: the value Kotlin's own assertion unwraps. */
	unwrapped(code: string): string {
		heldLoss('unwrapped', '!!');
		return this.marks.marked(`${code}!!`, { op: 'unwrap', of: this.marks.valueOf(code) });
	}

	/** Whether code is a value asserted present (`asserted`, or a `!!` its producer wrote). */
	isAsserted(code: string): boolean {
		const op = this.marks.markOf(code)?.op;
		return op === 'asserted' || op === 'unwrap';
	}

	/** The value an asserted one asserts. */
	unasserted(code: string): string {
		const m = this.marks.markOf(code);
		return m && (m.op === 'asserted' || m.op === 'unwrap') ? m.of.code : code;
	}

	/** The temporaries each prefix has numbered in the function being translated, and outside any function in the module. */
	temporaries = new Map<string, number>();
	moduleTemporaries = new Map<string, number>();
	/** Declarations being translated, outermost first: a temporary's number starts again in each top-level one. */
	declarationDepth = 0;

	/**
	 * A temporary's name, numbered within its declaration (`__switch1`). A one-letter prefix takes a `_` before its number,
	 * apart from the `__a0` parameters and arguments the translator writes itself.
	 */
	fresh(prefix: string): string {
		const taken = this.declarationDepth > 0 ? this.temporaries : this.moduleTemporaries;
		const n = (taken.get(prefix) ?? 0) + 1;
		taken.set(prefix, n);
		return this.marks.pureCode(/^__[a-z]$/.test(prefix) ? `${prefix}_${n}` : `${prefix}${n}`);
	}

	/** A constructor's `return`, inside the labeled block its `init` runs: Kotlin's `init` takes no `return`. */
	returnLabel: string | null = null;

	/** `return`, or in a lambda `return@` its label. */
	returnKeyword(): string {
		return this.lambdaReturn ? `return@${this.lambdaReturn}` : 'return';
	}

	/** The label a lambda being translated returns to (`return@fn1`), as a lambda's `return` would leave its caller. */
	lambdaReturn: string | null = null;

	inFunction<T>(returnType: string, body: () => T, lambdaLabel: string | null = null): T {
		const saved = [this.asyncCtx, this.plainBreak, this.plainContinue, this.returnType, this.jumps, this.returnLabel, this.lambdaReturn] as const;
		this.returnLabel = null;
		this.lambdaReturn = lambdaLabel;
		this.asyncCtx = null;
		this.plainBreak = 0;
		this.plainContinue = 0;
		this.returnType = returnType;
		this.jumps = [];
		try {
			return body();
		} finally {
			[this.asyncCtx, this.plainBreak, this.plainContinue, this.returnType, this.jumps, this.returnLabel, this.lambdaReturn] = saved;
		}
	}

	widenedVars = new Map<ts.VariableDeclaration, string | null>();

	/** `this` nodes that read an untyped object (a method of an object literal typed `any`). */
	untypedThis = new Set<ts.Node>();

	/** Calls whose nullable result is wanted as it is (see `maybeUndefined`). */
	rawResults = new Set<ts.Node>();

	/** The app's interfaces, for object literals TypeScript checks against one without naming it. */
	appInterfaces: { name: string; type: ts.Type }[] | null = null;

	plainObjectClassSet: Set<ts.Node> | null = null;

	private throwsAnalysis: Throws | null = null;
	/**
	 * The throws analysis the front's typed conversions are decided by (`Throws.objectConversionThrows`); built on the
	 * first question. It tells an untyped value by its TypeScript type alone: asking the backend's own types of every
	 * node would register object shapes the translation never spells.
	 */
	get throwsInfo(): Throws {
		const untyped = (n: ts.Node) => {
			const t = this.checker.getTypeAtLocation(n);
			// A class's polymorphic `this` is a type parameter, which no backend holds untyped.
			return !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (!!(t.flags & ts.TypeFlags.TypeParameter) && !t.symbol?.declarations?.some(ts.isClassLike));
		};
		return (this.throwsAnalysis ??= new Throws(
			this.checker,
			this.sourceFiles,
			untyped,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(st) => !this.reach || this.reach.keeps(st),
			() => this.framework,
		));
	}

	/** The build's framework, as its adapter's translator hooks describe it. */
	readonly framework: Framework<KotlinTranslatorView>;

	letterTypes: Set<string> | null = null;

	mergedStatics: string[] = [];
	/** Classes declared inside functions, declared at the module's top level. */
	hoisted: string[] = [];

	/** What a class declared in a function reads of the function's, which keeps it from the top level. */
	captured = new Map<ts.Node, string>();

	prototypeStatements = new Set<ts.Node>();
	prototypeFields: Map<ts.Node, { field: ts.PropertyDeclaration; value: ts.Expression }[]> | null = null;
	/** The assignments of a module-level class's static fields whose initializers read changing state, run in the module's order. */
	staticInits: string[] | null = null;

	/** Shape classes some placement reads another object as, which get a view mode (`T.jsView`); those written already; those that can have none. */
	viewed = new Set<string>();
	shapesWritten = new Set<string>();
	unviewable = new Set<string>();

	/** The functions being translated whose type parameters may be reified, innermost last. */
	reifying: (ts.SignatureDeclaration | null)[] = [];
	reified = new Map<ts.Node, Set<string>>();

	// ---- Classes -------------------------------------------------------------------------------

	/** Whether a member of `cls` assigns `this.name`. */
	erasedCall = new Set<ts.CallExpression>();
	/** Methods a witness of an erasing interface's signature calls, which take another JVM name than the witness's. */
	erasedSignatureMethods = new Set<ts.MethodDeclaration>();

	/** Whether the build compiles a class of the program's sources: a plugin file's only where it is reached. */
	compiles = (decl: ts.ClassDeclaration): boolean => {
		const file = decl.getSourceFile().fileName;
		return !this.pluginFiles.has(file) || !this.reach || (this.reach.modules.has(file) && this.reach.keeps(decl));
	};

	subclassFieldNames: Map<ts.Node, Set<string>> | null = null;

	earlyFields = new Map<ts.PropertyDeclaration, boolean>();
	subclassMethodNames: Map<ts.Node, Set<string>> | null = null;
	typeTestedParams = new Map<ts.ParameterDeclaration, boolean>();
	/** Parameters `typeTested` holds untyped because the body only passes them on: read untyped too. */
	passedParams = new Set<ts.ParameterDeclaration>();
	/** Library mode: getters typed as the Java class every override's value has, wider than script declares them. */
	widenedAccessors = new Map<ts.Node, string>();
	widenedParams = new Map<ts.Node, { base: ts.Type; own: string }>();
	/** The thread each module's code runs on (threading.ts): a `ui` module's classes and functions are main-thread only. */
	readonly moduleThread: ((file: string) => ModuleThread | undefined) | null;

	/** The `@Suppress` keys each declaration being translated needs for the Android APIs it uses, innermost last. */
	suppressionScopes: Set<string>[] = [];

	/** Parameters an override takes under the overridden method's names (Kotlin's, for named arguments), each to that name. */
	baseParamNames = new Map<ts.ParameterDeclaration, string>();

	/** Whether an app is translated against kit-android, whose classes are core's own (compiled from core). */
	get generatedKit(): boolean {
		return !this.library && !!this.core;
	}
	compiledByName: Map<string, ts.ClassDeclaration> | null = null;

	clashNames: Set<string> | null = null;
	readonly overUntypedFields = new Map<ts.Declaration, boolean>();

	ownCalls = new Set<ts.Node>();

	renamedTop: Map<ts.Node, string> | null = null;
	typeRenames = new Map<ts.Node, string>();

	// ---- Statements --------------------------------------------------------------------------------

	/** Variables a function declared before them reads: declared first, assigned where they are declared. */
	forwardDeclared = new Set<ts.VariableDeclaration>();
	/** A function's `var`s declared at the top of its body (see `scopedVars`). */
	scopedDeclared = new Set<ts.VariableDeclaration>();

	label: string | null = null;
	ownSignatures = new Map<ts.Node, boolean>();
	readonly awaitSlots = new Map<ts.Node, AwaitSlot>();

	returnsSet?: ReturnBackend;

	/** What the shared `return` cells (placement.ts) read of this translator. */
	get returns(): ReturnBackend {
		const t = this;
		return (this.returnsSet ??= {
			typeOf: (n) => t.typeOf(n),
			emptyReturn: (e, slot) => {
				const ret = slot.target;
				const primitive = ['String', 'Double', 'Boolean'].includes(ret);
				if (!e) {
					if (t.returnLabel) return '';
					// Lenient code returning nothing from a function of a string, number or boolean: its zero value, as Swift's kit gives.
					if (t.lenient && primitive) return t.zero(ret);
					return ret.endsWith('?') ? 'null' : '';
				}
				// App mode: undefined or null where a type parameter or a string, number or boolean is declared (`ios<T>(f): T`, this
				// platform's half of `__APPLE__ ? f : undefined`): no value of it, which callers test for.
				const nothing = e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
				if (t.library || !nothing) return null;
				if (/^[A-Z]\w*$/.test(ret) && slot.fn?.typeParameters?.some((p) => p.name.text === ret)) return `${RT.jsUnchecked}<${ret}>(null)`;
				return primitive ? t.zero(ret) : null;
			},
			// A void expression body (`(err) => sig.set(x)`) where a value is wanted (`then`'s onRejected), or a void call returned
			// where a typed value or nothing is (`return generate(…)` of a factory also giving a function): undefined.
			voidValue: (e, slot, body) => ((body || (ts.isCallExpression(e) && !isUntyped(spelledType(slot.target)))) && isNullable(slot.target) ? 'null' : null),
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
			commonType: (x) => held(t.native?.type(x) ?? null),
			tuple: (x, at) => parseNativeType(t.tupleType(x, at)),
			named: (x, at) => parseNativeType(t.namedType(x, at)),
		});
	}

	placementSet?: PlacementBackend;

	/** What the shared placement front (placement.ts) reads of this translator, and Kotlin's spelling of its cells. */
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
			before: (e, target) => {
				const sub = substitutedExpr(this.subst, e, true);
				if (sub) return this.convert(sub.code, this.typeOf(sub.bare), target);
				const inner = /^Signal<(.*)>\??$/.exec(target)?.[1];
				return inner && this.isComputedProperty(e) ? `Signal.computing { ${this.coerce(e, inner)} }` : null;
			},
			readHeld: (e) => this.readHeld(e),
			untypedRead: (code, target) => this.fromAnyCode(code, target, this.lenient),
			untypedRoot: (e, code) => (!this.library && (this.isShapeType(this.typeOf(e).replace(/\?$/, '')) || functionValueCall(e, (n) => this.resolve(n)) || typedButHeldUntyped(this.checker, e, this.typeOf(e))) && untypedContext(this.checker, e) && !code.startsWith(`${RT.jsIdentity}(`) ? `${RT.jsIdentity}(${code})` : code),
			cells: {
				jsAny: (name) => `${name}.jsAny`,
				present: (name, key) => `${name}.present(${kotlinString(key)})`,
				type: (_target, _into, code) => `JSNullish.of(${code})`,
				upcast: (_target, code) => code,
				nullishOf: (_target, into, code, isNull) => `JSNullish.${isNull ? 'ofNull' : 'of'}<${into}>(${code})`,
				nullishOfAny: (_target, into, code) => this.nullishOfAny(code, into),
				empty: (isNull) => (isNull ? 'JSNullish.Null' : 'JSNullish.Undefined'),
				nulled: (code) => `${RT.jsNulled}(${code})`,
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
			nullishBefore: (e, target, held) => {
				if (!isUntyped(spelledType(target))) return null;
				if (this.states.nullishElementRead(e)) return `${RT.jsBox}(${this.expr(e)})`;
				return held ? null : this.nullishFunction(e);
			},
			argument: (e, slot) => this.argumentCell(e, slot),
			observed: (e) => this.observed(e),
			branches: (bare, target) => {
				const fixed = this.staticTruth(bare.condition);
				if (fixed !== undefined) return this.coerce(fixed ? bare.whenTrue : bare.whenFalse, target);
				return `(if (${this.cond(bare.condition)}) ${branch(this.coerce(bare.whenTrue, target))} else ${branch(this.coerce(bare.whenFalse, target))})`;
			},
		});
	}

	/** Calls of a `JSNullish` result being written as they are, not read as the optional. */
	nullishCalls = new Set<ts.Node>();

	classNames: Set<string> | null = null;

	classDeclarations: Map<string, ts.ClassDeclaration> | null = null;

	/**
	 * JavaScript's truthiness of a value whose Kotlin type decides it: a string is truthy when not empty, an instance of
	 * a class none of whose values is falsy (not a number, string, boolean or BigInt) when present.
	 */
	typedTruth(e: ts.Expression, code: string): string | undefined {
		const t = this.typeOf(e);
		const postfix = (member: string) => `${postfixable(code) || grouped(code) ? code : `(${code})`}.${member}`;
		// A value TypeScript types `string` may be held as `String?` (a lenient parameter, a plugin's untyped read).
		if (t === 'String' || t === 'String?') return negated(postfix('isNullOrEmpty()'));
		if (t === 'Boolean?' || (t === 'Boolean' && this.optionalBooleanCall(e))) return `${infixOperand(code)} == true`;
		// A Java class of `java.lang` may be a string, number or boolean in script (`java.lang.String`, `java.lang.Integer`).
		if (!isNullable(t) || !/^[A-Za-z][\w.]*(<.*>)?\?$/.test(t) || /^(java\.lang|kotlin)\./.test(t) || FALSY_CAPABLE.has(t.replace(/<.*|\?$/g, ''))) return undefined;
		const ts_ = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
		const objects = (p: ts.Type): boolean => !!(p.flags & ts.TypeFlags.Object) || (p.isIntersection() && p.types.every(objects));
		if (!(ts_.isUnion() ? ts_.types : [ts_]).every(objects)) return undefined;
		return `${infixOperand(code)} != null`;
	}

	get conditions(): ConditionBackend {
		return (this.conditionSet ??= {
			bare: true,
			isBool: (n) => this.isBool(n),
			maybeUndefined: (e) => this.maybeUndefined(e),
			fixed: (e) => this.staticTruth(e),
			decided: (e) => {
				const and = e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
				return this.staticTruth(e.left) === and ? e.right : this.staticTruth(e.right) === and && this.pure(e.left) ? e.left : null;
			},
		});
	}
	conditionSet?: ConditionBackend;

	// ---- Expressions -----------------------------------------------------------------------------

	/** Held parts of a member's compound assignment (`readWriteCode`): their code, bound in their place, is final. */
	readonly heldParts = new Set<ts.Node>();

	readonly nullishReceivers = new Set<ts.Expression>();

	/** Names read as Kotlin holds them, optional, by a check of their own (`optionalRead`). */
	readonly rawNames = new Set<ts.Node>();

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
			held: (x) => t.optionalRead(x) ?? t.heldResult(x) ?? (t.states.libraryResultMissing(x) || t.states.presentTypedEmpty(x) ? t.expr(x) : null),
			receiverBefore: ({ target }) => (uncheckedMatch(target, t.checker) ? { cell: 'present', code: t.expr(target), isNull: true } : null),
		});
	}

	/**
	 * An expression that may be undefined though TypeScript types it as its element
	 * (`xs[i]` past the end, or a variable holding one), as a Kotlin nullable; null otherwise.
	 */
	optionalReads = new Set<ts.Node>();

	readonly rawHeld = new Set<ts.Node>();

	/** Receivers a call reads its method of, held as their checked form while the call is emitted. */
	checkedReceivers: ts.Expression[] = [];
	/** The `checkedReceivers` whose substitute already reads the key as JavaScript does (TypeError where missing). */
	readonly checkedSubst = new Set<ts.Expression>();

	erasedReads = new Set<ts.Node>();

	/** A function argument for a library method: a closure literal typed for its slot, or a function value. */
	fn(e: ts.Expression, slot?: string): string {
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.library && slot ? this.coerce(e, slot) : this.closure(e, slot);
		// `filter(Boolean)`: truthiness.
		if (ts.isIdentifier(e) && e.text === 'Boolean' && isLibGlobal(this, e) && slot) return `{ __v: ${functionTypeParts(slot)?.params[0] ?? 'Any?'} -> ${RT.jsTruthy}(__v) }`;
		// Library mode: a function value of another signature than the slot's (a callback taking the index and array too): adapted.
		if (this.library && slot) return this.coerce(e, slot);
		// A package's generic function (`hasValue.every(identity)`), which Kotlin holds erased: adapted.
		if (slot && this.genericFunctionRef(e)) {
			const adapted = this.functionRefAdapter(e, slot);
			if (adapted) return adapted;
		}
		// A function held untyped (an untyped `done` parameter): callable as the slot's function.
		if (slot && this.isAny(e)) return this.fromAny(this.expr(e), slot);
		// A function of a rest parameter (`promise.then(log)`): what the slot passes, packed.
		if (slot && ts.isIdentifier(e) && this.resolve(e)?.declarations?.some((d) => ts.isFunctionDeclaration(d) && !!d.body && d.parameters.length === 1 && !!d.parameters[0].dotDotDotToken)) return this.coerce(e, slot);
		// A function of fewer parameters than the slot passes (`promise.then(next)`, `next()` taking none): adapted.
		const fewer = slot && ts.isIdentifier(e) ? this.resolve(e)?.declarations?.find((d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d) && !!d.body) : undefined;
		if (fewer && fewer.parameters.length < (functionTypeParts(slot!)?.params.length ?? 0)) return this.functionRefAdapter(e, slot!) ?? this.functionValue(e);
		const own = slot && !fewer ? functionTypeParts(this.shapes.question(() => this.typeOf(e)).replace(/^\((.*)\)\?$/, '$1')) : undefined;
		if (own && own.params.length < (functionTypeParts(slot!)?.params.length ?? 0)) return this.coerce(e, slot!);
		return this.functionValue(e);
	}

	/** `join`'s separator: only undefined reads as the comma; null, as any other value, joins as its string. */
	joinSeparator(a: ts.Expression): string {
		if (this.library) return this.str(a);
		const untyped = (x: ts.Expression) => assertedOperand(x, (y) => this.isAny(y));
		const leaves = (x: ts.Expression): ts.Expression[] => {
			const b = ts.skipParentheses(x);
			return ts.isConditionalExpression(b) ? [...leaves(b.whenTrue), ...leaves(b.whenFalse)] : [x];
		};
		const loose = (x: ts.Expression) => ts.skipParentheses(x).kind === ts.SyntaxKind.NullKeyword || !!untyped(x) || isKit(spelledType(this.typeOf(x)), 'JSNullish');
		if (!leaves(a).some(loose)) return this.expr(a);
		const held = (x: ts.Expression): string => {
			const b = ts.skipParentheses(x);
			if (ts.isConditionalExpression(b)) return `(if (${this.cond(b.condition)}) ${held(b.whenTrue)} else ${held(b.whenFalse)})`;
			if (b.kind === ts.SyntaxKind.NullKeyword) return 'jsNull';
			const op = untyped(x);
			if (op) return this.expr(op);
			return isKit(spelledType(this.typeOf(x)), 'JSNullish') ? this.coerce(x, 'Any?') : this.expr(x);
		};
		return `${RT.jsJoinSeparator}(${held(a)})`;
	}

	functionArity(e: ts.Expression): number {
		return callbackArity(e, this.checker);
	}

	/** `new ArrayBuffer(n)`, `new Uint8Array(…)`, `new DataView(buffer, …)`: the runtime's of each, by what the first argument is. */
	newBuffer(name: string, args: readonly ts.Expression[]): string {
		const t = `JS${name}`;
		const [a, ...rest] = args;
		const numbers = rest.map((x) => this.toNumber(x));
		if (!a) return `${t}()`;
		const at = this.typeOf(a).replace(/\?$/, '');
		if (name === 'ArrayBuffer') return `${t}(${this.toNumber(a)})`;
		if (at === 'JSArrayBuffer') return `${t}(${[this.expr(a), ...numbers].join(', ')})`;
		if (name === 'DataView') return `${t}.from(${[this.coerce(a, 'Any?'), ...numbers].join(', ')})`;
		if (at === 'Double') return `${t}(${this.expr(a)})`;
		if (isKit(spelledType(at), 'JSArray')) return `${t}(${this.expr(a)})`;
		return `${t}.from(${[this.coerce(a, 'Any?'), ...numbers].join(', ')})`;
	}

	/** Library mode: `new (class extends View { createNativeView() { … } })()`, its methods overriding the base's: a Kotlin object. */
	classExpressionObject(cls: ts.ClassExpression): string {
		const base = programBase(cls, this.checker);
		if (!base || cls.members.some((m) => !ts.isMethodDeclaration(m) || !m.body || isStatic(m))) throw this.error(cls, 'a class expression other than one overriding methods of a class the program declares', 'class-expression');
		const members = (cls.members as ts.NodeArray<ts.MethodDeclaration>).map((m) => {
			const n = m.name.getText();
			const root = this.inheritedMethod(cls, n) && this.rootMethod(m);
			if (!root || root === m) return '    ' + this.func(m, this.methodIdent(n), 'open ');
			if (root.parameters.length !== m.parameters.length || root.parameters.some((p, k) => this.paramType(p) !== this.paramType(m.parameters[k])) || this.returnTypeOf(root) !== this.returnTypeOf(m)) return this.appOverride(m, root);
			return '    ' + this.func(m, this.methodIdent(n), 'override ');
		});
		return `object : ${this.className(base)}() {\n${members.join('\n')}\n}`;
	}

	/**
	 * A function literal stored where untyped code calls it (`global.onmessage = (m: Msg) => …`): jsCall passes
	 * JavaScript values, so typed parameters are converted from them inside.
	 */
	untypedCallable(e: ts.Expression): string {
		let f = e;
		while (ts.isParenthesizedExpression(f)) f = f.expression;
		// A function declaring `this` is a JSMethod already, which takes its receiver and arguments as given.
		if (!(ts.isArrowFunction(f) || ts.isFunctionExpression(f)) || f.parameters.some((p, k) => !ts.isIdentifier(p.name) || (p.dotDotDotToken && k < f.parameters.length - 1) || p.name.text === 'this')) return this.coerce(e, 'Any?');
		const types = f.parameters.map((p) => this.typeOf(p.name));
		// A rest parameter takes every argument from its position on, which a fixed-arity lambda cannot.
		if (f.parameters.at(-1)?.dotDotDotToken) {
			const k = f.parameters.length - 1;
			const args = types.map((t, i) => (i < k ? this.fromAny(this.marks.pureCode(`__a.getOrNull(${i})`), t) : this.fromAny(`JSArray<Any?>(__a.drop(${k}))`, t)));
			return `run { val __f = ${this.closure(f)}; ${RT.jsFunction}(${k}) { __a -> __f(${args.join(', ')}) } }`;
		}
		if (types.every((t) => isUntyped(spelledType(t)))) return this.coerce(e, 'Any?');
		const names = types.map((_, k) => this.marks.pureCode(`__a${k}`));
		return `run { val __f = ${this.closure(f)}; { ${names.map((n) => `${n}: Any?`).join(', ')} -> __f(${types.map((t, k) => this.fromAny(names[k], t)).join(', ')}) } }`;
	}

	/** `<T>x` where T is a subclass of x's own class, neither of them native: what JavaScript may hold there is not always a T. */
	isClassDowncast(e: ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression): boolean {
		if (ts.isSatisfiesExpression(e)) return false;
		const to = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
		const from = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression));
		const isClass = (t: ts.Type) => !!((t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) && !this.native?.type(t);
		return to !== from && isClass(to) && isClass(from) && this.checker.isTypeAssignableTo(to, from) && !this.checker.isTypeAssignableTo(from, to);
	}

	/** Library mode: an argument to a local function literal (`const matcher = (v: T) => …; matcher(<T>x)`), whose parameters are nullable there. */
	functionLiteralArgument(e: ts.Expression): boolean {
		let arg: ts.Node = e;
		while (ts.isParenthesizedExpression(arg.parent)) arg = arg.parent;
		const call = arg.parent;
		if (!ts.isCallExpression(call) || !call.arguments.includes(arg as ts.Expression) || !ts.isIdentifier(call.expression)) return false;
		const d = this.resolve(call.expression)?.valueDeclaration;
		return !!d && this.literalFunctionLocal(d);
	}

	literalFunctionLocal(d: ts.Declaration): d is ts.VariableDeclaration {
		if (!this.library || !ts.isVariableDeclaration(d) || d.type || !d.initializer || this.forwardDeclared.has(d) || !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return false;
		let init = d.initializer;
		while (ts.isParenthesizedExpression(init)) init = init.expression;
		if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return false;
		const sym = this.checker.getSymbolAtLocation(d.name);
		const refers = (n: ts.Node): boolean => (ts.isIdentifier(n) && this.checker.getSymbolAtLocation(n) === sym) || !!ts.forEachChild(n, refers);
		return !refers(init);
	}

	isRegExp(e: ts.Expression): boolean {
		return isNamed(spelledType(this.typeOf(e)), 'JSRegExp', false);
	}

	/**
	 * An array (or a promise) of one object type where one of another is wanted: a new array of its elements, each
	 * converted (a promise settling with its value converted). JVM generics are erased, so an unchecked cast would pass
	 * and fail at the first element read.
	 */
	currentFile: string | null = null;

	/** The constructor being written's statements that make keys the walk predicts: what runs before and after each (`initKeyNotes`). */
	keyNotes: Map<ts.Statement, { before: string; after: string }> | null = null;
	shapeFactSet: ShapeFacts | null = null;

	heldSignalVisits = new Set<ts.Node>();

	untypedJavaFieldSet: Set<ts.Node> | null = null;

	thisValueSets: { symbols: Set<ts.Node | undefined>; functions: Set<ts.Node>; returning: Set<ts.Node> } | null = null;
}
export interface Translator extends ConfigFields<KotlinLibrary> {}
export interface Translator extends Mixins {}
for (const methods of mixins) Object.defineProperties(Translator.prototype, Object.getOwnPropertyDescriptors(methods));
