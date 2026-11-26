# Architecture

`ns compile` (`ns compile ios` / `ns compile android`, installed as a NativeScript CLI extension via
`ns extension install @nstudio/nativescript-compiler`) builds a NativeScript app as a native app with no JavaScript
engine. It is opt-in: standard `ns run` and `ns build` workflows are unaffected.

- **No JavaScript engine in the release.** The app's TypeScript and `@nativescript/core` are compiled to Swift (iOS)
  and Kotlin (Android). They link NativeScriptKit, a runtime that gives them JavaScript's value semantics, and call
  UIKit and the Android SDK directly.
- **The output traces to the TypeScript source.** Every generated file names the file it came from, every statement
  carries its source line, and release crash reports resolve to `.ts` lines ([REFERENCE.md](REFERENCE.md#source-lines-and-stack-traces)).
- **The kit is generated from core.** Core's own TypeScript is compiled by the same compiler, so the kit's views,
  layout, CSS and navigation are core's code and follow each core release without a port ([KIT.md](KIT.md)).

This document covers how the compiler is built, how its correctness is checked, and what is not done yet. Start here;
the other documents are listed in [DEVELOPMENT.md](../DEVELOPMENT.md#internal-documentation).

## The rule

Compiled code behaves as the same code does in JavaScript, quirks included, for code the type checker accepts and
whose types are honest: a value of another type reaching a typed slot through `any` can behave differently
([below](#how-correctness-is-checked)). What is known not to match yet is listed in
[LIMITS.md](LIMITS.md#other-known-divergences). Where the compiler cannot make code behave as JavaScript does, it stops
the build at the construct, with the file, line and a suggested rewrite. Refusals come in two classes, both in one
catalog (`src/semantics/refusals.ts`, listed in [LIMITS.md](LIMITS.md)):

- **limits**: JavaScript a compiled release cannot run by design, such as `Proxy`, `eval` or `new Function`, which need
  an engine at run time;
- **gaps**: code that runs as JavaScript and that the compiler does not translate yet. These are compiler bugs, and
  the build's report says so.

Where the two platforms answer a JavaScript question differently, the difference is a named entry of the ledger
(`src/semantics/ledger.ts`), not drift between two code paths ([below](#the-ledger)).

## Pipeline

```
app source (plain XML and TypeScript; or a framework's, through its adapter @nativescript/compiler-<framework>)
  │  framework apps: the adapter's front end lowers components with the framework's own compiler
  ▼
TypeScript classes + template trees (src/api/ir.ts); XML pages folded to TypeScript modules (src/xml/)
  │  one TypeScript program: app + plugins + @nativescript/core, checked as the app's own build checks it (src/program/)
  ▼
preflight (src/driver/preflight.ts): limits found before translation, with file:line and a rewrite
  ▼
shared front (src/semantics/, src/template/): every JavaScript-semantics decision, made once, as data
  ▼
backends (src/swift/, src/kotlin/): spell the front's decisions as Swift and Kotlin
  ▼
project generation (src/targets/): Xcode project (XcodeGen) or Gradle project, App_Resources, plugins' native code
  ▼
xcodebuild or Gradle, linking NativeScriptKit (kit-apple/, kit-android/)
```

`src/driver/compile.ts` runs the whole build as one function, `compile(options)`; `src/driver/cli.ts` is its command
line. `src/program/build-context.ts` holds what one build knows beyond its inputs (the adapter, plugin stand-ins,
bundler defines, refusals), so two builds in one process share no state.

## Source layout

| Folder of `src/` | What it holds |
| --- | --- |
| `api/` | The package's public contracts: the framework adapter API (`adapter-api.ts`), the plugin binding API (`binding-api.ts`), the template tree (`ir.ts`), the core elements (`elements.ts`) |
| `adapters/` | Finding and loading the app's framework adapter (`load.ts`), recognising an app's framework without loading code (`framework.ts`), the compiler's own release vocabulary merged with the adapter's hooks (`hooks.ts`) |
| `driver/` | `compile()`, the command line, the toolchain and version checks (`toolchain.ts`, `contract.ts`), preflight, the unimplemented-property check |
| `program/` | The TypeScript program, reachability (`reach.ts`), module order, platform folding, core's property registry and extension patterns, core patches, source lines |
| `xml/` | Plain XML apps: each page parsed by core's own parser and folded into a TypeScript module at build time |
| `css/` | The app's CSS through its own bundler's pipeline, as its JavaScript build ships it |
| `semantics/` | The shared front: JavaScript semantics decided once for both backends ([below](#one-decision-two-spellings)); how a value is held (`semantics/states/`: `value-states.ts` and its answers by concern), forms (`semantics/forms/`), the language's corners as the checker types them (`semantics/lang/`, re-exported by `lang.ts`), object shapes (`shapes.ts` and its `shape-*.ts`, `result-shapes.ts`) |
| `template/` | The template render plan both backends spell (`plan.ts`) |
| `swift/`, `kotlin/` | The backends: a `Translator` each (`translator.ts`, its types in `translator-types.ts`, its mixins in order in `install.ts`) with per-concern modules (listed after this table), SDK binding (`native/`), template rendering (`render.ts`), kit generation (`kit-gen.ts`) |
| `kit/` | The kit's index and manifest, the XML-free overlay, core as the kit generators read it |
| `plugins/` | Plugins compiled from their source: finding and verifying the source, their native code, binding packages |
| `targets/` | The generated projects: `ios/` (XcodeGen, plists, signing, pods and packages, retrace) and `android/` (Gradle, resources, R8 mapping) |
| `tools/` | The `ns-compiled-retrace` and `ns-compiled-verify` tools |

Each backend's per-concern modules, by family (the same file name in both does the same job): statements
(`statements.ts`, `declarations.ts`, `loops.ts`, `control-flow.ts`, `expression-statements.ts`); expressions
(`expressions.ts`, `names.ts`, `narrowing.ts`, `optional-chains.ts`, `checked.ts`, `access.ts`); calls
(`calls.ts`, `arguments.ts`, `prototype-calls.ts`, `global-calls.ts`, `static-calls.ts`); operators (`operators.ts`,
`assignment.ts`, `construction.ts`, `literals.ts`, `type-tests.ts`, `key-plans.ts`); classes (`classes.ts`,
`mixins.ts`, and a class declaration's emitter in `class-declaration.ts`, whose steps over one record of the class
are in `class-fields.ts`, `class-constructor.ts`, `class-accessors.ts` and `class-methods.ts`); types (`types.ts`,
`type-facts.ts`, and `state-backend.ts`, the backend's answers to the front's value states); conversion, placement,
functions, modules, components and builtins. Swift adds `availability.ts`, `casts.ts`, `from-any.ts`,
`object-classes.ts`, `lenient.ts`, `protocols.ts`, `enums.ts`, `parameters.ts`, `results.ts`, `generics.ts`,
`method-values.ts` and `members.ts`; Kotlin adds `untyped-values.ts`.
In `swift/native/`, `sdk.ts` reads the iOS SDK's tables (`sdk-types.ts`), built from its symbol graphs by
`sdk-tables.ts`.

`tests/checks/layers.ts` holds the layering: `semantics/` imports no backend, driver or target; `swift/` and `kotlin/`
never import each other, directly or through other modules; `api/` imports nothing outside `api/`; no value imports
form a cycle; and `semantics/`, `swift/` and `kotlin/` keep no mutable state at module level, so a translation's state
is its translator's.

## One decision, two spellings

The design: every question whose answer is JavaScript semantics is answered once, in the shared front, from the
TypeScript program, and a backend asks and spells the answer (its syntax, its runtime's function names, its type names,
its platform APIs). Where the platforms really differ, the difference is a ledger entry.

Decided once today: whole-program facts, native types, value states and conversion plans, the class, shape and render
plans, and the library and runtime tables. Expression- and statement-level translation still decides much per
backend, from the type names it spells, and moves into the front piece by piece
([What is not done yet](#what-is-not-done-yet)).

### What the front holds

- **`ProgramFacts`** (`semantics/facts.ts`): whole-program answers, computed once per program, set of translated files
  and translation scope, and shared by every translator of that program: classes and their bases, override families,
  non-virtual methods, function-object fields, `arguments` readers, assigned and definite fields, the keys
  prototypes are given. A backend never caches a whole-program answer of its own.
- **`TranslatorConfig`** (`semantics/config.ts`): everything a translator is given, at construction: mode, plugin files,
  ledger, the adapter's hooks, where lines and errors go. A translator holds its config and its emission state only.
- **`NativeType`** (`semantics/types.ts`): how a value is held natively, as data: its kind, type arguments and empty
  states. `nativeTypeOf` maps a TypeScript type to it once; library types come from one table (`LIBRARY_TYPES`). The
  front tests types with predicates (`isUntyped` and others), never by their spelling. Each backend spells a
  `NativeType` through its pure `Spelling`, and names what only it knows (platform classes, shapes) through its
  `TypeView`.
- **Value states and conversion**: `semantics/forms/` decides, by one program-wide flow over every place a value is
  put, which empty states (`null`, `undefined`) each slot can hold; `semantics/states/` answers the translators'
  questions about a declaration or a read from those forms (`ValueStates`); `semantics/conversion.ts` plans what
  happens when a value moves from one slot to another, and `semantics/placement.ts` applies the plan where a read
  enters its slot. `plan()` returns a conversion `Plan`: the step, whether it can throw, whether the value must be
  bound first, or the refusal.
- **Plans as data** for the larger constructs: `ClassPlan` (`semantics/class-plan.ts`: base, constructor, parameter
  properties, the `super(…)` call, inherited members, accessor pairs, own `toString`/`valueOf`/`toJSON`), `ShapePlan`
  (`semantics/shapes.ts`: the keys an object literal's or interface's class has, in JavaScript's order, and the state of
  each), the template `RenderPlan` (`template/plan.ts`:
  views, bindings, listeners, regions and their order under the framework's behaviour), and the operator plans
  (`semantics/apis/operators.ts`, `semantics/apis/bigint.ts`).
- **Front methods** (`semantics/translator-methods.ts`, `semantics/type-methods.ts`): the front's answers both
  translators install on their prototypes, for questions asked through `this` (by the value-state rules, and by
  adapters through the adapter API).
- **Other shared analyses:** which functions can throw (`throws.ts`), `async` functions and generators lowered to
  continuations over spec-ordered promises (`async.ts`), untyped arrays converted where they meet typed slots
  (`sharing.ts`), module-level names (`top-names.ts`), signals as a framework declares them (`signals.ts`).

### The API family tables

`semantics/apis/` has one table per family of library functions: string, array, number, math, JSON, console, object,
promise, Map and Set, date, RegExp, BigInt, the statics, the global functions. Each entry (`ApiEntry` in
`semantics/apis/api.ts`) says how many arguments the function reads, whether it may throw, what it returns (as
`typeof` names it), and the operation each backend spells (`op`). Where both kits implement the member as one runtime
function, the entry names it (`runtime`), and the front spells the call for both (`runtimeCall`). A member a family's
table lacks is refused alike on both backends. `tests/semantics/apis.test.ts` holds every entry to what Node answers
(`tests/semantics/js-answers.json`).

### The runtime table

`semantics/runtime.ts` lists every runtime function translated code calls, as a `RuntimeOp` with its name in each kit:
the same name where both kits use one (`SHARED`), a mapped name where they differ (`RENAMED`), and the functions only
one kit has (`SWIFT_ONLY`, `KOTLIN_ONLY`). A backend spells a call through its column (`RT` in its `syntax.ts`), never by
writing the name. `tests/checks/runtime-ops.ts` fails when an operation names a function its kit does not declare,
and when any text in `src/` spells such a call by hand, so a misspelt helper fails a test instead of `swiftc` or
`kotlinc`.

### The ledger

`semantics/ledger.ts` is one typed object per backend (`SWIFT_LEDGER`, `KOTLIN_LEDGER`). Each field is a named
difference with a doc comment giving its reason and the cases that show it, and a kind (`LEDGER_KINDS`):

- **platform**: the platforms differ (reference counting against a tracing collector, reified generics against
  erasure, Swift strings against UTF-16), and the entry stays;
- **gap**: one backend does not give the JavaScript answer yet, or the two need a larger change to become one, and the
  entry goes when they do.

The front may branch on a backend only through a ledger field. Refusals that one backend gives and the other never does
are listed in `ONE_BACKEND_REFUSALS`, each with the field that explains it. [LIMITS.md](LIMITS.md#the-ledger) lists
every entry, generated from the file.

### What stays per backend

Syntax and printing, type names, runtime function names (as a column of the runtime table), SDK binding (Objective-C
symbol tables on iOS, class files on Android: `swift/native/`, `kotlin/native/`), template spelling, project
generation and the kit generators. The emitted code is still text: each translator records facts about the code it
wrote (whether it is pure, whether it throws) in its own `CodeMarks` (`semantics/marks.ts`), keyed by the code's text.

## Guards

The decision layer is held in place by checks in `.github/workflows/compiler.yml`, which runs on pushes to `main` and
on pull requests that touch the compiler, core or the platform typings (commands and costs in
[tests/README.md](../tests/README.md#what-runs-where)):

| Check | What it fails on | CI job |
| --- | --- | --- |
| `tests/checks/layers.ts` | A layering violation (above), a backend's name tested in `semantics/` outside the ledger, module-level mutable state not listed in its `MODULE_STATE` with a reason | `host` |
| `tests/checks/twins.ts` | A rise in what both backends still define twice (same-name functions, identical bodies, decision-only twins, shared lines), against the limits in `tests/checks/twins.json`, or a fall not yet recorded there (`--write` lowers a limit, never raises one); `--list` names them. The decision-twin count is a lower bound: a function returning code is not counted as a decision | `host` |
| `tests/checks/both-backends.ts` | A diff case on one backend that does not name the ledger entry or refusal keeping it off the other; a one-backend refusal `ONE_BACKEND_REFUSALS` does not list; an API table entry a backend does not spell | `host` |
| `tests/checks/decision-parity.ts` | Two different answers from the front to the same question about the same node, on the two backends, not explained by a ledger field (traced with `NS_DECISION_TRACE`, `semantics/decision-trace.ts`) | `ios` (a per-merge set of cases); every case in `compiler-nightly.yml` |
| `tests/checks/runtime-ops.ts` | A runtime operation its kit does not declare, or a runtime call spelled by hand | `host` |
| `tests/semantics/` (`node --test`) | An API table entry that disagrees with Node; the class and template plans | `host` |
| `tests/checks/determinism.ts` | A case that translates differently alone than inside the suite | `host` (Kotlin), `ios` (Swift) |
| `tests/checks/api-consumer.ts` | Public declarations a strict consumer cannot compile against, or an import of the package's internals that resolves | `host` |
| `tests/checks/docs.ts` | A stale generated table in the docs, a broken link or path, a kit runtime file missing from [KIT.md](KIT.md#the-runtime-and-ecma-262) | `host` |

## The adapter API

`src/api/adapter-api.ts` is the whole contract between the compiler and a framework, versioned by
`ADAPTER_API_VERSION`. An adapter's entry exports `adapter(core: CoreApi): FrameworkAdapter`. It imports only types from
the compiler: the package's only API entries are `@nativescript/compiler/adapter-api` and
`@nativescript/compiler/binding-api` (beside its `package.json`), as declarations built from `src/api/` (`bin/build-dist.mjs`). At run time an adapter gets everything it
calls, TypeScript included, from the `CoreApi` it is given, so it works on the compiler's own syntax trees and checker.
An adapter gives:

- **`FrameworkAdapter`**: the framework's name and packages; `reach` (the modules the entry reaches); `frontEnd(app)`,
  which returns a `FrontEndResult` (components as `ir.ts` trees, modules in initializer order, virtual sources, the root
  component, entry code per backend).
- **`TemplateBehaviour`**: how the framework's templates render and update, as data. The compiler has one render model
  (views made once, each binding an effect that sets one property, each `if`/`for` owning a region), and the behaviour
  parameterizes it: when updates apply (`schedule`), what runs around an event handler (`eventScope`), props before or
  after children (`propsOrder`), when a view joins the tree (`insertion`), bindings re-read on each check
  (`checkEveryBinding`), keyed rows read as signals (`rowSignals`), fragments. Its `kit` (`TemplateKit`) names, by role,
  the functions templates call that the adapter's kit declares.
- **`TranslatorHooks`**, one per backend: a `FrameworkModel` of data (signal types and the functions that make them,
  type mappings, decorators, a throws model), then functions where data cannot say it (`globalCall`, `methodCall`,
  `newCall`, `componentField`, `wrapRootView`, `classExtras`, …). A hook sees the translator only through
  `TranslatorView` (`SwiftTranslatorView`, `KotlinTranslatorView`), which is experimental: it gives and takes code and
  types as strings, and will change before 1.0.
- **`ModuleRules`**: declarations read in place of a package's (`shims`), specifiers that resolve to a port the adapter
  ships (`substitutions`), component file extensions.
- **Runtime and kit sources**: `runtimeRoots` are TypeScript ports the adapter ships, compiled strict; `kit`
  (`AdapterKit`) names Swift and Kotlin folders compiled into the kit's own module for an app of that framework.
- **`refusals`**: the adapter's own refusals by id, reported as the compiler's are.

**Finding the adapter** (`src/adapters/load.ts`). An adapter's `package.json` declares, under
`nativescript.compilerAdapter`, the API version it is written for, how an app of its framework is recognised without
loading its code (`detect`), and the framework versions it is tested with (`testedVersions`, which
`src/driver/contract.ts` checks). Adapters are found first in the subfolders of `$NS_COMPILER_ADAPTERS` (adapter sources
in development), then among the `@nativescript/compiler-*` packages the app's `package.json` lists. Only the app's
framework's adapter is loaded, after its API version, compiler range and TypeScript version are checked; a plain XML app
loads none. A framework app without its adapter stops with the package to install and the command.

The adapters for Angular, Vue, Svelte, React, Solid and Octane are separate packages
(`@nativescript/compiler-<framework>`, published on npm at this package's version), not part of this one. Their source is
in the nstudio/compiled-frameworks repository, which is not public yet, with their own tests run on this package's
harness (`tests/suite.ts`, `$NS_TEST_SUITE`). The API
was shaped by those adapters, so it is experimental until one is reviewed with it. This package's own tests use an
adapter of a framework that exists only in the tests (`tests/adapters/`), which exercises the API without them.

## The kit

NativeScriptKit has a hand-written runtime with JavaScript's semantics and `@nativescript/core` compiled by this
compiler. [KIT.md](KIT.md) describes its layout, maps each runtime file to the ECMA-262 clauses it implements, and
describes how core is generated.

## Values

A JavaScript value is held natively by what the program shows it can be:

| TypeScript value | Held as (Swift / Kotlin) |
| --- | --- |
| `number`, `string`, `boolean` | `Double` / `String` / `Bool`, optional when the program can leave it empty |
| a value that can be both `null` and `undefined` | `JSNullish<T>` (the two stay apart, as in JavaScript) |
| an object literal or an interface | a generated final class with stored fields, with by-name access for keys added at run time |
| a class | a native class, with fields, accessors, `super` and statics |
| an array | `JSArray<T>`: a reference, so aliasing, `splice` and identity behave as in JavaScript |
| a function | a closure, or a function object where JavaScript identity matters |
| `any`, or a value the checker cannot type | `Any?`, read and written through the runtime's dynamic operations |

A JavaScript object has one native object, so `===`, `WeakMap` keys and mutation through an alias hold. A typed array
held where an untyped one is declared is the array itself: Kotlin's `JSArray` is erased, and Swift's kit holds the
untyped view of it (`jsUntypedArray`), which keeps no elements of its own and stands for the typed array wherever
identity is compared; so does an array held as an array of what its elements also are (`number[][]` as `any[][]`,
`Dog[]` as `Animal[]`: `jsArrayView`). A value a typed array cannot hold, written through such a view, is kept as
JavaScript keeps it where the array can hold it (ledger `genericsReified`). Converting between representations does not allocate a second object, except where an untyped
array meets a typed slot and is no array of that type: both runtimes then copy it, and the compiler refuses the code
where it can see the copy would be observed (`shared-copy`, `shared-typed-copy` in [LIMITS.md](LIMITS.md)).

A TypeScript type is trusted only where TypeScript proves it (`semantics/trust.ts`). Without `strictNullChecks` a
declared `T` may still be `null` or `undefined`, and `@nativescript/core`, most plugins and many apps are written that
way. Each file is translated at one of these levels, which the translator derives from its configuration (`lenient`,
`lenientApp`, library mode) and `strictFile` in `semantics/trust.ts`:

| Level | What it is |
| --- | --- |
| `strict` | an app's files under a strict tsconfig |
| `lenient-app` | a non-strict app's own files: the program is checked again as that app's build checks it, and the value-state rules decide which typed slots can be empty |
| `lenient` | plugin files not written strict (on Kotlin, every plugin file: ledger `pluginsWrittenStrict`), and core during kit generation: object-typed declarations are held optional |
| `library` | the kit (orthogonal to the three above) |

Missing values stay `undefined` and are not read as a type's zero. Where the front cannot rule out an empty value, the
compiled code throws JavaScript's `TypeError` where JavaScript would.

## What the compiler needs from `@nativescript/core`

The compiler reads core as source, and core keeps no compiler-only behaviour. What the compiler needs from core is of
three kinds, each an ordinary core change:

1. **Types that say what runs**: a resolver that can return `null`, a parent that is a `ViewBase`.
2. **Sources in TypeScript**: `fetch` and `easysax`, converted from vendored JS to strict TypeScript with zero behavior
   change. (The compiler ships its own TypeScript binding-expression parser under `tools/kit/sources/`.)
3. **Opt-in hooks**: `registerPageFactory` and `registerCompiledBinding`. They do nothing unless a compiled build
   registers them, which never happens under V8 or JavaScriptCore.

A behaviour an app needs that core would not accept becomes a kit patch or overlay (`src/program/core-patches.ts`,
`src/kit/overlay.ts`), never a compiler-only edit to core.

## How correctness is checked

The JavaScript build is the reference for every layer. Counts are not given here: each harness generates or prints its
own, as linked.

| Layer | What runs | Compared against | Results |
| --- | --- | --- | --- |
| Differential cases (`tests/diff`) | each case compiled to Swift (a macOS executable) and Kotlin (on the JVM), and run | Node's output and exit status for the same TypeScript | [tests/README.md](../tests/README.md#the-suite-today) |
| Type-violation fuzzing (`tests/fuzz`) | each case's typed values replaced by values the types rule out, through `any` | Node's output for the same variant | `tests/fuzz/known-fuzz-failures.json` |
| test262 (`tests/test262`) | a selection of tc39/test262, adapted mechanically to typed modules | the spec's assertions | [tests/test262/README.md](../tests/test262/README.md#results), with its commit |
| wtfjs (`tests/diff`, `// wtfjs:` lines) | the wtfjs examples inside diff cases | Node | [tests/diff/WTFJS.md](../tests/diff/WTFJS.md) |
| The front's tables (`tests/semantics`) | each API table entry | Node's `length`, `typeof` and throwing | `tests/semantics/js-answers.json` |
| Release checks (`tests/release-checks`) | the CLI paths: config, resources, signing, plugins, patches | expected projects | |
| The adapter API (`tests/adapters`) | an app of a test-only framework, translated to Swift and Kotlin | the API's contract | |

Diff cases and a per-merge subset of the fuzz variants run in `compiler.yml`; test262, the full fuzz set and decision
parity over every case run nightly (`compiler-nightly.yml`). Real apps, including the
framework adapters' own, are built outside this repository and compared screenshot by screenshot against their own
JavaScript release builds (`src/tools/verify.ts`).

Two caveats bound these results. JavaScript's semantics hold where the static types are honest: fuzzing shows that a
value of the wrong type reaching a typed slot through `any` can behave differently from Node. And test262 measures
untyped JavaScript, so many of its tests are rejected by the type check, which a typed app's code would pass.

## What the generated code looks like

Calls to native APIs are plain Swift and Kotlin, typed values use typed operations, and the generated core reads as
hand-written classes (`open class Label: TextBase`, a typed `switch` for a string `switch`); TypeScript doc comments are
carried over.

```swift
let iq: IQKeyboardManager = IQKeyboardManager.shared
iq.isEnabled = true
iq.resignOnTouchOutside = true
```

Where a value is untyped (`any`, framework glue, values from untyped plugins), the output spells out JavaScript's
semantics: dynamic reads (`jsGet`), `Any?`, guards that throw a `TypeError` where JavaScript would, and the text
`"undefined"` where JavaScript would print it. That is the faithful translation, and it shrinks as types become
precise.

## What is not done yet

The front decides what [One decision, two spellings](#one-decision-two-spellings) lists. Each backend still decides
much of the expression- and statement-level translation from the type names it spells: method dispatch, casts, which
members are read by name, which conditions are decided at build time.

What both backends still define twice is counted by `node tests/checks/twins.ts` against `tests/checks/twins.json`,
whose limits may only fall, and `--list` names each pair. Its decision-twin count is a lower bound: it counts a pair as
a decision only where both functions return a boolean, a number, a set, a map or a TypeScript node and spell no code,
so a decision whose function returns code is not seen. Pairs known to answer one question by two rules are ledger gap
entries until they become one (`untypedCastsStrictOnly`, `expandoDeclaredOnly`, `staticTypeofConditions`).

The work left, in order:

- **Expression- and statement-level decisions into the front.** The backends take `NativeType` instead of spelled type
  names; facts about emitted code travel on the values a producer returns instead of being keyed by the code's text
  (`CodeMarks`), and helper names are no longer recognised in emitted text; the twins measure sees functions returning
  code. This is the precondition for a backend-neutral lowered representation that each backend only prints.
- **The class emitters' remaining phases.** `ClassPlan` decides the base, constructor, parameter properties, `super`
  call, inherited members and accessors for both; the fields and statics phases are still dispatched by each emitter,
  and where a static initializer runs is still decided per backend.
- **The ledger's gap entries reconciled** to the JavaScript answer, each closing with a diff case on both backends
  ([LIMITS.md](LIMITS.md#gap-entries)).
- **A typed adapter view.** `TranslatorView` passes code and types as strings and is experimental.

Known gaps that users meet are the refusals of class `gap` and the known failures (both in [LIMITS.md](LIMITS.md)), and
the limitations of the CLI integration ([CLI.md](CLI.md#known-limitations)).

### Future work

These are measured opportunities, not commitments.

- **Typed member access in core's hot paths.** Core's property system reads and writes view members by name
  (`Property` descriptors, `CssState.setPropertyValues`, `ViewBase.eachChild`) where TypeScript knows the member. Direct
  member access would remove most of the dynamic lookups measured during launch.
- **Lazy module statics.** Module-level bindings with provably pure initializers could become lazily initialized
  statics, keeping side-effecting statements in order.
- **Smaller apps that never parse XML at run time.** The XML builder, the binding-expression parser and `easysax` are
  reachable from core's `Builder` references in `view-common`, `frame-common` and `list-view`; making those indirect
  would let reachability leave them out.
- **Kotlin output.** Plain interfaces become dynamic view classes; R8 keeps every class; overrides of Kotlin-compiled
  supertypes lose their parameter names (the names exist only in `kotlin.Metadata`).
- **Swift output.** `as!` in `init(jsObject:)`, where JavaScript gives a `TypeError`; files named apart by underscores,
  where Kotlin prefixes the package.

## Related work, and why Swift and Kotlin source

Other projects compile JavaScript or TypeScript ahead of time:

- **Static Hermes** compiles typed JavaScript to native code inside the Hermes runtime.
- **Bun's AOT compiler** generates machine code from whole-program analysis and keeps Bun's runtime services.
- **ScriptC** (Vercel Labs) compiles TypeScript through LLVM to executables, or to static libraries for iOS and
  Android called through a C ABI.

They answer how to run JavaScript or TypeScript logic without a JIT. `ns compile` turns a whole NativeScript app into
a native app with no JavaScript engine: its UI framework, its views and layout through `@nativescript/core`, its plugins
and its direct calls into UIKit and the Android SDK. Most of such an app's code is UI, framework glue and platform calls,
so the compiler emits Swift and Kotlin source rather than machine code:

- it calls platform APIs directly, with no C ABI or JNI hop; Kotlin runs on ART next to the Android SDK;
- it goes through each platform's own toolchain: Xcode and Gradle optimization, signing, store builds, crash
  symbolication;
- it is readable and debuggable, and every line maps back to the TypeScript it came from.

The semantics bar differs too: `ns compile` holds compiled code to what the same code does in JavaScript, checked
against Node, where the compilers above document subsets or behaviours that differ from JavaScript.

## Reading the code

An order that builds the picture quickly (paths under `packages/compiler/`):

1. `src/driver/compile.ts`: the whole build as `compile(options)`, handing the program to `src/targets/ios/build.ts` or
   `src/targets/android/build.ts`.
2. `src/program/program.ts`: one TypeScript program for app, plugins and core, checked as the app's own build checks
   it.
3. `src/api/ir.ts` and `src/api/adapter-api.ts`: what a framework's front end hands the compiler, and the contract an
   adapter is written against.
4. `src/semantics/facts.ts`, `src/semantics/types.ts`, `src/semantics/ledger.ts`: whole-program answers, native types,
   and the named differences between backends.
5. `src/semantics/states/value-states.ts` (its answers in the mixins beside it), `src/semantics/forms/forms.ts`,
   `src/semantics/conversion.ts`, `src/semantics/placement.ts`: how a value is held and what happens when it moves
   between slots.
6. `src/semantics/apis/` and `src/semantics/runtime.ts`: the library tables and the runtime operations.
7. `src/swift/translator.ts` and `src/kotlin/translator.ts` with the `install.ts` beside each (the mixins it is made
   of, in order), then `statements.ts`, `expressions.ts` and `calls.ts` in each backend and the modules of their
   families ([Source layout](#source-layout)).
8. `kit-apple/Sources/NativeScriptKit/Runtime/Values.swift` and `Runtime/Array.swift`: the value model;
   `kit-apple/Sources/NativeScriptKit/Signals.swift`: the reactivity.
9. `src/swift/kit-gen.ts`: how `@nativescript/core` becomes the kit.
10. `tests/diff/run.ts` and a few `tests/diff/cases/`: the harness that checks the claims above.
