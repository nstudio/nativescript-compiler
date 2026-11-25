// The contract between the compiler and a framework adapter: what an adapter gives the compiler for an app written
// with its framework, and the compiler functions it is given in return. An adapter imports this module for its types
// only: at run time it reaches the compiler through the `CoreApi` its entry is called with, so it shares the module
// instances (and their state) of the compiler that loaded it.
// An adapter type-checked against this module sees the TypeScript internals the compiler declares, as its hooks call them too.
/// <reference path="./typescript-internal.d.ts" preserve="true" />
import type ts from 'typescript';
import type { canonical, ELEMENTS, MODELS } from './elements.ts';
import type { ComponentIR, scopeTemplate } from './ir.ts';
import type { rowTemplates } from './listview.ts';
import type { rewrite } from './rewrite.ts';

export type { Attr, ComponentIR, ComponentStyle, DirectiveUse, Event, QueryHook, TNode, Watcher } from './ir.ts';
export type { Scope } from './rewrite.ts';
/** The TypeScript the compiler runs, for its types: an adapter's run-time TypeScript is `CoreApi.ts`. */
export type { ts as TypeScript };

/** The version of this contract; the compiler refuses an adapter written against another. */
export const ADAPTER_API_VERSION = 1;

export type Platform = 'ios' | 'android';

/**
 * A framework's adapter: its entry module's default export is `adapter(core: CoreApi): FrameworkAdapter`, called once
 * per build before anything else of the adapter runs.
 * @experimental The adapter API was shaped by the first-party adapters, which live outside this package; it may change
 * in any release, with `ADAPTER_API_VERSION`, until an adapter is reviewed with it.
 */
export interface FrameworkAdapter {
	apiVersion: 1;
	/** The framework's name, as the app's `nativescript.compiler.flavor` names it. */
	name: string;
	/** The framework's packages, as an app depends on them (`@scope/*`: every package of the scope); never compiled as plugins. */
	packages: string[];
	/** How the framework's templates render and update; `FrontEndResult.behaviour` gives an app's own where it differs. */
	behaviour: TemplateBehaviour;
	/**
	 * The modules of the build, before the front end runs: those the entry reaches (`entry`, as a bundler following
	 * imports from the entry finds them, lazy routes included), or every file the app's tsconfig.json includes and what
	 * those import (`project`).
	 */
	reach: 'entry' | 'project';
	/** The app's components and modules, read from its sources. */
	frontEnd(app: AppSources): FrontEndResult | Promise<FrontEndResult>;
	swift?: TranslatorHooks<SwiftTranslatorView>;
	kotlin?: TranslatorHooks<KotlinTranslatorView>;
	/** How the framework's modules resolve in the build's program. */
	modules?: ModuleRules;
	/**
	 * Folders of TypeScript the adapter ships to compile with an app (its ports of the framework's libraries): compiled as
	 * the compiler's own `runtime/` is, as written and strict wherever it is installed, and not as the app's code.
	 */
	runtimeRoots?: string[];
	/** File names of modules the front end places in the app's folder with a runtime file's text: compiled as the runtime is. */
	runtimeModules?: string[];
	/** The package the adapter ships as. */
	package?: AdapterPackage;
	/** The adapter's own kit sources, compiled into the kit with the app. */
	kit?: AdapterKit;
	/** The refusals the adapter's hooks make, by id: reported as the compiler's own are. */
	refusals?: Record<string, RefusalKind>;
}

/** An app as the compiler finds it. */
export interface AppInfo {
	/** The app's folder, holding its package.json. */
	root: string;
	/** The folder of the app's entry (its package.json `main`). */
	appDir: string;
	/** The entry module. */
	entry: string;
	/** Every file under `appDir`. */
	files: string[];
}

/** What a front end reads of the app it compiles. */
export interface AppSources extends AppInfo {
	platform: Platform;
	entryText: string;
	/**
	 * The app's TypeScript modules of this build (`reach`), this platform's files only, the entry left out. The front
	 * end's own list: it may add to it.
	 */
	sources: string[];
	/** The file an app specifier names through the app's tsconfig path aliases (`~/app/x`), else undefined. */
	aliased(specifier: string): string | undefined;
	/** The app's node_modules folder. */
	nodeModules: string;
	/** The plugins compiled from their TypeScript with the app. */
	plugins: PluginSources;
	/** Packages the app's configuration replaces with a file of its own. */
	replacedPackages: ReadonlySet<string>;
}

/** The plugins a build compiles from their TypeScript source, as a front end reaches them. */
export interface PluginSources {
	/** The package installed at `dir`, its source acquired (its repository at the published version, a patched copy, or the app's override). */
	get(dir: string): { readonly name: string; readonly version: string; readonly dir: string; readonly root: string };
	/** The TypeScript file an installed JavaScript file of an acquired package was compiled from; null where none is found. */
	sourceOf(jsFile: string): string | null;
}

/** What a front end makes of an app: the input of the type check and the back ends. */
export interface FrontEndResult {
	components: ComponentIR[];
	/** The app's modules translated beside its components, in the order their initializers run. */
	modules: string[];
	/**
	 * Virtual sources the build reads in place of files (a store as the release build reads it, a module the front end
	 * writes), in the order they were made.
	 */
	overrides?: Map<string, string>;
	/** The component the app starts with; '' when the entry mounts the app itself (`mounted`). */
	root: string;
	/** The entry is a module that runs the app (it mounts its own roots): it is translated, and no root view is made for it. */
	mounted?: boolean;
	/** The app's template behaviour, where it is not the adapter's (one the app's configuration or framework version decides). */
	behaviour?: TemplateBehaviour;
	/** The classes of the tags the app registers: a template names each by its class. */
	elementClasses?: ReadonlySet<string>;
	/** Code the generated entry runs for the framework, per back end; called once the components are translated. */
	entry?: { swift?(ctx: EntryContext): EntryCode; kotlin?(ctx: EntryContext): EntryCode };
}

/**
 * The members of a component class that the compiler generates and other code calls, each named clear of the class's
 * own members: `render` makes the component's view (`render(into:)` its views in a region, for a fragment), which the
 * app's entry, navigation, a modal and a parent call; under `TemplateBehaviour.passes`, `create` is its creation pass
 * and the others its hooks, which its parent calls.
 */
export interface ComponentMembers {
	render: string;
	create: string;
	init: string;
	doCheck: string;
	afterContent: string;
	contentChecked: string;
	afterView: string;
	viewChecked: string;
}

/** What entry code is written with. */
export interface EntryContext {
	/** The build's components, by name: the names of their generated members and whether construction throws. */
	readonly components: ReadonlyMap<string, { members: ComponentMembers; initThrows?: boolean }>;
	/** The code making a component's root view (`make`), wrapped as the translator wraps root views (`TranslatorHooks.wrapsRootViews`). */
	rootView(component: string, make: string): string;
	/** A program class's name in generated code, which may differ from its TypeScript name (a name the SDK also declares). */
	className(name: string): string;
	/** A string literal of the generated language. */
	string(text: string): string;
}

/** Statements of the generated entry, each line indented eight spaces and ending in a newline. */
export interface EntryCode {
	/** Before the app's modules run, which may make views. */
	setup?: string;
	/** Once the modules ran, before the root view is made; not run for a `mounted` app. */
	beforeRoot?: string;
}

/**
 * How a framework's templates render and update, as each component's generated `render()` does it. Views are made
 * once, each binding is an effect that sets one property, and each `if`/`for` owns a region of its container.
 */
export interface TemplateBehaviour {
	/** When the updates a write causes apply (the kit's `Reactivity.Schedule`): at once, in a microtask, in a task, or once the event's handler returns. */
	schedule: 'now' | 'microtask' | 'task' | 'event';
	/**
	 * What runs around a template's event handler: nothing, `Reactivity.event`, or `Reactivity.event` marking dirty the
	 * view the listener was added in (`kit.currentView`) and the views above it.
	 */
	eventScope: 'none' | 'event' | 'event+dirtyView';
	/** An element's props are set before its children are made (`pre`), or after them (`post`). */
	propsOrder: 'pre' | 'post';
	/** A template's bindings run together once its views are built, in tree order. */
	deferBindings: boolean;
	/**
	 * When a view joins the live tree: as it is created (`created`: a child joins a parent that is already loaded), when
	 * its block mounts top-down once all its views are made (`mounted`), or as a finished subtree (`built`).
	 */
	insertion: 'created' | 'mounted' | 'built';
	/** A template's event listeners are added after its bindings have set its properties. */
	listenersAfterBindings: boolean;
	/**
	 * The effect scope a template renders in, which orders its effects (`kit.scope`): the component's (`component`); a
	 * view's (`view`), given the component's injector and, under `check+onPush`, the component (a list's item template a
	 * view of its own, given the injector only), each `if` branch and `for` row rendering in a scope made from the view's;
	 * one a level deeper than its parent's, each branch and row a level
	 * deeper again (`depth`); or none. A list's rows, made when the native list loads them, render in the scope current
	 * where the list is bound (the kit's `RowScope`): an item template's view is a child of the view declaring it.
	 */
	effectScope: 'component' | 'view' | 'depth' | null;
	/**
	 * Bindings re-read when their view is checked (`kit.check`) as well as when what they read changes: never (`off`), on
	 * each check of their view (`check`), or as `check` with a component marked `onPush` checked only once it is marked
	 * dirty, as a parent giving one of its inputs a new value marks it (`check+onPush`).
	 */
	checkEveryBinding: 'off' | 'check' | 'check+onPush';
	/**
	 * Children join their parent as a driver attaching them by slot does (a child naming a slot the parent has is set as
	 * that property), and attribute values and conditions are taken as JSX gives them (`kit.attributeValue`, `kit.className`).
	 */
	slots: boolean;
	/**
	 * A `for` keeps each row by its key and gives it the item now at that key, the row reading its item and index as
	 * signals: with the items an array (`array`), or any value a render returns, an absent one rendering no rows (`value`:
	 * immutable updates, the items read through `kit.rowItems`). `off`: a row keeps the item it was made for.
	 */
	rowSignals: 'off' | 'array' | 'value';
	/** A component whose template is not one element renders its views into its parent's region, where its host is. */
	fragments: boolean;
	/**
	 * A child component is made without its inputs, its fields at the values its class gives them, and each input its
	 * parent gives is then set: the static ones as written, then the bound ones by their bindings, in template order.
	 */
	inputsAfterConstruction?: boolean;
	/**
	 * A view is made in two passes: a creation pass makes its views, its child components (each with its static inputs)
	 * and their views; an update pass then applies its bindings, `let` variables and `if`/`for` regions in template
	 * order, a child's bound inputs followed by its change, init and check hooks (after any `let` up to the next node
	 * bound, `afterHooks` aside), then updates the branches and rows its regions made (`TemplateKit.embedded`), then runs the content hooks,
	 * then each child's own update, then the after-view hooks; the content and after-view hooks in the order their
	 * elements end. A branch or row is made the same way, its update pass held until then. A component's hooks are its
	 * parent's to run (`render()` runs them for a root).
	 */
	passes?: boolean;
	/** Properties of a layout put around a routed page's content; the Kotlin back end's only. */
	pageContentAttrs?: Record<string, string>;
	/** The names of what the templates call that the core kit does not declare. */
	kit?: TemplateKit;
}

/**
 * Functions and values a framework's templates call that its adapter's kit declares, by what they do. Both kits declare
 * each under the same name; the template's code gives the arguments.
 */
export interface TemplateKit {
	/** The scope a template renders in (`effectScope`), and the one each `if` branch and `for` row renders in, if any. */
	scope?: { template: string; region?: string };
	/** The view of the effect scope current where a listener is added (`eventScope: 'event+dirtyView'`). */
	currentView?: string;
	/**
	 * A binding re-read when its view is checked as well as when what it reads changes, `check({ read }) { apply }`: every
	 * binding under `checkEveryBinding`, and a directive's, a prop setter's and a component's change hook's.
	 */
	check?: string;
	/** Marks a component checked `onPush` dirty, called once its parent gives one of its inputs a new value. */
	inputChanged?: string;
	/** Makes a directive whose host is an element's view: `directiveHost(view) { make }`. */
	directiveHost?: string;
	/**
	 * The view a router outlet is (a `Frame` element with a `router` attribute naming the outlet): `call(name)`; the
	 * outlet `primary` names is the call's default.
	 */
	routerOutlet?: { call: string; primary: string };
	/** An attribute's bound value as the view takes it, under `slots`. */
	attributeValue?: string;
	/** A bound class name as the view takes it, under `slots`. */
	className?: string;
	/** The rows of a `for` from the value its items give, under `rowSignals: 'value'`. */
	rowItems?: string;
	/**
	 * Under `passes`: `collect { bindings }` runs a template's bindings, then the update passes of the branches and rows
	 * its regions made there, which each held with `later { update }`, in that order. `later` outside a `collect` runs
	 * the update at once.
	 */
	embedded?: { collect: string; later: string };
	/**
	 * A hook run now and again on every check of the view it is in, `name { hook }`, at its point of the check: `check`
	 * among the view's bindings (`doCheck`), `content` after its embedded views (`afterContentChecked`), `view` after its
	 * child components (`afterViewChecked`).
	 */
	everyCheck?: { check: string; content: string; view: string };
	/**
	 * A `let` variable's slot, made in the creation pass from the closure reading its value, `letSlot { read }`; its
	 * `store()`, in the update pass, reads it once on every check of the view, and the template's methods read `value`.
	 */
	letSlot?: string;
	/** Wraps component instantiation (`construct { Comp(...) }`) to bind construction-scoped injections and initial effects. */
	construct?: string;
	/** Flushes a component's construction-scoped initial effects after `ngDoCheck` and before `ngAfterContentInit`. */
	flushEffects?: string;
	/** Wraps a root component's `render()` under `passes` so each root has its own host view scope. */
	rootScope?: string;
}

/**
 * The compiler's own functions and state an adapter uses, from the compiler instance that loaded it.
 * @experimental As `FrameworkAdapter`; it hands out compiler internals (`ts`, `rewrite`, `scopeTemplate`, `ELEMENTS`).
 */
export interface CoreApi {
	apiVersion: 1;
	/** The compiler's TypeScript, whose syntax trees and checker the adapter is given and makes nodes for. */
	ts: typeof ts;
	scopeTemplate: typeof scopeTemplate;
	rewrite: typeof rewrite;
	canonical: typeof canonical;
	ELEMENTS: typeof ELEMENTS;
	MODELS: typeof MODELS;
	rowTemplates: typeof rowTemplates;
	/** The build's platform folding and bundler defines applied to a source's text (program/platform.ts), positions kept. */
	foldPlatform(text: string, fileName: string, platform: Platform, modulesDir?: string): string;
	/** The package a module specifier names (`@scope/pkg` of `@scope/pkg/sub/path`, `pkg` of `pkg/sub`). */
	packageOf(specifier: string): string;
	/** Packages that build as no-op stand-ins (`release.stubPlugins`), known before any front end runs. */
	stubbedPlugins: ReadonlySet<string>;
	/** Whether core declares `decl`: the kit has it. */
	isCoreDeclaration(decl: ts.Declaration | undefined): boolean;
	/** Whether a function is async. */
	isAsync(fn: ts.Node): boolean;
	/** A file of the adapter's runtime by its path in the adapter's package (`runtime/forms.ts`); undefined for any other file. */
	adapterRuntimeFile(file: string | undefined): string | undefined;
	/** Swift's spelling, for Swift hooks. */
	swift: {
		/** A name as a Swift identifier (a keyword escaped). */
		ident(name: string): string;
		/** Whether a Swift type is optional (`T?`). */
		isOptional(t: string): boolean;
		/** Whether a Swift type is a function type. */
		isFunctionType(t: string): boolean;
		/** `try` before code that throws (`throws`), else the code. */
		tryIf(throws: boolean | undefined, code: string): string;
		/** The deinitializer every generated class declares. */
		NONISOLATED_DEINIT: string;
		/** A Swift string literal of the text. */
		string(text: string): string;
	};
	/** Kotlin's spelling, for Kotlin hooks. */
	kotlin: {
		/** A name as a Kotlin identifier (a keyword escaped). */
		ident(name: string): string;
		/** Whether a Kotlin type is nullable (`T?`). */
		isNullable(t: string): boolean;
		/** Whether a Kotlin type is a function type. */
		isFunctionType(t: string): boolean;
		/** A Kotlin string literal of the text. */
		string(text: string): string;
	};
}

// ---- Translators ----

/**
 * How the kit's `Signal<T>` holds a signal type, by what the type's API does:
 * - `writable`: read by calling it (`count()`), written by `set(v)`, `update(fn)` and `$write(v | fn)`; `asReadonly()` is itself;
 * - `input`: read by calling it, written by its template only (`$assign(v)`);
 * - `model`: read and written through its members;
 * - `computed`: read by calling it, `asReadonly()` itself; one a class field or module variable keeps as a memo is read as the value it computes;
 * - `store`: written by `set(v)` and `update(fn)`;
 * - `ref`: read and written through its `value`; an object written to it is made deeply reactive;
 * - `value`: read and written through its `value`.
 * In a strict app, a `writable`, `input` or `model` signal the compiler's shims declare, of one kind of value, null and
 * undefined, holds `JSNullish<T>`, telling null from undefined.
 */
export type SignalKind = 'writable' | 'input' | 'model' | 'computed' | 'store' | 'ref' | 'value';

/**
 * When a write to a signal is a change: a value not the same (`Object.is`) as the one it holds (`identity`); any object,
 * and a primitive not the same (`always-changed`); as `identity`, with an object written made deeply reactive (`deep`).
 */
export type SignalEquality = 'identity' | 'always-changed' | 'deep';

/**
 * A function making a signal of the value it is given: when a write to the signal is a change, the argument giving the
 * options whose `equal` decides it instead, and whether only a call whose result is a signal type is one (`typed`).
 * A `linked` one makes a writable signal that computes its value as a memo does (`linkedSignal`): its first argument is
 * the function computing it, or options whose `computation` does from what their `source` gives. A read or `update`
 * of it throws what computing it threw; the adapter's `globalCall` makes it.
 */
export type SignalConstructor = SignalEquality | { equality: SignalEquality; options?: number; typed?: boolean; linked?: boolean };

/**
 * A type the framework's declarations name, as generated code spells it: the kit's type (`Router`; `$0` stands for the
 * first type argument, `Emitter<$0>`), for any declaration of the name or (`shim`) only the compiler's shim's. A shim's
 * class named as a value (`typeof ErrorHandler`) is the class itself where `metatype` is set.
 */
export type TypeMapping = string | { type: string; shim?: boolean; metatype?: boolean };

/** What the throw analysis reads of the framework's API. */
export interface ThrowsModel {
	/** Functions and methods (`Owner.method`, `Owner.*`) of the compiler's shims that run their callback at once: they throw what it throws. */
	rethrowing?: string[];
	/** Whether making a class injects its constructor's parameters: its creation throws what injecting them throws. */
	injectsConstructor?(cls: ts.ClassLikeDeclaration): boolean;
	/** Whether injecting a constructor parameter can throw. */
	injects?(p: ts.ParameterDeclaration, t: ThrowsView): boolean;
	/** For a call of a shim's function or method that injects a token (`inject(Service)`), whether it can throw; else undefined. */
	injectCall?(decl: ts.Declaration, args: readonly ts.Expression[], t: ThrowsView): boolean | undefined;
}

/** What a throws model is given of the throw analysis. */
export interface ThrowsView {
	readonly checker: ts.TypeChecker;
	/** Whether constructing the class (its constructor, its fields' initializers) can throw. */
	initThrows(cls: ts.ClassLikeDeclaration): boolean;
}

/**
 * What the framework's API means to both back ends and to their analyses: data first, functions where data can't say
 * it. The compiler's own release vocabulary (`$signal`, `$ref`, `$writable`, `$state`, `$navigateTo`, `$showModal`,
 * `$closeModal`) needs no adapter.
 */
export interface FrameworkModel {
	/** A component's field without an initializer is a plain field, not a prop: the framework declares props otherwise (`input()`). */
	plainFields?: boolean;
	/** The translator's `rootView` wraps the code making a root view (the app's root, a route's): `wrapRootView`. */
	wrapsRootViews?: boolean;
	/** The framework's signal types, by name. */
	signalTypes?: Record<string, SignalKind>;
	/** The framework's functions making a signal of the value they are given, by name. */
	signalConstructors?: Record<string, SignalConstructor>;
	/**
	 * The framework's functions making a memo of the function they are given (`computed(fn)`), by name: the module
	 * declaring each. A memo is read as its value; a class field or module variable keeps the one it holds.
	 */
	memos?: Record<string, string>;
	/** The framework's functions whose result a class field keeps as a signal, read by its value (`toSignal(source)`). */
	heldSignals?: string[];
	/** The framework's functions a module's initializer may call while it loads without running the app's code: they make signals of their arguments. */
	pure?: string[];
	/** Types the framework's declarations name, by name. */
	typeMap?: Record<string, TypeMapping>;
	/** Modules the compiler shims whose classes are the kit's classes of their name with a prefix, by module (a module's `Subject` is the kit's `KitSubject` for `'Kit'`). */
	prefixedModules?: Record<string, string>;
	/** Interfaces of these shimmed modules (`scope/`: every module of the scope) are no generated interfaces: what implements them is called untyped. */
	untypedInterfaces?: string[];
	/** As `untypedInterfaces`, for a package's classes only. */
	untypedPackageInterfaces?: string[];
	/** Class decorators the framework reads: neither refused nor run. */
	classDecorators?: string[];
	/** The decorator making a class one of the framework's components (`Component`): the framework makes its objects. */
	componentDecorator?: string;
	/** The type of a component class as a value (`typeof Sheet`), as `componentAsValue` makes it. */
	componentValueType?: string;
	throwsModel?: ThrowsModel;
	/**
	 * The error a read of a component's prop field throws until its parent first sets it, for a prop the framework makes
	 * without a value (a required input, under `TemplateBehaviour.inputsAfterConstruction`); undefined for any other field.
	 */
	unsetError?(field: ts.PropertyDeclaration): string | undefined;
	/** The options a call making a signal is given, whose `equal` its writes call; undefined where the call makes none. */
	signalOptions?(call: ts.Expression | undefined, checker: ts.TypeChecker): { options: ts.Expression | undefined } | undefined;
	/**
	 * How the framework makes a class: `service` (the framework makes it, and `serviceClass` translates it), `based` (a
	 * service extending a class, translated as any class with `classExtras`), `root` (a plain class it also makes).
	 */
	classRole?(cls: ts.ClassDeclaration, pluginFiles: ReadonlySet<string>): 'service' | 'based' | 'root' | undefined;
	/** Static members `classExtras` adds to a class: a static of the class's own of one of these names takes another. */
	addedStatics?(cls: ts.ClassDeclaration, pluginFiles: ReadonlySet<string>, checker: ts.TypeChecker): string[];
	/** Why the framework calls a decorated class's method by its name, which fixes its signature; undefined where only the program calls it. */
	frameworkCalled?(cls: ts.ClassLikeDeclaration, name: string, checker: ts.TypeChecker): string | undefined;
	/** Whether the framework may call a class's method or setter where the program can't see it. */
	calledByFramework?(cls: ts.ClassLikeDeclaration, m: ts.MethodDeclaration | ts.SetAccessorDeclaration, checker: ts.TypeChecker): boolean;
	/** Whether a declared member may hold undefined at run time though its declared type leaves it out (e.g. `linkedSignal`'s `previous.source`). */
	unsetMembers?(d: ts.PropertySignature | ts.PropertyDeclaration, checker: ts.TypeChecker): boolean;
}

/** A component's field the framework's call makes a prop of (`input(0)`): its value's type and the default a parent may leave it at. */
export interface PropField {
	type: string;
	/** The default's code; none where the parent must give it. */
	default?: string;
}

/** What a back end's translator does differently for the framework: its model, and the calls and classes it translates itself. */
export interface TranslatorHooks<V extends TranslatorView = TranslatorView> extends FrameworkModel {
	/** A call of a global function (`inject(Service)`), by its name: its code, else undefined. `lib`: a declaration file declares it. */
	globalCall?(t: V, name: string, call: ts.CallExpression, decl: ts.Declaration | undefined, lib: boolean): string | undefined;
	/** A method call, by the name of its receiver's type (`HttpClient`) and the method's: its code, else undefined. */
	methodCall?(t: V, owner: string, method: string, call: ts.CallExpression): string | undefined;
	/** `new Name(…)` of a class only declared (`new Inject(TOKEN)`): its code, else undefined. */
	newCall?(t: V, name: string, call: ts.NewExpression): string | undefined;
	/** The value a component's or service's constructor parameter is given (an injected service): its code, else undefined. */
	constructorParameter?(t: V, p: ts.ParameterDeclaration): string | undefined;
	/** A component's field the framework's call initializes: a prop, the class's lines declaring it, or undefined for any other field. */
	componentField?(t: V, m: ts.PropertyDeclaration, name: string): { prop: PropField } | { lines: string[] } | undefined;
	/** Static members a component class adds (what its root view's injector reads). */
	componentStatics?(t: V, cls: ts.ClassDeclaration): string[];
	/** A component class as a value (`dialog.open(Sheet)`): what creating and rendering it gives. */
	componentAsValue?(t: V, cls: ts.ClassDeclaration, type: string): string | undefined;
	/** The code making a component's root view, wrapped as the framework makes it (in its own environment). */
	wrapRootView?(t: V, cls: ts.ClassDeclaration, type: string, make: string): string;
	/** A class `classRole` says the framework makes as a whole, translated. */
	serviceClass?(t: V, cls: ts.ClassDeclaration, name: string): string;
	/** What a class's translation adds for the framework; `code` is the class's so far. */
	classExtras?(t: V, cls: ts.ClassDeclaration, name: string, code: string): ClassExtras | undefined;
	/** Code following a class's translation (`code`), as a Swift extension of it. */
	afterClass?(t: V, cls: ts.ClassDeclaration, code: string): string | undefined;
}

/** What a class's translation adds for the framework. */
export interface ClassExtras {
	supertypes?: string[];
	/** Members (Swift) or companion object members (Kotlin). */
	members?: string[];
	/** A supertype of the Kotlin companion object. */
	companionSupertype?: string;
}

/**
 * What a hook is given of the translator: the members hooks use, and nothing else. Types are spelled as the generated
 * language spells them (`Signal<Double>`), `Any?` an untyped value; code is the generated language's.
 * @experimental Translator views give and take generated code and spelled types as strings; they will give typed values
 * instead, and may change in any release until then.
 */
export interface TranslatorView {
	readonly checker: ts.TypeChecker;
	/** Files of the plugins the build compiles from their source. */
	readonly pluginFiles: ReadonlySet<string>;
	/** The build's components, by name: the props each takes and the names of its generated members. */
	readonly components: ReadonlyMap<string, { props: string[]; optional?: string[]; members: ComponentMembers }>;
	/** The indentation of the statement being translated. */
	readonly indent: string;
	/** Whether the build compiles a class of the program's sources: a plugin's only where it is reached. */
	compiles(decl: ts.ClassDeclaration): boolean;
	/** An expression's code. */
	expr(e: ts.Expression): string;
	/** An expression's code as a value of type `t`. */
	coerce(e: ts.Expression, t: string): string;
	/** A value stored where `at` holds one of type `t` (a field, a variable, a signal). */
	stored(e: ts.Expression, at: ts.Node, t: string): string;
	/** A call's argument as a value of type `t`; a spread one packed. */
	restArgument(call: ts.CallExpression | ts.NewExpression, arg: ts.Expression, t: string): string;
	/** Code giving an untyped value, read as type `t`. */
	fromAny(code: string, t: string): string;
	/** An expression's code as a string, converted as `String(x)` converts it. */
	str(e: ts.Expression): string;
	/** A function value given to an API that runs it later: what it throws is reported. */
	callback(e: ts.Expression): string;
	/** The type of a node's value. */
	typeOf(n: ts.Node): string;
	/** A TypeScript type, spelled at `where`. */
	type(t: ts.Type, where?: ts.Node): string;
	/** The name of the symbol of an expression's type (`WritableSignal`). */
	symbolName(e: ts.Expression): string;
	/** The symbol a name refers to, aliases followed. */
	resolve(n: ts.Node): ts.Symbol | undefined;
	/** A program declaration's name in generated code, which may differ from its own (a name the SDK also declares). */
	topName(decl: ts.Node, name: string): string;
	/** The text of a call's callee (`input.required`), '' for any other expression. */
	calleeName(e: ts.Expression): string;
	/** A refusal of the construct at `n`, reported as the compiler's own are. */
	error(n: ts.Node | undefined, what: string, id?: RefusalId): Error;
	/** `, …` giving the `equal` a signal's options (`{ equal }`) give, for a signal or memo of type `t`; undefined where they give none. */
	equalsArg(options: ts.Expression | undefined, t: string): string | undefined;
	/** The value a component's or service's constructor parameter is given (`constructorParameter`, else its default). */
	constructorParameter(p: ts.ParameterDeclaration): string;
	/** A component's root view made by `make`, as the framework makes it (`wrapRootView`). */
	rootView(cls: ts.ClassDeclaration, type: string, make: string): string;
	/** A navigation (`$navigateTo`) to a component, with the props `options` (`{ props }`) give. */
	navigate(e: ts.CallExpression, component: string, options: ts.Expression | undefined): string;
}

/** What a Swift hook is given of the Swift translator. */
export interface SwiftTranslatorView extends TranslatorView {
	/** Whether running code throws, as the translator writes Swift's `try`. */
	readonly throwsInfo: {
		/** A function's body, or a function value. */
		fn(fn: ts.Node): boolean;
		/** An expression, not the functions it creates. */
		expr(e: ts.Node): boolean;
		/** Constructing a class: its constructor and its fields' initializers. */
		initThrows(cls: ts.ClassLikeDeclaration): boolean;
		/** Injecting a constructor parameter (`ThrowsModel.injects`). */
		injects(p: ts.ParameterDeclaration): boolean;
	};
	/** `, equals: …` for a signal's options; `throwing`: a memo's, which keeps what `equal` throws as its value. */
	equalsArg(options: ts.Expression | undefined, t: string, throwing?: boolean): string | undefined;
	/** Code giving an untyped value, read as type `t` (`orZero`: a missing one as `t`'s zero). */
	fromAnyCode(code: string, t: string, orZero?: boolean): string;
	/** Code converting a value of type `from` to type `to`. */
	convert(code: string, from: string, to: string): string;
	/** Reading the signal `signal` holds, as a call `signal()` reads it: `try` written where the read can throw. */
	signalRead(signal: ts.Expression): string;
	/** A function's body as a block of type `ret`'s returns, its lines indented from `base`. */
	functionBody(fn: ts.FunctionLikeDeclaration, ret: string, base: string): string;
	/** A memo of `fn` (`Memo<rt>`), its function throwing where `throws`; `ofInstance`: one an instance holds. */
	memo(fn: ts.ArrowFunction | ts.FunctionExpression, rt: string, throws: boolean, ofInstance?: boolean): string;
	/** A class's base class among the program's sources. */
	sourceBase(cls: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | undefined;
	/** A component's or service's members, constructor and fields: the lines inside its class but its `render()`. */
	componentMembers(cls: ts.ClassDeclaration, props: string[], plainFields?: boolean): string[];
}

/** What a Kotlin hook is given of the Kotlin translator. */
export interface KotlinTranslatorView extends TranslatorView {
	/** A function literal's code, as a value of `slot` (a Kotlin function type) where given. */
	closure(fn: ts.ArrowFunction | ts.FunctionExpression, slot?: string): string;
	/** A function value's code (a declared function by reference, `::f`). */
	functionValue(e: ts.Expression): string;
	/** A memo of `fn` (`Memo<rt>`), its body indented from `base`. */
	memo(fn: ts.ArrowFunction | ts.FunctionExpression, rt: string, base: string): string;
	/** Whether a class's static field the module's statements initialize is held nullable until they run. */
	heldUntilModuleRuns(m: ts.PropertyDeclaration): boolean;
	/** A component's or service's members: its constructor's parameters, the lines inside its class but its `render()`, and its companion object's. */
	componentMembers(cls: ts.ClassDeclaration, props: string[], plainFields?: boolean): { params: string[]; lines: string[]; statics: string[] };
}

// ---- Program, modules and runtime ----

/** A refusal's class: JavaScript a compiled release cannot run by design (`limit`), or code the compiler does not translate yet (`gap`). */
export type RefusalClass = 'limit' | 'gap';

/** A kind of refusal: its title, suggestion and example, as a build's refusal report shows them. */
export interface RefusalKind {
	class: RefusalClass;
	title: string;
	/** What to write instead, or which `nativescript.config` option changes the refusal. */
	suggestion: string;
	before?: string;
	after?: string;
	/** A limit's reason, part of its message. */
	why?: string;
}

/** The ids of the compiler's own refusals, which a hook may refuse with too. */
export type CompilerRefusalId =
	| 'proxy'
	| 'reflect'
	| 'eval'
	| 'function-constructor'
	| 'finalization-registry'
	| 'shared-array-buffer'
	| 'atomics'
	| 'with'
	| 'computed-import'
	| 'computed-require'
	| 'arguments-callee'
	| 'proto'
	| 'process-env'
	| 'undefined-constant'
	| 'shared-typed-copy'
	| 'shared-copy'
	| 'lone-surrogate'
	| 'generic-any-argument'
	| 'generic-field-overload'
	| 'generic-field-erased'
	| 'array-hole'
	| 'function-arguments'
	| 'builtin-prototype'
	| 'object-call'
	| 'library-member'
	| 'function-value'
	| 'other-receiver'
	| 'builtin-receiver'
	| 'function-new'
	| 'wrapper-object'
	| 'class-prototype'
	| 'function-this'
	| 'element-accessor'
	| 'private-receiver'
	| 'finally-jump'
	| 'class-expression'
	| 'named-function-expression'
	| 'unsupported-base'
	| 'worker'
	| 'delete-member'
	| 'index-type'
	| 'native'
	| 'internal'
	| 'unhandled';

/** The id of a refusal a build reports: the compiler's own, or its framework adapter's (`AdapterRefusalIds`). */
export type RefusalId = CompilerRefusalId | keyof AdapterRefusalIds;

/**
 * The ids of the refusals adapters make (`FrameworkAdapter.refusals`), which the translator's `error()` and `limit()`
 * take beside the compiler's own. An adapter adds its own by augmenting this interface: `{ 'its-id': true }`.
 */
export interface AdapterRefusalIds {}

/** The package an adapter ships as: generated code names a file of its runtime `<name>@<version> <path from root>`. */
export interface AdapterPackage {
	name: string;
	version: string;
	root: string;
}

/**
 * Native sources an adapter adds to the kit, as folders relative to its package's root (`package.root`). They compile
 * into the kit's own module (NativeScriptKit, kit-android's `:kit`), and so may use its internal members.
 */
export interface AdapterKit {
	/** Swift. Kit generation writes beside it what it adds to the kit's index (`kit-index.json`), which builds read. */
	apple?: string;
	/** Kotlin. */
	android?: string;
	/** Kotlin over the classes kit-android generates from core, read before the kit's hand-written Kotlin. */
	androidGenerated?: string;
}

/** How a framework's modules resolve in the build's program, beside the packages it compiles from their source. */
export interface ModuleRules {
	/**
	 * Declarations the program reads for a module in place of its package's, by specifier: only their types matter, as
	 * the translators recognise the calls and types they declare.
	 */
	shims?: Record<string, string>;
	/** Shims of packages a build that compiles packages from their source compiles, for a build that does not. */
	fallbackShims?: Record<string, string>;
	/** Specifiers that resolve to a file the adapter ships (a port of a package), unless the app replaces the package. */
	substitutions?: Record<string, Substitution>;
	/** Extensions of the framework's component files, which an import may leave off (`./App` for `App` with one of them). */
	componentExtensions?: string[];
	/**
	 * A package's entry module whose components the front end compiles from their source with the app's: the program
	 * keeps the entry's declarations rather than compile those components' files again as the package's modules.
	 * `virtual`: the files the build reads from the front end's text.
	 */
	isLibraryEntry?(specifier: string, source: string, virtual: readonly string[]): boolean;
	/** Constructor parameter decorators the framework runs when it makes the class: what their arguments name is reached. */
	parameterDecorators?: string[];
}

/** A file a specifier resolves to: compiled as a package's source is, however it is imported. */
export interface Substitution {
	file: string;
	/** Only in a build that compiles packages from their source; another reads the shim of `otherwise`, else the specifier's own. */
	sourcesOnly?: boolean;
	otherwise?: string;
	/** Its classes' members are also read by name, as untyped code reads them (`form.get('name').value`). */
	membersByName?: boolean;
}
