// Every difference between the two backends' answers, each named once. The front branches on a backend only through
// these fields (tests/checks/layers.ts forbids testing a backend's name anywhere else in semantics/), and a diff case that
// runs on one backend names the entry, or the refusal, that keeps it off the other (tests/checks/both-backends.ts).
// `LEDGER_KINDS` says why each entry exists:
// - platform: the platforms differ (Swift's value types and reference counting, the JVM, Apple's SDK against Android's).
//   It stays.
// - gap: a backend does not do it yet, or the two do it in ways only a larger change makes one; the entry says which.
//   It goes, with its cases' markers, when both do it one way.

import type { RefusalId } from './refusals.ts';

export interface Ledger {
	/**
	 * `ValueStates.looseDeclaration` is asked of reads and declarations both, and answers for the declaration they name;
	 * without it, a declaration answers for itself and a read of a widened field (`widenedFieldRead`) for its field. Each
	 * backend's loose-slot handling is built on its own answer: Kotlin on this one fails cases 225, 440, 442, 1013, 1471
	 * and 1591, Swift on the other most of 72 (09, 1007, 1023, …). One answer needs one loose-slot design.
	 */
	readonly looseReads: boolean;
	/**
	 * A parameter's native checks throw for a null its type leaves out (Kotlin checks every non-null parameter on entry), so
	 * `ValueStates.mayBeNull` counts every way an empty value reaches one, with the backend's `parameterChecks`; and a
	 * string an unset regexp group may leave undefined is loose.
	 */
	readonly checkedParameters: boolean;
	/**
	 * A function declaration reading a `this` it does not declare takes its receiver as its first parameter
	 * (`implicitThis`). Neither backend does so for a constructor function (`new Point(…)` of one assigning `this.x`) or
	 * for one reading its `arguments` too. With it, a function `new` constructs takes none and one reading `arguments`
	 * takes one (which Swift does not compile); without it, the reverse (`new` of the function is no constructor call).
	 */
	readonly implicitThisUnconstructed: boolean;
	/**
	 * The kit runs worker scripts: `Worker`, `MessageEvent`, `ErrorEvent` and `URL` are web classes it implements. An
	 * iOS build refuses them (platform-globals.ts).
	 */
	readonly workerGlobals: boolean;
	/** The native SDK the platform binds: a program calling one platform's classes, or reading its globals, builds only for it. */
	readonly nativeSdk: 'apple' | 'android';
	/**
	 * An object is freed as its last reference goes (reference counting), so a WeakRef or a listener's lifetime is seen
	 * a task later. The JVM frees objects when its collector runs, which a program can ask for but not force.
	 */
	readonly freesOnLastReference: boolean;
	/**
	 * A read of an empty value the types say present (a narrowing a closure outlived, a module `let` read before its
	 * declaration runs) throws what the program catches as JavaScript's TypeError or ReferenceError: Kotlin's `!!` and
	 * lateinit reads throw. Swift's failed unwrap traps, which nothing catches; Swift could throw there too, with a check
	 * at each such read.
	 */
	readonly failedUnwrapThrows: boolean;
	/**
	 * A subclass's fields hold their initial values before its base's constructor runs, so a base reading an overridden
	 * field there sees that value, not undefined: Swift initializes a class's own stored properties before `super.init`.
	 */
	readonly subclassFieldsBeforeBase: boolean;
	/** Typed arrays whole: `BigUint64Array`, callbacks taking (value, index, array), constructors as values, BigInt elements written; Kotlin does not yet. */
	readonly typedArrays: boolean;
	/** `flat(depth)` of a typed nested array gives the flattened element type; Kotlin does not yet. */
	readonly typedFlat: boolean;
	/** A stored function read as a function object: its `length`, and `apply`/`call` giving it a receiver; Kotlin does not yet. */
	readonly functionObjects: boolean;
	/** A method value is one function per receiver, and a function adapted to another function type is still the function it adapts (`===`); Kotlin does not yet. */
	readonly functionIdentity: boolean;
	/** Type parameters with no native statement: one any value binds, one bound to a class and a shape, read by name; Kotlin does not yet. */
	readonly unboundGenerics: boolean;
	/** JavaScript's integer conversions where an index, a length, digits or a radix is taken, with their RangeErrors; Kotlin does not yet. */
	readonly indexConversions: boolean;
	/** A static field and a static method whose JVM accessor names are one (`instance` and `getInstance()`) both declared. */
	readonly accessorNameClash: boolean;
	/** The result of a generic async function returning `Awaited<T>`; Kotlin does not yet. */
	readonly genericAsyncResult: boolean;
	/** `map[k] || (map[k] = v)` held as a typed slot of the map's value type; Kotlin does not yet. */
	readonly orAssignTyped: boolean;
	/** An Error subclass without its own constructor made with a message; Kotlin does not yet. */
	readonly errorSubclassConstructor: boolean;
	/** An Error subclass's fields listed (Object.keys, JSON) in declaration order, before what the constructor adds; Swift does not yet. */
	readonly errorSubclassKeyOrder: boolean;
	/** A class implementing an interface whose inherited members it cannot meet natively still implements it; Kotlin does not yet. */
	readonly unmetInterfaceMembers: boolean;
	/**
	 * A plugin compiled from source is strict code where its files are written strict (`writtenStrict`; the others are
	 * the config's `lenientFiles`). Without it every plugin file is lenient code. Kotlin holds every plugin declaration
	 * nullable (`nullableDecls`: plugin code passes null and undefined for objects), which trusting a strict plugin's
	 * types would contradict; one rule needs Kotlin's plugin nullability to follow how each plugin is written.
	 */
	readonly pluginsWrittenStrict: boolean;
	/**
	 * A function held as a container's element (an array's, a Map's or Set's) is held as its function object, untyped,
	 * so that `===`, `indexOf` and `delete` find the function given: a Swift closure has no identity. Kotlin's lambdas are
	 * objects, and a function adapted to another type keeps the one it adapts (`JSAdapted`).
	 */
	readonly functionElementsUntyped: boolean;
	/**
	 * An error class held as a value (`ErrorConstructor`, `typeof TypeError`) is its class object (`Class<out JSError>`),
	 * which `instanceof`, `new` and `.name` take: a JVM class is an object. Swift's kit holds it untyped, as the
	 * runtime's constructor object.
	 */
	readonly errorClassObjects: boolean;
	/**
	 * A function literal's type parameter, one bound to a shape (`U extends { root: View }`) and one a function's
	 * parameters name only inside function types are erased to any value (`erasesTypeParameter`): no Swift constraint
	 * states a shape, and a closure passed through a Swift generic is reabstracted, which loses its identity. Kotlin keeps
	 * them (its lambdas take none: their type parameters are their constraints).
	 */
	readonly structuralGenericsErased: boolean;
	/**
	 * An app or plugin class held as a value (`typeof Style`, `[Plain]`) is its JVM class object, held untyped, which
	 * `new` and statics reach by reflection. Swift holds its metatype (`Style.Type`).
	 */
	readonly appClassValuesUntyped: boolean;
	/** A tuple of four or more elements is a native tuple. Kotlin has `Pair` and `Triple` only: a longer one is an array. */
	readonly tuplesBeyondThree: boolean;
	/**
	 * A function that may give undefined has an optional result (Swift's `mayReturnUndefined`, which reads no narrowing:
	 * a lenient function's `if (cached) return cached` of a record's entry counts). Kotlin holds the declared result and
	 * reads lenient code's null through it. The held type of such a call differs (case 1188).
	 */
	readonly undefinedResultsWidened: boolean;
	/**
	 * A declaration's empty state is decided before any read of it (lenient code's parameter property typed with a `null`
	 * TypeScript drops is optional). Kotlin decides it as it emits the declaration (`nullableDecls`): a read typed earlier
	 * reads it present (case 444).
	 */
	readonly nullabilityBeforeEmission: boolean;
	/**
	 * A literal of a recursive tuple alias (`type Link = [number, Link | null]`) is held as a native tuple of its first
	 * level, the cycle met a level down; Kotlin meets it at once and holds an untyped array. Both declare the binding an
	 * untyped array: only the literal's own held type differs (case 1388).
	 */
	readonly recursiveTupleLiteralLevels: boolean;
	/**
	 * Leniency is that of the file being translated (`lenientFiles`): a question about another file's node, asked while a
	 * strict file is translated, is answered as strict code. Kotlin's is the build's (case 1713, a helper module).
	 */
	readonly lenientByTranslatedFile: boolean;
	/**
	 * A string holds whole Unicode characters only: an iOS build holds strings as Swift strings, where a lone surrogate
	 * (half of a UTF-16 pair) would read as U+FFFD, so a literal holding one is refused (`lone-surrogate`). A JVM string
	 * is UTF-16 code units, as JavaScript's.
	 */
	readonly wholeCharacterStrings: boolean;
	/**
	 * A generic class's type argument is part of its native type (Swift's generics are reified): `any` as the argument
	 * (`generic-any-argument`) and a field met as a generic interface's field of another type (`generic-field-overload`,
	 * Swift overloads no property by type) are refused. A typed array where an untyped one is wanted is the kit's untyped
	 * view of it (`jsUntypedArray`), and one where an array of what its elements also are is wanted (`number[][]` as
	 * `any[][]`, `Dog[]` as `Animal[]`) its view as that (`jsArrayView`): the one array, except as an array of an
	 * interface (a protocol existential no view holds), which is a new array of the elements. A value its element type
	 * cannot hold, written through a view, is stored as JavaScript stores it where the array can hold it: an untyped
	 * array whose elements fit becomes that typed array (keeping the untyped one as its view); in an array of numbers,
	 * any value, which typed code reads as NaN (Kotlin's typed read of it is a TypeError) and untyped reads, `typeof`,
	 * printing, JSON and string conversion read as itself. In an array of strings, booleans or objects it is a TypeError
	 * (reported where the write cannot throw) and leaves the array as it was. The JVM erases type
	 * arguments, so a field typed by the class's type parameter cannot override an interface's writable field erased to
	 * any value (`generic-field-erased`).
	 */
	readonly genericsReified: boolean;
	/**
	 * Control may leave a finally block (`return` or `throw` in it), and a try whose finally throws may `break`,
	 * `continue` or `return`. Swift lowers a finally that does not throw to `defer`, which control cannot leave, and
	 * refuses these (`finally-jump`); Kotlin's `finally` is JavaScript's.
	 */
	readonly finallyJumps: boolean;
	/**
	 * A child component's optional input whose first value may throw is left out of its construction, so it starts at
	 * its default (template/plan.ts `ComponentArg`), where its framework makes a component with its inputs (not under
	 * `TemplateBehaviour.inputsAfterConstruction`). Swift knows which reads throw and leaves out only those. Kotlin's
	 * backend does not, and a call cannot leave an argument out at run time: such an input starts at its type's zero, as a
	 * required one does.
	 */
	readonly throwingOptionalInputsLeftOut: boolean;
	/** Signal rows over any value (`rowSignals: 'value'`): items or a key that throw are reported, not only left out (Swift's `try?`). */
	readonly valueRowReadsReported: boolean;
	/**
	 * A sectioned list's header template is rendered by the kit's ListView. The Android kit's ListView is core's, which
	 * makes the header from its XML itself (`Builder.parse`), so the plan hands it the XML.
	 */
	readonly listHeaderRendered: boolean;
	/** A routed page's content is put in the layout `TemplateBehaviour.pageContentAttrs` describes (a framework's navigator laying pages out in a flexbox). */
	readonly pageContentLayout: boolean;
	/**
	 * An initializer counts as constant (`constantInit`: it may run where the platform sets its variable or static) when it
	 * reads a regexp literal, a library global's member other than a listed constant (`LIBRARY_CONSTANTS`), a namespace's
	 * constant, a framework's pure call, or an import's constant through a shorthand property. Swift sets each global and
	 * static when it is first read, so any constant is set by then. A Kotlin file's or object's values are set as its
	 * class loads only where its at-load test (`pure`) holds, which leaves these out: one rule needs that test to take
	 * them first, as a static read early must not find a module value unset.
	 */
	readonly lazyConstants: boolean;
	/**
	 * A class member is named by what a key the program computes holds where it may hold a string or a symbol
	 * (`[observable]` of a `string | symbol`), and, in library code and on the generated kit, by any symbol value
	 * (`[fooProperty.setNative]`). Without it, Swift's class emitter finds such methods by their key itself
	 * (`jsSymbolMethod`, `setProperty`).
	 */
	readonly symbolKeyedByValue: boolean;
	/**
	 * A static field's initializer that may throw runs where JavaScript defines its class (`staticInModuleOrder`): a Swift
	 * static's initializer cannot throw. Kotlin has no analysis of what may throw: a constant initializer that throws
	 * (`static s = \`${Symbol.iterator}\``) throws as its companion loads.
	 */
	readonly throwingStaticsInOrder: boolean;
	/**
	 * An untyped value asserted to an object type (`assertedUntyped`) is checked by a cast only in strict code, and only
	 * for an object reference whose class's or shape's checked conversion can fail (Swift's `untypedCastChecks`).
	 * Without it, every assertion to an object type is checked, in any code, other than to the kit's arrays, records,
	 * promises, dates and errors (Kotlin's). Each backend answers from the type it spells; one rule needs what a cast can
	 * fail on as a fact of the `NativeType`.
	 */
	readonly untypedCastsStrictOnly: boolean;
	/**
	 * Which members are read and written by name as script's own additions to an object (`isExpando`) is answered by
	 * each backend. Both count a field defined by key, a member TypeScript declares nowhere and an interface merged into
	 * a class. With it (Swift), also a member only declarations name (`declaredOnly`), an event data member the kit's
	 * EventData lacks, an abstract plugin class's members, and a member an ambient interface adds where the SDK binding
	 * lacks it. Without it (Kotlin), any member an ambient interface adds, a member of a class typed as its base
	 * (`tokenClassBase`), a property assigned to a function, and a field of a program interface extending a native class.
	 * One rule needs the SDK binding's answers in the front.
	 */
	readonly expandoDeclaredOnly: boolean;
	/**
	 * An `if` whose condition the program decides keeps only its live branch, and each backend decides it. Both take
	 * the build's constant values (`reach.constant`), boolean literals, `!`, `&&` and `||`. With it (Swift's
	 * `staticTypeof`), also two string literals compared, an `instanceof` of a value always of that class, a comparison
	 * with null of a value never nullish, and a `typeof` test of a known type. Without it (Kotlin's `staticTruth`), a
	 * `typeof` test of a constant type, and a number or boolean compared with null or undefined. One rule needs one
	 * decider in the front.
	 */
	readonly staticTypeofConditions: boolean;
	/**
	 * Library-mode cases (mode line `@lenient`: code compiled as core is for the kit) and plugin cases (`@plugin`) written
	 * against one kit first, which the other backend's translation does not match Node in yet, each for its own reason.
	 * The cases naming this entry list them; a case takes its `-both` mode line when it passes on both.
	 */
	readonly modeCasesOneBackend: boolean;
}

export type LedgerKind = 'platform' | 'gap';

export const LEDGER_KINDS: { readonly [K in keyof Ledger]: LedgerKind } = {
	looseReads: 'gap',
	checkedParameters: 'platform',
	implicitThisUnconstructed: 'gap',
	workerGlobals: 'gap',
	nativeSdk: 'platform',
	freesOnLastReference: 'platform',
	failedUnwrapThrows: 'gap',
	subclassFieldsBeforeBase: 'platform',
	typedArrays: 'gap',
	typedFlat: 'gap',
	functionObjects: 'gap',
	functionIdentity: 'gap',
	unboundGenerics: 'gap',
	indexConversions: 'gap',
	accessorNameClash: 'gap',
	genericAsyncResult: 'gap',
	orAssignTyped: 'gap',
	errorSubclassConstructor: 'gap',
	errorSubclassKeyOrder: 'gap',
	unmetInterfaceMembers: 'gap',
	pluginsWrittenStrict: 'gap',
	functionElementsUntyped: 'platform',
	errorClassObjects: 'platform',
	structuralGenericsErased: 'platform',
	appClassValuesUntyped: 'platform',
	tuplesBeyondThree: 'platform',
	undefinedResultsWidened: 'gap',
	nullabilityBeforeEmission: 'gap',
	recursiveTupleLiteralLevels: 'gap',
	lenientByTranslatedFile: 'gap',
	wholeCharacterStrings: 'platform',
	genericsReified: 'platform',
	finallyJumps: 'gap',
	throwingOptionalInputsLeftOut: 'gap',
	valueRowReadsReported: 'gap',
	listHeaderRendered: 'gap',
	pageContentLayout: 'gap',
	lazyConstants: 'gap',
	symbolKeyedByValue: 'gap',
	throwingStaticsInOrder: 'gap',
	untypedCastsStrictOnly: 'gap',
	expandoDeclaredOnly: 'gap',
	staticTypeofConditions: 'gap',
	modeCasesOneBackend: 'gap',
};

export const SWIFT_LEDGER: Ledger = {
	looseReads: true,
	checkedParameters: false,
	implicitThisUnconstructed: true,
	workerGlobals: false,
	nativeSdk: 'apple',
	freesOnLastReference: true,
	failedUnwrapThrows: false,
	subclassFieldsBeforeBase: true,
	typedArrays: true,
	typedFlat: true,
	functionObjects: true,
	functionIdentity: true,
	unboundGenerics: true,
	indexConversions: true,
	accessorNameClash: true,
	genericAsyncResult: true,
	orAssignTyped: true,
	errorSubclassConstructor: true,
	errorSubclassKeyOrder: false,
	unmetInterfaceMembers: true,
	pluginsWrittenStrict: true,
	functionElementsUntyped: true,
	errorClassObjects: false,
	structuralGenericsErased: true,
	appClassValuesUntyped: false,
	tuplesBeyondThree: true,
	undefinedResultsWidened: true,
	nullabilityBeforeEmission: true,
	recursiveTupleLiteralLevels: true,
	lenientByTranslatedFile: true,
	wholeCharacterStrings: true,
	genericsReified: true,
	finallyJumps: false,
	throwingOptionalInputsLeftOut: true,
	valueRowReadsReported: false,
	listHeaderRendered: true,
	pageContentLayout: false,
	lazyConstants: true,
	symbolKeyedByValue: false,
	throwingStaticsInOrder: true,
	untypedCastsStrictOnly: true,
	expandoDeclaredOnly: true,
	staticTypeofConditions: true,
	modeCasesOneBackend: true,
};

export const KOTLIN_LEDGER: Ledger = {
	looseReads: false,
	checkedParameters: true,
	implicitThisUnconstructed: false,
	workerGlobals: true,
	nativeSdk: 'android',
	freesOnLastReference: false,
	failedUnwrapThrows: true,
	subclassFieldsBeforeBase: false,
	typedArrays: false,
	typedFlat: false,
	functionObjects: false,
	functionIdentity: false,
	unboundGenerics: false,
	indexConversions: false,
	accessorNameClash: false,
	genericAsyncResult: false,
	orAssignTyped: false,
	errorSubclassConstructor: false,
	errorSubclassKeyOrder: true,
	unmetInterfaceMembers: false,
	pluginsWrittenStrict: false,
	functionElementsUntyped: false,
	errorClassObjects: true,
	structuralGenericsErased: false,
	appClassValuesUntyped: true,
	tuplesBeyondThree: false,
	undefinedResultsWidened: false,
	nullabilityBeforeEmission: false,
	recursiveTupleLiteralLevels: false,
	lenientByTranslatedFile: false,
	wholeCharacterStrings: false,
	genericsReified: false,
	finallyJumps: true,
	throwingOptionalInputsLeftOut: false,
	valueRowReadsReported: true,
	listHeaderRendered: false,
	pageContentLayout: true,
	lazyConstants: false,
	symbolKeyedByValue: true,
	throwingStaticsInOrder: false,
	untypedCastsStrictOnly: false,
	expandoDeclaredOnly: false,
	staticTypeofConditions: false,
	modeCasesOneBackend: false,
};

/**
 * The refusals one backend gives and the other never does, each with the entry that says why
 * (tests/checks/both-backends.ts holds the backends' sources to it). Every other refusal is given alike by both.
 */
export const ONE_BACKEND_REFUSALS: Readonly<Partial<Record<RefusalId, keyof Ledger>>> = {
	'lone-surrogate': 'wholeCharacterStrings',
	'generic-any-argument': 'genericsReified',
	'generic-field-overload': 'genericsReified',
	'generic-field-erased': 'genericsReified',
	'finally-jump': 'finallyJumps',
};
