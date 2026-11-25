# Refusals and platform differences

Compiled code does what the same code does in JavaScript, for code the type checker accepts and whose types are
honest. Where the compiler cannot make it do so, it stops the build at the construct, with its file, line and a
suggested rewrite, rather than compile code that behaves differently. This page lists every such refusal, every
difference between the iOS and Android output, and where the remaining known divergences are recorded. The tables are
generated from the source (`node tests/checks/docs.ts --write`), and CI fails when they are stale.

## Two kinds of refusal

Every refusal has an id and a class. The catalog is `src/semantics/refusals.ts`; a framework adapter adds its own
(`FrameworkAdapter.refusals` in `src/api/adapter-api.ts`), reported the same way.

- **Limits** (`class: 'limit'`) are JavaScript that a compiled release cannot run by design: code that needs a
  JavaScript engine at run time (`eval`, `Proxy`, `new Function`), shared memory, finalizers, an environment the
  release does not have (`process.env`), or behaviour a native representation cannot keep (an array copied where
  JavaScript shares it, a lone surrogate in a Swift string). Each comes with a rewrite.
- **Gaps** (`class: 'gap'`) are code that runs as JavaScript and that the compiler does not translate yet. They are
  compiler bugs, not rules. The build's report marks each one as a compiler gap and links the issue tracker.

Refusals are made at three points:

1. preflight (`src/driver/preflight.ts`), before translation, for library globals and syntax with no compiled
   runtime;
2. the translators, as they meet a construct (`limit()` and `error()`, each naming the refusal's id; most of the
   translators' `error()` sites name none yet and report `unhandled`, so that one row stands for many constructs the
   catalog does not list one by one);
3. `src/semantics/limits.ts`, for constructs one platform cannot hold, each tied to a ledger entry (below).

A build lists the refusals it met at the end, grouped by id, with the catalog's rewrite for each (`RefusalLog.report`).
`--all-errors` lists every refused construct rather than stopping at the first. Each rewrite with a `before`/`after`
example in the catalog is run on both backends by a diff case and matches Node.

### Limits

<!-- generated: refusals-limit -->
| Id | What is refused | What to write instead | Refused on |
|---|---|---|---|
| `proxy` | Proxy (a compiled release has no JavaScript engine to run its traps) | use a class with explicit getters and setters, or a Map for dynamic keys | both |
| `reflect` | Reflect | use the operation directly (obj[key], key in obj, Object.keys(obj), new Cls(...args)) | both |
| `eval` | eval | there is no JavaScript engine to evaluate code: replace it with a lookup of known functions, or keep this app on the JavaScript release | both |
| `function-constructor` | Function from text | there is no JavaScript engine to compile a function from text: write the function in the source | both |
| `finalization-registry` | FinalizationRegistry | finalizers do not run in a compiled release: release the resource explicitly (a dispose() method, or an unloaded/disposeNativeView hook) | both |
| `shared-array-buffer` | SharedArrayBuffer | use an ArrayBuffer, and post copies between workers | both |
| `atomics` | Atomics | use an ArrayBuffer and post messages between workers instead of shared memory | both |
| `with` | `with` | name the object explicitly (`obj.x` instead of `x` inside `with (obj)`) | both |
| `computed-import` | import() of a computed specifier | import each module by a literal path (`() => import('./pages/a')`), and choose among those functions at run time | both |
| `computed-require` | require() of a computed specifier | require each module by a literal path, and choose among them at run time | both |
| `arguments-callee` | `arguments.callee` | name the function and call it by its name | both |
| `proto` | `__proto__` | use Object.getPrototypeOf, or a class hierarchy declared in the source | both |
| `process-env` | process.env the bundler did not define | a compiled release has no process environment: define the variable in the bundler config (Vite `define`, webpack DefinePlugin), which the compiled build reads too | both |
| `undefined-constant` | a bundler constant declared but never given a value | if your bundler defines it (Vite `define`, webpack DefinePlugin), the compiled build reads the same config: check the name there; otherwise assign globalThis.NAME before it is read | both |
| `shared-typed-copy` | an array of one object type converted into an array of another, a copy where JavaScript shares it | declare the value with the wanted type where it is made, or copy it explicitly (`list.map((x) => ({ ...x }))`) | both |
| `shared-copy` | an untyped value converted into a copy where JavaScript shares it | give the value its type where it is made (`const out: number[] = []`, a typed field), so no copy is made; or copy explicitly (`const copy: number[] = Array.from(raw)`) and write the results back yourself | both |
| `lone-surrogate` | a string literal holding a lone surrogate (half of a UTF-16 pair) (an iOS build holds strings as Swift strings, which hold only whole Unicode characters: a lone surrogate would read as U+FFFD) | write whole characters, or keep the UTF-16 code units as numbers where the code works on halves of a pair | one backend: [`wholeCharacterStrings`](#the-ledger) |
| `generic-any-argument` | a generic class's instance held with `any` as its type argument (Swift holds a generic class's type argument, which `any` does not erase) | hold it with its own type argument; an overload implementation types its parameters and result as its overloads do | one backend: [`genericsReified`](#the-ledger) |
| `generic-field-overload` | a generic class's field met as a generic interface's field (Swift can't overload a property by its type) | declare the interface's field with a concrete type, or read it through a method | one backend: [`genericsReified`](#the-ledger) |
| `generic-field-erased` | a generic class's field met as a generic interface's writable field (the interface's field is erased to any value, which the class's field can't override) | declare the interface's field with a concrete type, or read it through a method | one backend: [`genericsReified`](#the-ledger) |
<!-- /generated -->

### Gaps

<!-- generated: refusals-gap -->
| Id | What is refused | What to write instead | Refused on |
|---|---|---|---|
| `array-hole` | an array hole | write each missing element as `undefined` | both |
| `function-arguments` | `arguments` in a function expression | take a rest parameter | both |
| `builtin-prototype` | a built-in prototype (Number.prototype, String.prototype), or a method added to it | write the method as a plain function that takes the number | both |
| `object-call` | Object(value) | write what the call is used for: an object literal for a fresh object, or the value itself when it is already an object | both |
| `library-member` | a library function or member the compiler does not provide yet | use the global or more common form where there is one (`parseInt(s)` for `Number.parseInt(s)`), or write the operation as a plain function | both |
| `function-value` | a library function used as a value | pass an arrow function that calls it | both |
| `other-receiver` | .call or .apply with a receiver other than the method's object | call the function directly with its arguments, or make the receiver a parameter | both |
| `builtin-receiver` | a built-in method called through .call or .apply on a value of another type | convert the value to the method's type first and call the method on it | both |
| `function-new` | `new` of a function that is not a class | declare a class whose constructor does what the function does, and construct the class | both |
| `wrapper-object` | a wrapper object (`new String(…)`, `new Number(…)`, `new Boolean(…)`) | use the primitive value, which `String(x)`, `Number(x)` or `Boolean(x)` gives | both |
| `class-prototype` | a class's prototype object (`C.prototype`) read as a value | call the method on an instance, or declare it `static` and call it on the class | both |
| `function-this` | `this` outside a method, constructor or class field | pass the object the function works on as a parameter | both |
| `element-accessor` | a getter or setter defined on an array element | keep the value in a class with a getter, or compute it when the array is built | both |
| `private-receiver` | a private member (`#x`) of a value not typed as its class | type the value as its class (`o: Box`) | both |
| `finally-jump` | a jump out of a finally block | keep the result in a variable and return it after the try statement | one backend: [`finallyJumps`](#the-ledger) |
| `class-expression` | a class expression | declare the class with a name, then use it | both |
| `named-function-expression` | a named function expression that refers to itself | declare it as a function declaration and refer to that name | both |
| `unsupported-base` | a class extending null, Function or another base the compiler does not extend yet | declare the class without that base: hold a function in a field and call it, or use Object.create(null) for an object without a prototype | both |
| `worker` | a Worker in an iOS build | the iOS kit starts no workers yet (Android's does): run the work on the main thread in slices (a setTimeout per batch), or in native code on a background queue, and post its result back | both |
| `delete-member` | delete of this member | keep entries that come and go in a Map (map.delete(key)), or make the field optional and assign undefined | both |
| `index-type` | indexing this type | give the indexed object a Record or Map type, or read the member by its name | both |
| `native` | a native API the compiler does not call yet | move the code into a plain function of its own with typed parameters and result, so the rest of the module translates; the refusal then names only that function | both |
| `internal` | code the translator failed on | move the code into a plain function of its own with typed parameters and result, so the rest of the module translates; the refusal then names only that function | both |
| `unhandled` | a construct the compiler does not translate yet | move the code into a plain function of its own with typed parameters and result, so the rest of the module translates; the refusal then names only that function | both |
<!-- /generated -->

## The ledger

`src/semantics/ledger.ts` names every difference between the two backends' answers to a JavaScript-semantics
question, one field each, with a Swift and a Kotlin value. The shared front branches on a backend only through these
fields (`tests/checks/layers.ts`), and a diff case that runs on one backend names the entry or refusal that keeps it off
the other (`tests/checks/both-backends.ts`). Each entry has a kind (`LEDGER_KINDS`):

- **platform**: the platforms differ (Swift's value types and reference counting, the JVM's erasure and garbage
  collector, Apple's SDK against Android's). The entry stays.
- **gap**: one backend does not do it yet, or the two do it in ways that only a larger change makes one. The entry is
  removed, with its cases' markers, when both backends give the JavaScript answer.

The text in the last column is the first sentence of the entry's doc comment; the comment has the full reason and the
cases that show it.

### Platform entries

<!-- generated: ledger-platform -->
| Entry | Swift | Kotlin | What it says |
|---|---|---|---|
| `checkedParameters` | no | yes | A parameter's native checks throw for a null its type leaves out (Kotlin checks every non-null parameter on entry), so `ValueStates.mayBeNull` counts every way an empty value reaches one, with the backend's `parameterChecks`; and a string an unset regexp group may leave undefined is loose. |
| `nativeSdk` | `apple` | `android` | The native SDK the platform binds: a program calling one platform's classes, or reading its globals, builds only for it. |
| `freesOnLastReference` | yes | no | An object is freed as its last reference goes (reference counting), so a WeakRef or a listener's lifetime is seen a task later. |
| `subclassFieldsBeforeBase` | yes | no | A subclass's fields hold their initial values before its base's constructor runs, so a base reading an overridden field there sees that value, not undefined: Swift initializes a class's own stored properties before `super.init`. |
| `functionElementsUntyped` | yes | no | A function held as a container's element (an array's, a Map's or Set's) is held as its function object, untyped, so that `===`, `indexOf` and `delete` find the function given: a Swift closure has no identity. |
| `errorClassObjects` | no | yes | An error class held as a value (`ErrorConstructor`, `typeof TypeError`) is its class object (`Class<out JSError>`), which `instanceof`, `new` and `.name` take: a JVM class is an object. |
| `structuralGenericsErased` | yes | no | A function literal's type parameter, one bound to a shape (`U extends { root: View }`) and one a function's parameters name only inside function types are erased to any value (`erasesTypeParameter`): no Swift constraint states a shape, and a closure passed through a Swift generic is reabstracted, which loses its identity. |
| `appClassValuesUntyped` | no | yes | An app or plugin class held as a value (`typeof Style`, `[Plain]`) is its JVM class object, held untyped, which `new` and statics reach by reflection. |
| `tuplesBeyondThree` | yes | no | A tuple of four or more elements is a native tuple. |
| `wholeCharacterStrings` | yes | no | A string holds whole Unicode characters only: an iOS build holds strings as Swift strings, where a lone surrogate (half of a UTF-16 pair) would read as U+FFFD, so a literal holding one is refused (`lone-surrogate`). |
| `genericsReified` | yes | no | A generic class's type argument is part of its native type (Swift's generics are reified): `any` as the argument (`generic-any-argument`) and a field met as a generic interface's field of another type (`generic-field-overload`, Swift overloads no property by type) are refused. |
<!-- /generated -->

### Gap entries

<!-- generated: ledger-gap -->
| Entry | Swift | Kotlin | What it says |
|---|---|---|---|
| `looseReads` | yes | no | `ValueStates.looseDeclaration` is asked of reads and declarations both, and answers for the declaration they name; without it, a declaration answers for itself and a read of a widened field (`widenedFieldRead`) for its field. |
| `implicitThisUnconstructed` | yes | no | A function declaration reading a `this` it does not declare takes its receiver as its first parameter (`implicitThis`). |
| `workerGlobals` | no | yes | The kit runs worker scripts: `Worker`, `MessageEvent`, `ErrorEvent` and `URL` are web classes it implements. |
| `failedUnwrapThrows` | no | yes | A read of an empty value the types say present (a narrowing a closure outlived, a module `let` read before its declaration runs) throws what the program catches as JavaScript's TypeError or ReferenceError: Kotlin's `!!` and lateinit reads throw. |
| `typedArrays` | yes | no | Typed arrays whole: `BigUint64Array`, callbacks taking (value, index, array), constructors as values, BigInt elements written; Kotlin does not yet. |
| `typedFlat` | yes | no | `flat(depth)` of a typed nested array gives the flattened element type; Kotlin does not yet. |
| `functionObjects` | yes | no | A stored function read as a function object: its `length`, and `apply`/`call` giving it a receiver; Kotlin does not yet. |
| `functionIdentity` | yes | no | A method value is one function per receiver, and a function adapted to another function type is still the function it adapts (`===`); Kotlin does not yet. |
| `unboundGenerics` | yes | no | Type parameters with no native statement: one any value binds, one bound to a class and a shape, read by name; Kotlin does not yet. |
| `indexConversions` | yes | no | JavaScript's integer conversions where an index, a length, digits or a radix is taken, with their RangeErrors; Kotlin does not yet. |
| `accessorNameClash` | yes | no | A static field and a static method whose JVM accessor names are one (`instance` and `getInstance()`) both declared. |
| `genericAsyncResult` | yes | no | The result of a generic async function returning `Awaited<T>`; Kotlin does not yet. |
| `orAssignTyped` | yes | no | `map[k] \|\| (map[k] = v)` held as a typed slot of the map's value type; Kotlin does not yet. |
| `errorSubclassConstructor` | yes | no | An Error subclass without its own constructor made with a message; Kotlin does not yet. |
| `errorSubclassKeyOrder` | no | yes | An Error subclass's fields listed (Object.keys, JSON) in declaration order, before what the constructor adds; Swift does not yet. |
| `unmetInterfaceMembers` | yes | no | A class implementing an interface whose inherited members it cannot meet natively still implements it; Kotlin does not yet. |
| `pluginsWrittenStrict` | yes | no | A plugin compiled from source is strict code where its files are written strict (`writtenStrict`; the others are the config's `lenientFiles`). |
| `undefinedResultsWidened` | yes | no | A function that may give undefined has an optional result (Swift's `mayReturnUndefined`, which reads no narrowing: a lenient function's `if (cached) return cached` of a record's entry counts). |
| `nullabilityBeforeEmission` | yes | no | A declaration's empty state is decided before any read of it (lenient code's parameter property typed with a `null` TypeScript drops is optional). |
| `recursiveTupleLiteralLevels` | yes | no | A literal of a recursive tuple alias (`type Link = [number, Link \| null]`) is held as a native tuple of its first level, the cycle met a level down; Kotlin meets it at once and holds an untyped array. |
| `lenientByTranslatedFile` | yes | no | Leniency is that of the file being translated (`lenientFiles`): a question about another file's node, asked while a strict file is translated, is answered as strict code. |
| `finallyJumps` | no | yes | Control may leave a finally block (`return` or `throw` in it), and a try whose finally throws may `break`, `continue` or `return`. |
| `throwingOptionalInputsLeftOut` | yes | no | A child component's optional input whose first value may throw is left out of its construction, so it starts at its default (template/plan.ts `ComponentArg`), where its framework makes a component with its inputs (not under `TemplateBehaviour.inputsAfterConstruction`). |
| `valueRowReadsReported` | no | yes | Signal rows over any value (`rowSignals: 'value'`): items or a key that throw are reported, not only left out (Swift's `try?`). |
| `listHeaderRendered` | yes | no | A sectioned list's header template is rendered by the kit's ListView. |
| `pageContentLayout` | no | yes | A routed page's content is put in the layout `TemplateBehaviour.pageContentAttrs` describes (a framework's navigator laying pages out in a flexbox). |
| `lazyConstants` | yes | no | An initializer counts as constant (`constantInit`: it may run where the platform sets its variable or static) when it reads a regexp literal, a library global's member other than a listed constant (`LIBRARY_CONSTANTS`), a namespace's constant, a framework's pure call, or an import's constant through a shorthand property. |
| `symbolKeyedByValue` | no | yes | A class member is named by what a key the program computes holds where it may hold a string or a symbol (`[observable]` of a `string \| symbol`), and, in library code and on the generated kit, by any symbol value (`[fooProperty.setNative]`). |
| `throwingStaticsInOrder` | yes | no | A static field's initializer that may throw runs where JavaScript defines its class (`staticInModuleOrder`): a Swift static's initializer cannot throw. |
| `untypedCastsStrictOnly` | yes | no | An untyped value asserted to an object type (`assertedUntyped`) is checked by a cast only in strict code, and only for an object reference whose class's or shape's checked conversion can fail (Swift's `untypedCastChecks`). |
| `expandoDeclaredOnly` | yes | no | Which members are read and written by name as script's own additions to an object (`isExpando`) is answered by each backend. |
| `staticTypeofConditions` | yes | no | An `if` whose condition the program decides keeps only its live branch, and each backend decides it. |
| `modeCasesOneBackend` | yes | no | Library-mode cases (mode line `@lenient`: code compiled as core is for the kit) and plugin cases (`@plugin`) written against one kit first, which the other backend's translation does not match Node in yet, each for its own reason. |
<!-- /generated -->

## Other known divergences

- **Known failures.** Diff cases that do not match Node yet are listed in `tests/diff/known-failures.json`, each with
  its owner, cause and failure signature; [tests/README.md](../tests/README.md#differential-cases) says how the
  harness holds them.
- **Static types are trusted where TypeScript proves them.** A value typed `number` is held as a native double. When
  a program lies to the checker (an `any` holding a string passed where a `number` is declared), the compiled program
  can differ from Node where JavaScript would have coerced the value. Type-violation fuzzing (`tests/fuzz`) measures
  this, and its baseline (`tests/fuzz/known-fuzz-failures.json`) records the known differences by cluster, with how
  many variants a whole nightly run compares ([tests/README.md](../tests/README.md#fuzz-baseline)).
- **Floating point on Android.** `Math.pow` with a fractional exponent can be one ulp off on Android, whose `pow` is not
  correctly rounded. Integer exponents are exact on both platforms.
- **test262.** Tests the compiler accepts but that fail are listed with their reason in
  `tests/test262/baseline.json` ([results](../tests/test262/README.md#results)).
