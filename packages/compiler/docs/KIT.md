# The kit

NativeScriptKit is the native code a compiled app links instead of a JavaScript engine. On each platform it has two
parts:

- **A hand-written runtime** that gives translated code JavaScript's semantics: values, conversions, operators,
  promises and microtasks, iteration, the built-in objects, plus the signals and regions templates update through,
  and the bridges to the platform.
- **`@nativescript/core` compiled by this compiler.** Core's own TypeScript is translated in library mode into Swift and
  Kotlin. The kit's views, layout, CSS, navigation and bindings are therefore core's code, and they follow core release
  by release with no port to maintain. This part is generated and never committed.

An app compiles only the part of the kit it reaches (`src/program/reach.ts`). A framework app also compiles its
adapter's kit sources into the same module ([ARCHITECTURE.md](ARCHITECTURE.md#the-adapter-api)); the kit itself has no
framework code.

## Layout

| Path | What it is |
| --- | --- |
| `kit-apple/Package.swift` | The Swift package (`NativeScriptKit`), iOS 17 and later |
| `kit-apple/Sources/NativeScriptKit/` | Hand-written: signals and effect order (`Signals.swift`), template regions (`Regions.swift`), the template builder over core's classes (`CoreBridge.swift`), helpers templates call (`JS.swift`), uncaught-error policy, CSS `calc()` and `color-mix()`, app delegate and module registry |
| `kit-apple/Sources/NativeScriptKit/Runtime/` | Hand-written: the JavaScript runtime ([table below](#the-runtime-and-ecma-262)) |
| `kit-apple/Sources/NativeScriptKit/Core/` | Generated: core compiled to Swift, one file per core module, with the kit's index (`kit-index.json`) and the sources it was generated from |
| `kit-apple/Overlays/xml-free/` | Generated with `Core/`, and like it never committed (it names `Core/`'s files and module graph): core's Builder and Binding modules generated without the XML run time, compiled in their place by an app whose XML is built entirely at build time (`src/kit/overlay.ts`) |
| `kit-android/build.gradle.kts` | The Gradle project (`:kit`), over core's own `org.nativescript.widgets` library |
| `kit-android/src/main/kotlin/org/nativescript/kit/` | Hand-written: signals, change detection, uncaught-error policy, `color-mix()` |
| `kit-android/src/main/kotlin/org/nativescript/kit/runtime/` | Hand-written: the JavaScript runtime ([table below](#the-runtime-and-ecma-262)) |
| `kit-android/src/fromcore/kotlin/org/nativescript/kit/` | Hand-written, compiled over the generated classes: what compiled apps call (the template builder `CoreBridge.kt`, `Regions.kt`, `Modal.kt`, `AnimationFrame.kt`, the application class), as `CoreBridge.swift` and its neighbours are on iOS |
| `kit-android/generated/` | Generated: core compiled to Kotlin, and its line table (`source-lines.json`) |
| `kit-android/overlays/xml-free/` | As `kit-apple/Overlays/xml-free/`, for Android |

Translated code calls the runtime only through the operations of `src/semantics/runtime.ts`;
`tests/checks/runtime-ops.ts` checks that each one exists in its kit ([ARCHITECTURE.md](ARCHITECTURE.md#the-runtime-table)).

## The runtime and ECMA-262

Each row pairs the Swift and Kotlin files that implement the same behaviour. Clause numbers are ECMA-262 2025 (the 16th
edition). Rows without a clause implement another specification (ECMA-402, the web platform) or NativeScript's own
behaviour. `tests/checks/docs.ts` fails when a runtime file has no row.

| Swift (`Runtime/`) | Kotlin (`runtime/`) | What it implements | Specification |
| --- | --- | --- | --- |
| `Values.swift` | `Values.kt` | The value model: `undefined` and `null`, `JSObject`, `typeof`, `instanceof`, `+`, loose and strict equality, relational comparison, ToPrimitive, ToNumber, ToString | 6.1 ECMAScript Language Types; 7.1 Type Conversion; 7.2 Testing and Comparison Operations; 13.8–13.11 |
| `Dynamic.swift` | `Dynamic.kt`, `Language.kt` | Operations on untyped values: property get and set by key, `in`, `delete`, `Object.defineProperty`, descriptors, `freeze` and `seal`, `Object.assign`, spread and rest, tagged template objects | 10.1 Ordinary Object Internal Methods; 20.1 Object Objects; 13.2.8 Template Literals; 13.5.1 The `delete` Operator |
| `Record.swift` | — (in `Collections.kt`) | A plain object used as a dictionary, with JavaScript's key order (integer keys ascending, then insertion) | 10.1.11 [[OwnPropertyKeys]]; 20.1 Object Objects |
| `Prototypes.swift` | `Prototypes.kt` | `Class.prototype` objects for kit classes: added properties, accessors, the prototype chain | 10.1 Ordinary Object Internal Methods; 20.2.3 Properties of the Function Prototype Object |
| `Functions.swift` | — (in `Dynamic.kt`) | Function values with `name`, `length`, own properties and identity; `call` and `apply` | 10.2 ECMAScript Function Objects; 20.2 Function Objects |
| `BuiltinValues.swift` | — (in `Dynamic.kt`) | `instanceof` against a built-in class held as a value | 13.10.2 InstanceofOperator |
| `Symbol.swift` | — (in `Language.kt`) | Symbols, symbol property keys, `Symbol.toPrimitive` and `Symbol.toStringTag` | 20.4 Symbol Objects; 7.1.1 ToPrimitive |
| `Errors.swift` | `Errors.kt`, `ThrownValue.kt` | The `Error` classes, `throw` of any value, V8's messages for a member read of `undefined` and a call of a non-function | 20.5 Error Objects; 14.15 The `try` Statement |
| `Stack.swift` | — (in `Errors.kt`) | RangeError for recursion deeper than the native stack allows | Implementation-defined (V8's RangeError) |
| `NativeStack.swift` | `ErrorOrigin.kt` | `error.stack` from native frames | Not in ECMA-262 (V8's `stack`) |
| `Number.swift` | `Number.kt`, `ShortestDouble.kt` | Number to string (shortest round-trip digits), `toFixed`, `toPrecision`, `toExponential`, radix conversion, `parseInt`, `parseFloat`, ToInt32 and ToUint32, `%` | 6.1.6.1 The Number Type; 21.1 Number Objects; 19.2.4–19.2.5 `parseFloat`, `parseInt` |
| `BigInt.swift` | `BigInt.kt` | `BigInt` values and their operators | 6.1.6.2 The BigInt Type; 21.2 BigInt Objects |
| `Lowering.swift` | `Lowering.kt`, `Strings.kt` | String and Math members whose JavaScript behaviour differs from the platform's (`Math.round`, `imul`, `clz32`, `fround`, `hypot`, `padStart`, `split`, `slice`, `trim`, `localeCompare`), update expressions, stack-safe async loops | 21.3 The Math Object; 22.1 String Objects; 15.8 Async Function Definitions |
| `StringUTF16.swift` | — (in `Strings.kt`) | Strings by UTF-16 code unit: indexing, slicing, comparing, building a string from code units | 6.1.4 The String Type; 22.1 String Objects |
| `Array.swift` | `Array.kt` | `Array` as a reference (`JSArray`) with JavaScript's methods, holes and `length` | 23.1 Array Objects |
| `ArrayLike.swift` | `ArrayLike.kt` | `Array.prototype`'s methods called on a value that is no array (`Array.prototype.map.call(arrayLike, f)`): over its `length` and index keys, as the specification's algorithms read them | 23.1.3 Properties of the Array Prototype Object |
| `ES2023.swift` | `ES2023.kt` | `toSpliced` and `with` (the other change-array-by-copy methods are in `Array.swift`), `Object.groupBy` and `Map.groupBy`, `Promise.withResolvers` | 23.1 Array Objects; 20.1 Object Objects; 24.1 Map Objects; 27.2 Promise Objects |
| `TypedArrays.swift` | `TypedArrays.kt` | `ArrayBuffer`, the typed arrays and `DataView`, as byte storage native code can read | 23.2 TypedArray Objects; 25.1 ArrayBuffer Objects; 25.3 DataView Objects |
| `Collections.swift` | `Collections.kt` | `Map` and `Set`: insertion order, SameValueZero keys, iteration that sees changes made during it | 24.1 Map Objects; 24.2 Set Objects |
| `Weak.swift` | `Weak.kt`, `Language.kt` | `WeakMap`, `WeakSet`, `WeakRef` | 24.3 WeakMap Objects; 24.4 WeakSet Objects; 26.1 WeakRef Objects |
| `Iterators.swift` | `Iterators.kt` | The iterator protocol, generators and async generators lowered to continuations, async iteration | 7.4 Operations on Iterator Objects; 27.1 Iteration; 27.5 Generator Objects; 27.6 AsyncGenerator Objects |
| `Promise.swift` | `Promise.kt` | Promises and the microtask queue, in V8's job order; unhandled rejections | 27.2 Promise Objects; 9.5 Jobs and Host Operations to Enqueue Jobs |
| `JSON.swift` | `JSON.kt` | `JSON.parse` with a reviver, `JSON.stringify`, V8's error messages | 25.5 The JSON Object |
| `RegExp.swift`, `RegExpEngine.swift` | `RegExp.kt` | `RegExp` with its own parser and backtracking matcher, flags including `u`, `v`, `y`, `d`; String's `match`, `matchAll`, `replace`, `search`, `split` | 22.2 RegExp (Regular Expression) Objects; B.1.2 Regular Expressions Patterns |
| `Date.swift` | `Date.kt` | Time values, local and UTC fields, parsing and formatting | 21.4 Date Objects |
| `URI.swift` | `URI.kt` | `encodeURI`, `encodeURIComponent`, `decodeURI`, `decodeURIComponent` | 19.2.6 URI Handling Functions |
| `Intl.swift` | `Intl.kt` | `Intl.NumberFormat`, `Intl.DateTimeFormat`, `toLocaleString` and friends: en-US from CLDR data as ICU applies it, other locales through the platform | ECMA-402 |
| `Timers.swift` | `Timers.kt` | `setTimeout`, `setInterval`, `setImmediate` in Node's order, with a microtask checkpoint after each callback | HTML timers |
| `Inspect.swift` | `Inspect.kt` | `console` and Node's `util.inspect` formatting | WHATWG Console |
| `WinterTC.swift` | `WinterTC.kt` | `atob`, `btoa`, `TextEncoder`, `TextDecoder`, `crypto`, `DOMException` | WinterTC (WHATWG Encoding, Web Crypto, WebIDL) |
| `Workers.swift` | `Workers.kt` | `Worker`, `postMessage`, `structuredClone`, `URL` | HTML Workers; WHATWG URL |
| `Realm.swift`, `Threads.swift` | `Realm.kt` | Main-thread script realm, native callbacks marshalled from other threads, and each worker's isolated realm | 9.3 Realms |
| `Reactive.swift` | `Reactive.kt` | Collections that notify the effects reading them when changed in place (a framework's deep reactivity) | NativeScript: signals |
| `Views.swift` | `Views.kt` | `jsView`: an object of one class standing for another, the view of an object as an interface's class | NativeScript: value model |
| `Native.swift` | — (in `Dynamic.kt`) | Untyped access to Objective-C or Java objects by name, CoreFoundation and CoreGraphics conveniences | NativeScript: platform interop |
| `Interop.swift` | — (in `Dynamic.kt`) | `interop.Reference`, an out-parameter cell | NativeScript: platform interop |
| — | `HostObjects.kt` | Objects a native plugin binding answers for, by `get`, `set` and `invoke` | NativeScript: plugin bindings |
| `AbsentModules.swift` | — | Stand-ins for core modules a compiled app does not load; reading the other platform's globals throws a ReferenceError | NativeScript: core |
| — | `CorePackages.kt` | The npm packages core imports, implemented in the kit (Swift's counterpart, `CorePackages.swift`, sits beside `Runtime/`) | NativeScript: core |
| — | `CSSCalc.kt` | CSS `calc()` as `@csstools/css-calc` folds it (Swift's `CSSCalc.swift` sits beside `Runtime/`) | CSS Values |

The two runtimes do not split their files the same way: Kotlin groups object operations, symbols and weak classes in
`Language.kt` and `Dynamic.kt`, where Swift has a file each.

## Core, generated

`tools/kit/generate.mts` (iOS) and `tools/kit/generate-android.mts` (Android) run this package's compiler over the
repository's `packages/core`, with `packages/types-ios` or `packages/types-android`, in library mode
(`src/swift/kit-gen.ts`, `src/kotlin/kit-gen.ts`). Each writes one file per core module, the module graph and exports an
app imports, and a manifest of the sources each file came from.

```bash
npx nx run compiler:kit           # builds core, then writes kit-apple/Sources/NativeScriptKit/Core
npx nx run compiler:kit-android   # writes kit-android/generated
```

- **Partial generation is gated.** The targets run the generators with `--partial`: a construct of core the compiler
  does not translate is left out and the rest written. `tools/kit/omissions.json` lists what may be left out, each
  with its owner and cause; generation fails on an omission it does not list, and on a listed one that no longer
  occurs. `--report` lists the omissions and writes nothing.
- **Stack size.** The translator recurses over the syntax tree, and core's deepest expressions exceed Node's default
  stack, so the targets run Node with `--stack-size=8000`.
- **The kit's index.** App builds read what the kit declares from `kit-index.json` rather than from its Swift.
  Generation writes it (`src/kit/manifest.ts`): the generated code's part as the translator emits each declaration,
  the hand-written runtime's read from its Swift (`src/kit/swift-declarations.ts`). An adapter's kit adds a fragment of
  its own (`ns-compiled-adapter kit-fragment`), and `src/kit/manifest.ts` refuses a fragment that changes a declaration
  the kit itself makes.
- **One core.** `src/driver/contract.ts` checks that the app's installed `@nativescript/core` is the release the kit was
  generated from: the kit is core's logic, and the native widgets it drives come from the app's core.
- **Packing.** A published `@nativescript/compiler` carries both kits generated from one core release, and has that
  release's version: each core release tag (`{version}-core`) publishes it
  (`.github/workflows/npm_release_compiler.yml`). `prepack` refuses to pack without both kits or with kits from
  different cores (`tests/kits-present.ts`, run as TypeScript: packing needs Node 23.6 or newer and git, as
  development does, while the packed compiler runs on Node 20.17).
- **CI** generates both kits from the branch's core and builds them (`.github/workflows/compiler.yml`, job `kit`).

Core is read as source and keeps no compiler-only behaviour. An app's patch-package patch of core is applied as kit
switches (`src/program/core-patches.ts`) or stops the build ([PACKAGE-TYPES.md](PACKAGE-TYPES.md#core-patches)).

## What generating core requires of the compiler

Core is written without `strictNullChecks`, so its types promise values that are often undefined. Generating it fixed
the rules below, which hold for every app and plugin as well:

- **Undefined stays undefined.** An array read untyped (`cache[key]`), an optional member, `a || b` of two missing
  objects, a registered property never set: each is held as undefined, never as its type's zero (an empty array,
  `false`, a fresh object). A zero makes wrong code run quietly (a cache miss read as a hit); undefined makes the
  same code work, or throw where JavaScript throws.
- **`this` is the receiver.** A function declaration that reads `this` (`function get() { return this[key]; }`, stored as
  an accessor) takes it from its caller, as any JavaScript function does.
- **What script hands native code is marshalled as the JavaScript runtime marshals it.** Plain objects become
  dictionaries, script functions become blocks and native blocks script functions, a `Date` becomes an `NSDate`, a
  number becomes a native enum.
- **Properties reach their accessors.** Every property class (`CssAnimationProperty` included) puts its accessor on the
  prototype, and a setter that only forwards (`set color(v) { this.style.color = v }`) passes on what script gave it,
  unconverted.
- **The JavaScript runtime's own behaviour exists natively:** microtasks drain after every batch of UIKit work,
  promises have `then`, `catch` and `finally` by name, and native properties UIKit forwards (`UITextView`'s input
  traits) are reached as a message send reaches them.
