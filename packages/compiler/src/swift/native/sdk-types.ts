// The iOS SDK's tables as the compiler reads them: native classes, methods, properties, enums, functions, constants and structs.
import type { ScopedKind } from './sdk-tables.ts';

/**
 * How NativeScript's JavaScript names for an iOS SDK module's Objective-C and
 * C APIs are spelled in Swift. A table per module is generated from the
 * module's Swift symbol graph (`swift-symbolgraph-extract`), whose symbols
 * carry their Clang USRs: the USR gives the Objective-C selector or C name,
 * from which the NativeScript metadata name follows, and the symbol gives
 * the Swift spelling and types.
 */

export type SwiftType = string;
export interface NativeMethod {
	kind: 'method' | 'init';
	swift: string;
	labels: (string | null)[];
	/** A `()` parameter (`init(toMemory: ())`, `init(contentsOf:error: ()) throws`) takes no JavaScript argument: pass `()`. */
	params: SwiftType[];
	returns: SwiftType;
	throws?: boolean;
	errorParam?: number;
	/** The parameters Swift declares `@escaping`, which an implementation of the method must declare so too. */
	escaping?: number[];
	failable?: boolean;
	introduced?: string;
	selector: string;
	/** Isolated to the main actor by a Swift module (Objective-C's isolation is preconcurrency and needs nothing). */
	mainActor?: boolean;
	/** A protocol's optional requirement: called through the protocol type as `m!(…)`. */
	optional?: boolean;
}
export interface NativeProperty {
	kind: 'property';
	swift: string;
	type: SwiftType;
	readonly: boolean;
	introduced?: string;
	mainActor?: boolean;
	/** A protocol's optional requirement: Swift can't assign it through the protocol type. */
	optional?: boolean;
}
export interface NativeClass {
	swift: string;
	kind: 'class' | 'protocol';
	base?: string;
	protocols?: string[];
	module: string;
	instance: Record<string, NativeMethod | NativeProperty>;
	static: Record<string, NativeMethod | NativeProperty>;
	constructors: Record<string, NativeMethod>;
	inits: Record<string, NativeMethod>;
	/** Members another module adds to a class declared in `module` (an Objective-C category). */
	extension?: boolean;
	/**
	 * Initializers the Swift overlay declares in place of Objective-C ones it hides
	 * (`UIAction(title:image:identifier:discoverabilityTitle:attributes:state:handler:)`),
	 * with which parameters have defaults; lookups match JavaScript keys against them.
	 */
	swiftInits?: (NativeMethod & { defaults: boolean[] })[];
	/** Generic parameters Swift keeps (`NSHashTable<ObjectType>`); `swift` names the type without its arguments. */
	generics?: string[];
	introduced?: string;
	/** A Swift class declaring initializers of its own, which inherits none of its base's. */
	ownInits?: boolean;
}
export interface NativeEnum {
	/** '' when Swift imports the cases as global constants (a C enum without NS_ENUM): `cases[…].swift` is then the global's name. */
	swift: string;
	kind: 'enum' | 'options' | 'typedConstants';
	raw: string;
	cases: Record<string, { swift: string; value?: number | string }>;
	introduced?: string;
}
export interface NativeFunction {
	/**
	 * Also 'staticProperty': `owner.swift` (`UIAccessibilityIsVoiceOverRunning()` → `UIAccessibility.isVoiceOverRunning`);
	 * 'equal': Swift's `==` on the two arguments.
	 */
	kind: 'init' | 'property' | 'method' | 'function' | 'staticMethod' | 'staticProperty' | 'equal';
	owner?: string;
	swift: string;
	self?: number;
	labels: (string | null)[];
	params: SwiftType[];
	returns: SwiftType;
	introduced?: string;
}
export interface NativeConstant {
	swift: string;
	type: SwiftType;
	enumType?: string;
}
export interface NativeStruct {
	swift: string;
	fields: Record<string, SwiftType>;
}
export interface NativeTable {
	module: string;
	sdk: string;
	/** The table's layout; one cached in another is extracted again. */
	format?: number;
	classes: Record<string, NativeClass>;
	enums: Record<string, NativeEnum>;
	functions: Record<string, NativeFunction>;
	constants: Record<string, NativeConstant>;
	structs: Record<string, NativeStruct>;
	/** The module declaring each class or protocol this module refers to (as a base or adopted protocol) but does not declare. */
	types?: Record<string, string>;
	/** What the module's C typedefs stand for, by Swift name (`TimeInterval` → `Double`). */
	typealiases?: Record<string, SwiftType>;
	/**
	 * Every public top-level type the module declares to Swift, Swift-only ones too (StoreKit's `SubscriptionInfo`), by
	 * name: what a file importing it and another module declaring the name has to tell apart.
	 */
	swiftTypes?: Record<string, ScopedKind>;
}
