// The Kotlin translator's types: its config, native API, library and core, a call's parameters, and the shapes of dynamic members and shape fields.
import type ts from 'typescript';
import type { TranslatorConfig } from '../semantics/config.ts';
import type { ComponentMembers, KotlinTranslatorView } from '../api/adapter-api.ts';
import type { ModuleThread } from '../semantics/threading.ts';
import type { Translator } from './translator.ts';

/**
 * TypeScript to Kotlin, typed by the checker, with JavaScript's semantics
 * where Kotlin's differ: numbers are Double and print as JavaScript prints
 * them, arrays, maps, sets and objects are references (`JSArray`, `JSMap`,
 * `JSSet`, `JSRecord`, classes), `any` is `Any?`, exceptions carry the thrown
 * value (`JSException`), and async functions are continuations over
 * spec-exact promises (async.ts). Anything outside what is translated stops
 * the build with its file, line and construct.
 */

export interface ComponentInfo {
	name: string;
	props: string[];
	members: ComponentMembers;
}

/** Direct calls into the Android SDK (`android.*`, `java.*`), typed by @nativescript/types-android. */
export interface KotlinNative {
	type(t: ts.Type): string | null;
	/** The class above the asserted one a variable's uses need (`view.android as ScrollView` used as a View). */
	assertedWiderClass?(d: ts.VariableDeclaration): string | null;
	isValueType(t: string): boolean;
	/** A Java class's Kotlin type name (`android.app.Activity`) as an expression at `where` names it (`::class.java`). */
	expressionName?(type: string, where: ts.Node | undefined): string;
	isNativeDeclaration(d: ts.Node): boolean;
	/** Whether a typings declaration's Java binding holds null: a field's value, a method's result, a parameter's argument. */
	jvmHoldsNil?(d: ts.Declaration): boolean;
	identifier(e: ts.Identifier): string | null;
	property(e: ts.PropertyAccessExpression): string | null;
	/** A method of a Java object read as a value through an optional chain (`layout?.getImeInsets`). */
	methodValue?(e: ts.PropertyAccessExpression, target?: string): string | null;
	call(e: ts.CallExpression): string | null;
	construct(e: ts.NewExpression): string | null;
	assign(left: ts.PropertyAccessExpression, right: ts.Expression): string | null;
	structLiteral(e: ts.ObjectLiteralExpression, t: ts.Type): string | null;
	classDecl(c: ts.ClassDeclaration): string | null;
	/** Whether a variable only names a Java class (`const GestureHandler = com.swmansion.gesturehandler.GestureHandler`): its uses are the class's. */
	isClassAlias(d: ts.VariableDeclaration): boolean;
	/** The Kotlin class a variable holding NativeScript's `Base.extend({ … })` declares in its place. */
	extensionClass(d: ts.VariableDeclaration): string | null;
	/** The nearest class `from` extends that is also a `to`, when `from` is not one itself. */
	sharedClass(from: string, to: string): string | null;
	toNumber(e: ts.Expression, t: string): string | null;
	/** A value where a Java parameter of descriptor `desc` takes it. */
	toJava(e: ts.Expression, desc: string, nullableParam?: boolean, nonNullParam?: boolean, signature?: string, typeVar?: (name: string) => string): string;
}

/** What the kit generated from core leaves out of core's modules, or implements itself. */
export interface KotlinLibrary {
	/** Functions that return their last argument, and as decorators leave what they decorate as it is (`profile`). */
	identities: Set<string>;
	/** The kit's Kotlin implementing a core module's function (`ColorMix.argbFromColorMix`), or null. */
	counterpart(file: string, name: string): string | null;
	/** The object holding a compiled module's functions and variables (`Core_ui_core_view_index`), or null for a file not compiled. */
	moduleName?(file: string): string | null;
	/** Types the hand-written kit beside the generated code declares (Signals' `Source`), which a generated one must not take. */
	internalTypes?: Set<string>;
	/** The interfaces of core only ever given back to the app, with their fields held untyped (`resultShapesOf`): classes, not untyped objects. */
	resultShapes?: ReadonlyMap<ts.Symbol, ReadonlySet<string>>;
}

/** @nativescript/core's API through the Android kit. */
export interface KotlinCore {
	/** Whether kit-android declares a type of this name. */
	has(name: string): boolean;
	/** Whether the kit's class of this name views any object as one of it (`Size.jsView`): a result interface of core's. */
	viewable?(name: string): boolean;
	/** Whether kit-android declares a class of this name open, for an app's class to extend. */
	subclassable(name: string): boolean;
	/** Whether the kit's type of this name is nested in another (`RegionPart.Nested`): not imported by its simple name. */
	nested?(name: string): boolean;
	/** The kit's class of core's class `name`. */
	kitClass(name: string): string;
	/** Whether a kit type is a view (extends View). */
	isKitView(name: string): boolean;
	/** A member of a kit type or a type it extends, as the kit declares it. */
	kitMember(owner: string, name: string): { kind: string; type: string; params?: string; static: boolean } | null;
	owner(e: ts.Expression): { name: string; isStatic: boolean } | null;
	coreVariable?(e: ts.Identifier): string | null;
	superArgs?(base: string, e: ts.CallExpression, args: string[]): string[];
	kitExtends?(name: string, base: string): boolean;
	nativeClassOf(e: ts.Expression): string | null;
	type(t: ts.Type): string | null;
	property(e: ts.PropertyAccessExpression): string | null;
	lvalue(e: ts.PropertyAccessExpression): string | null;
	call(e: ts.CallExpression): string | null;
	construct(e: ts.NewExpression): string | null;
	assign(left: ts.PropertyAccessExpression, right: ts.Expression): string | null;
	nonVirtualEntry(type: string, name: string): string | null;
	augmentedRead(e: ts.PropertyAccessExpression): string | null;
	kotlinKitNil?(x: ts.Expression): boolean;
}

/** What the Kotlin translator is given at construction beyond what both are (semantics/config.ts). */
export interface KotlinConfig extends TranslatorConfig<KotlinTranslatorView, KotlinLibrary> {
	/** @nativescript/core's API through the Android kit, made before the constructor's passes: the names they take step aside for the kit's types. */
	readonly core?: (t: Translator) => KotlinCore;
	/** The Android SDK binding (the app's classpath). */
	readonly native?: (t: Translator) => KotlinNative;
	/** The thread each module's code runs on (threading.ts). */
	readonly moduleThread?: ((file: string) => ModuleThread | undefined) | null;
	/** A module's name for `AppModules.runImport`, where modules `await import(…)` reaches run when imported. */
	readonly moduleKey?: (file: string) => string;
}

/** A call's parameters as `args` reads them: the signature it resolves to, an overload's implementation, and whether the program declares them. */
export interface CallParams {
	sig: ts.Signature | undefined;
	impl: ts.FunctionLikeDeclaration | null | undefined;
	params: ts.Symbol[];
	appDeclared: boolean;
}
/** What `dynamicMembers` reads and writes by name besides the keys' state. */
export interface DynamicMembers {
	/**
	 * `made`: a key from its first write, which the object's record notes (`MadeKeys`); until then it reads undefined
	 * (`unset`), or its prototype's value (`inherited`).
	 */
	fields: { name: string; type: string; member?: string; at?: ts.PropertyDeclaration; own?: boolean; made?: 'unset' | 'inherited' }[];
	className: string | null;
	/** Below a class that has these members: its keys come first and its members take the rest. */
	inherits?: boolean;
	/** Optional ones (an object type's `[K]?: T`) are own keys while they hold a value; `fixed`: the front's `fixedKey`. */
	symbols?: { key: string; fixed?: boolean; either?: boolean; maybeUndefined?: boolean; member: string; type: string; optional?: boolean }[];
	methods?: { name: string; key?: string; fixed?: boolean; either?: boolean; maybeUndefined?: boolean; params: string[]; defaults?: (string | undefined)[]; unread?: boolean[]; ret: string }[];
	accessors?: { name: string; type: string; readable: boolean; settable: boolean; set?: string }[];
	/** The base whose `jsHasMember` takes the rest. */
	superclass?: string;
	/** An app class's methods see the object they are called on as `this` when it is one of this class's. */
	receiver?: string;
	/** Declared at the top level, so it may keep its fixed symbol keys' `JSKeyIndex` (Kotlin has no object in a local class). */
	keyIndex?: boolean;
}
/** A field of an object literal's class; an accessor runs functions the literal gives. */
export interface ShapeField {
	name: string;
	type: string;
	/** The member it is held in when apart from its key (`signatureField`). */
	member?: string;
	accessor?: { get: boolean; set: boolean; value: string };
	symbol?: boolean;
	/** Declared in app code: a function it holds, read by name, takes script's arguments (`scriptFunctionRead`). */
	own?: boolean;
	/** A field keyed by a program's symbol: the Kotlin code of its property key. */
	key?: string;
}
