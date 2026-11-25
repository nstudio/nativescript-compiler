// The Swift translator's types: its config and library, pending returns and loops, and the shapes of typeof cells, iterators, dynamic members and shape fields.
import type ts from 'typescript';
import type { TranslatorConfig } from '../semantics/config.ts';
import type { KitDeclarations } from '../kit/manifest.ts';
import type { ComponentMembers, SwiftTranslatorView } from '../api/adapter-api.ts';

/**
 * TypeScript to Swift, typed by the checker, with JavaScript's semantics
 * where Swift's differ: numbers are Double and print as JavaScript prints
 * them, arrays, maps, sets and objects are references, `any` is `Any?`,
 * exceptions are Swift errors carrying the thrown value, and async functions
 * are continuations over spec-exact promises (async.ts). Anything outside
 * what is translated stops the build with its file, line and construct.
 */

/** A return recorded where Swift cannot make it yet (a try whose finally throws, a stepped loop): the block it leaves, its flag and value. */
export interface PendingReturn {
	label: string;
	flag: string | null;
	value: string | null;
}

/** A stepped `for…of` (`forOfSteps`): the label leaving it, the variable naming the labeled jump that left, and those jumps. */
export interface ClosingLoop {
	node: ts.ForOfStatement;
	label: string;
	jump: string;
	exits: ts.BreakOrContinueStatement[];
}

export interface ComponentInfo {
	name: string;
	props: string[];
	members: ComponentMembers;
}

/**
 * Library mode (the kit generated from core): each module's functions and variables are static members of an enum named
 * for the module, so modules never collide with each other or shadow Swift's own functions (`round`).
 */
export interface SwiftLibrary {
	moduleName(file: string): string | null;
	counterpart?(file: string, name: string): string | null;
	isMoot?(file: string): boolean;
	identities?: Set<string>;
	internalTypes?: Set<string>;
	sourceOf?(declarationFile: string): string | null;
	strict?(file: string): boolean;
	resultShapes?: ReadonlyMap<ts.Symbol, ReadonlySet<string>>;
}

/** What the Swift translator is given at construction beyond what both are (semantics/config.ts). */
export interface SwiftConfig extends TranslatorConfig<SwiftTranslatorView, SwiftLibrary> {
	/** What the kit's configuration holds weakly (`Translator.weak`). */
	readonly weak?: { fields?: Iterable<string>; captures?: Iterable<string> };
	/** App mode: the identifiers the Swift compiled into the app's module spells (`PluginNative.appNames`). */
	readonly appSwiftNames?: Iterable<string>;
	/** The plugins' and pods' modules the program declares something of, beside Foundation and UIKit. */
	readonly nativeModules?: Iterable<string>;
	/** While the kit is generated from core: the hand-written kit files the generated code replaces. */
	readonly kitExclude?: RegExp;
	/** The plugin files the build compiles; a class or interface only the others declare is no Swift type. */
	readonly compiledFiles?: ReadonlySet<string> | null;
	/** Kit generation: where the declarations the generated code makes public are recorded. */
	readonly declarations?: KitDeclarations | null;
	/** The app's own Swift classes that TypeScript declares untyped (`declare const X: any`). */
	readonly appNativeClasses?: Iterable<string>;
	/** The plugins' native classes by their Objective-C names, each with its Swift name. */
	readonly pluginNativeClasses?: Iterable<readonly [string, string]>;
	/** The plugins' native modules, whose protocols `Cls.extend(…, { protocols })` names. */
	readonly pluginModules?: readonly string[];
	/** Kit generation: the SDK binding's view of the kit (`NativeAPI.internalTypes`, `counterpartModules`). */
	readonly kitNative?: { readonly internalTypes: ReadonlySet<string>; readonly counterpartModules: ReadonlySet<string> };
}

/**
 * What `typeof x` gives: one type always (`known`), the type or "undefined" as `tested` is there (`presence`, which a
 * comparison with either reads as a nil test), or what script code computes (`code`).
 */
export type TypeofCell = { cell: 'known'; type: string } | { cell: 'presence'; tested: string; type: string } | { cell: 'code'; code: string };

export interface IteratorMethod {
	name: string;
	params: number;
	param?: string;
	ret: string;
	throws: boolean;
	/** A field holding the function optional (lenient code's), called as script calls it. */
	optional?: boolean;
}
/** What `dynamicMembers` reads and writes by name besides the keys' state. */
export interface DynamicMembers {
	/**
	 * `made`: a key from its first write, which the object's record notes (`MadeKeys`); until then it reads undefined
	 * (`unset`), or its prototype's value (`inherited`).
	 */
	fields: { name: string; type: string; member?: string; at?: ts.PropertyDeclaration; made?: 'unset' | 'inherited' }[];
	className: string | null;
	/** Below a class that has these members: its keys come first and its members take the rest. */
	override?: boolean;
	methods?: { name: string; type: string; available?: number; length?: number }[];
	/** Optional ones (an object type's `[K]?: T`) are own keys while they hold a value. */
	symbols?: { key: string; member: string; type: string; optional?: boolean }[];
	/** Non-expando app classes' symbol-named instance methods, reached by `subscript(jsKey:)` and `jsHasMember`. */
	symbolMethods?: SymbolMethod[];
	/** Library mode: registered properties, read and written through the expando. */
	raw?: ReadonlySet<string>;
	accessors?: { name: string; get: string | null; set: string | null }[];
	symbolKeyedBase?: boolean;
	/** Declares `jsClassName` (an error keeps JSError's). */
	classNameMember?: boolean;
	byName?: { receiver: string; inherits: boolean };
	hasMember?: { inherits: boolean };
}
export interface SymbolMethod {
	key: string;
	method: string;
	owner: string;
	params: string[];
	unread: boolean[];
	ret: string;
	throws: boolean;
}
/** A field of an object literal's class; an accessor runs closures the literal gives. */
export interface ShapeField {
	name: string;
	type: string;
	/** The member it is held in when apart from its key (`signatureField`). */
	member?: string;
	accessor?: { get: boolean; set: boolean; throws: boolean; value: string };
	symbol?: boolean;
	/** A field keyed by a program's symbol: the Swift code of its property key. */
	key?: string;
}
