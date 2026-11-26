# Reference

What the compiler accepts and how it maps it to native code. The app is type-checked as one program against the
ES2022 library, `@nativescript/core`'s own declarations and the platform's typings (`@nativescript/types-ios`,
`@nativescript/types-android`), so code type-checks as it does under `ns run`. What the compiler does not translate
stops the build with the file, line and construct; every refusal is listed in [LIMITS.md](LIMITS.md).

## JavaScript semantics

- **Values and operators.** Numbers are doubles and print as JavaScript prints them. Arrays, maps, sets, records and
  objects are references (`JSArray`, `JSMap`, `JSSet`, `JSRecord`, classes) with JavaScript's iteration order. `any` is
  `Any?`, read and written through the runtime's dynamic operations. `===`, `==`, `typeof`, truthiness, `+`, `%`, `**`,
  the bitwise operators (ToInt32 on doubles) and the comma operator are JavaScript's, as are `typeof` of a name only
  declared, labeled blocks, a `default` clause before cases, tagged templates and `String.raw`, and `BigInt`.
- **Built-in objects.** `JSON`, `RegExp` (the kit's own engine), `Date`, `Math`, string methods by UTF-16 code unit and
  `console`'s formatting are the kit runtime's; [KIT.md](KIT.md#the-runtime-and-ecma-262) maps each file to the
  ECMA-262 clauses it implements.
- **Reads of `undefined` and `null`.** Reading a member of `undefined` or `null` throws a `TypeError` a `catch` takes,
  where the types let the read through (`items[i].name` past the end, `x!.name`, an untyped value).
- **Objects.** Getters and setters in object literals (`this` is the object), computed keys, `Object.defineProperty`
  with property attributes, `getOwnPropertyNames`, `getOwnPropertyDescriptor`, `freeze`, `seal` and
  `preventExtensions` (writes to a frozen object throw in strict code), `fromEntries`, `is`. An object literal held
  untyped is a `JSObject`, which takes any key; its methods see it as `this`.
- **Symbols and weak collections.** `Symbol()` is `JSSymbol`, unique, with its `description`, `Symbol.for` and
  `keyFor`; as a property key it is left out of `Object.keys` and JSON. `Symbol.iterator`, `asyncIterator`,
  `toPrimitive` (with the hint each conversion passes) and `toStringTag` work on classes. `WeakMap`, `WeakSet` and
  `WeakRef` hold their keys weakly, by identity.
- **Iteration.** Generators and async generators compile to continuations as async functions do
  (`src/semantics/async.ts`): the body suspends at each `yield`; `next(v)`, `return(v)` and `throw(e)` resume it through
  its `catch` and `finally` blocks; `yield*` delegates; async generators queue requests and settle them in ECMA-262's
  order. `for…of`, spread and destructuring step an iterator through the iterator protocol and close it when a loop
  leaves early; `for await` takes async iterables and sync ones whose values it awaits.
- **Promises and async functions.** `JSPromise` follows ECMA-262 job for job, with a microtask queue drained after
  every event and on the main run loop. An async function runs synchronously to its first `await`; loops that await are
  trampolined; `try`, `catch`, `finally` and `switch` work across awaits. The order of `then`, `await` and timer
  callbacks is Node's, as the diff cases (`tests/diff`) check it.
- **Exceptions.** `throw` throws a `JSException` carrying the value. A Swift function is `throws` only if it throws or
  calls something that may (worked out across the call graph, `src/semantics/throws.ts`). What escapes an event
  handler or a binding is reported as NativeScript reports an uncaught error.
- **Classes and modules.** Fields initialize in JavaScript's order around `super()`; accessors, statics, abstract
  methods, interfaces that classes implement, `instanceof`, `toString` overrides, and closures with per-iteration loop
  bindings. A module's top-level statements run in import order from the entry point.
- **Locale formatting.** `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `Intl.NumberFormat` and
  `Intl.DateTimeFormat`: for en-US, from CLDR's data as ICU applies it, so each platform prints what Node prints, as the
  diff cases check it for the forms they use. Another locale goes to the platform's ICU (Foundation's formatters on
  iOS, `java.text` on Android) with the same options; its output is the platform's CLDR version's, which can differ from
  Node's.

## @nativescript/core

Core's classes are the kit's classes of the same name, generated from core ([KIT.md](KIT.md)). Members are checked
against the kit's index (`src/swift/core-api.ts`, `src/kotlin/core-api.ts`, `src/kit/kit-index.ts`). View properties
are applied by name (`label.text = …`), `view.ios` and `nativeView` are typed as the view's native class (`UILabel`,
`UIImageView`, …), and `loaded` fires as in core. Core's imperative UI API runs as core runs it: `view.animate()`,
`createAnimation()` and `new Animation(definitions, sequential).play()` and `cancel()`, `TouchManager`, RootLayout's
`open`, `close`, `closeAll` and `topmost`, `Frame.topmost().navigate({ create })`, and `view.showModal(view, options)`
and `closeModal(result)`.

A property core declares that the kit does not apply, set in a template, in CSS or in code, stops the compile with the
view, property and file:line (`src/driver/unimplemented.ts`); `--allow-unimplemented-properties` (or
`release.allowUnimplementedProperties`) builds anyway, with warnings.

## Direct iOS calls

`UIImage.systemImageNamed('star')`, `view.layer.cornerRadius = 8`, `UIViewContentMode.Center`, `CGSizeMake(0, 4)`: each
NativeScript name resolves to its Swift spelling through a table generated from the SDK's symbol graphs
(`src/swift/native/sdk.ts`, cached per framework in the compiler's cache), with numbers converted to the `CGFloat`, `Int`
or enum the Swift API takes, and blocks given Swift's parameter types (`src/swift/native/api.ts`). Classes extending
Objective-C classes (`@NativeClass() class Delegate extends NSObject implements UITextFieldDelegate`) get the Swift
signatures of the methods they override or implement; `ObjCExposedMethods` are `@objc` for target-action.
`node tools/native-table.ts verify UIKit` reports how much of a framework's typings the table maps; what it does not map
is mostly API Swift does not import (variadic methods, `NSZone`).

## Direct Android calls

`new android.content.Intent(android.content.Intent.ACTION_SEND)`, `paint.setStrokeWidth(4)`,
`android.view.View.VISIBLE`: typed by `@nativescript/types-android`, with signatures read from the class files
(android.jar, core's widgets AAR, androidx AARs; `src/kotlin/native/classfiles.ts`). Overloads resolve by argument types;
numbers convert to the `int`, `float` or `long` Java takes and back; JavaScript arrays become Java arrays; interfaces are
implemented from object literals (`new android.view.View.OnClickListener({ onClick… })`); and `@NativeClass()` classes
extending Java classes override with Java's signatures (`src/kotlin/native/api.ts`). `Base.extend({…})` and
`java.lang.Object.extend({ interfaces: […], … })` declare a Kotlin class where the variable holding them is
(`src/kotlin/native/extend.ts`); `this.super.m()` is the superclass's; varargs methods take their arguments one by one or
an array; `Array.create(type, n)` is a Java array a method can fill in. Extending a class made by `extend` stops the
build. A `Base.extend('a.b.Name', {…})` class takes its variable's name, not the Java name given.

## CSS

The CSS a compiled build uses is the CSS the app's JavaScript build ships. `src/css/worker.ts` runs in a process of its
own, started as the NativeScript CLI starts the bundler (the project as working directory, the CLI's environment and
`NATIVESCRIPT_BUNDLER_ENV`), and puts each stylesheet through the app's own pipeline: for a webpack app, the app's
`webpack.config.js` is resolved and the stylesheet's loaders, matched by webpack's rule compiler, run through
`css2json-loader` (`postcss-loader` with the app's PostCSS configuration, `@nativescript/tailwind` when it loads
automatically); for a Vite app, its Vite configuration is resolved for a production build and `app.css` takes
`@nativescript/vite`'s steps. The result is the rework-css syntax tree core reads, in the order core adds the sheets
(`app.css`, then the stylesheets modules import); the kit gets the rule sets, `@media` and `@keyframes` core keeps from
it (`src/css/css.ts`).

Tailwind v4 output works as NativeScript runs it: theme variables on `.ns-root, .ns-modal`,
`calc(var(--spacing) * n)`, variables set to `initial`, `color-mix()` evaluated as core's `@csstools/css-color-parser`
evaluates it (`kit-apple/Sources/NativeScriptKit/ColorMix.swift`, `ColorMix.kt`; `node tests/color-mix/run.ts` checks
random expressions against core's), and `.ns-dark` overrides.

## Templates and updates

Each binding is an effect that sets one property. The effects a write invalidates re-run in the order the app's
framework commits its bindings (`EffectOrder` in the kit's `Signals.swift` and `Signals.kt`), and run when the framework
updates (`TemplateBehaviour.schedule`). Both are declared by the framework's adapter; each adapter documents its
framework's order in its own package. A property change announces `<name>Change` on its view, as core's
properties do.

## Source lines and stack traces

Every translated statement carries the line it was written on. `--no-source-lines` leaves them out.

**iOS.** Each statement has a `#sourceLocation(file:line:)` directive, so crash reports, `fatalError`, Instruments and
Xcode's debugger show the `.ts`, `.vue`, `.tsx` or `.svelte` file and line. A release build's error frames read
`at <symbol> (<image>+0x<offset>)` (a store build has no symbol names: `at <compiled> (MyApp+0x3a8c70)`) in
`error.stack`, in the log, and in the fatal exception's reason under `uncaughtErrorPolicy: 'throw'`. The build's dSYM
resolves the app's frames, inlined functions included, with one `atos` run (`src/targets/ios/retrace.ts`). Give the
compiled iOS project (its Release build's dSYM), the `.app.dSYM` or the `.xcarchive`, and the trace or an `.ips` crash
report:

```bash
ns compile retrace platforms/compiled/ios < trace.txt
ns compile retrace MyApp.xcarchive MyApp-2026-11-12-101500.ips
```

```
Uncaught TypeError: Cannot read properties of undefined (reading 'name')
    at hostInitials(_:) (crash-demo.ts:7)
    at logMeetingHosts() (crash-demo.ts:18)
```

Keep each store build's `.xcarchive` (or its dSYM): a report resolves only with the build it came from, and an `.ips`
report whose image UUID is another build's is flagged.

**Android.** Kotlin has no such directive: the build writes `source-lines.json` beside the Gradle project, mapping each
Kotlin line to its source line. R8's `mapping.txt` undoes the release build's renaming, then the line table maps the
frames:

```bash
adb logcat -d -s System.err AndroidRuntime | ns compile retrace platforms/compiled/android
```

```
    at org.example.app.Crash_demoKt.hostInitials(crash-demo.ts:8)
    at org.example.app.Crash_demoKt.logMeetingHosts(crash-demo.ts:19)
    at org.nativescript.kit.JSArray.map(Array.kt:445)
```

Crash reporters read the mapping alone, so the release build composes the two (`src/targets/android/compose-mapping.ts`):
after R8, `mapping.txt` (in `platforms/compiled/android/build/outputs/mapping/release/`) names each app frame's `.ts`
file and line, and R8's own is kept beside it as `mapping-kotlin.txt`. The bundle carries the composed one, so Play
Console shows `.ts` lines with no upload, and the Crashlytics and Sentry Gradle plugins upload it as they upload any R8
mapping. A build made without it composes in place with `ns compile retrace --compose-mapping
platforms/compiled/android`. The mapping format holds one file per class: in a component made from two files (an
Angular `templateUrl`, an XML page and its code), frames in the other file's code, and frames in code the compiler
wrote, read no line; `ns compile retrace` names both. Errors JavaScript code can catch carry their JVM frames as
`error.stack`.

A component's virtual class is matched to its source file (`src/program/source-lines.ts`): script code by the
identifiers and literals it shares with the line it came from, a template binding by its expression.

## Device builds

`ns compile ios --for-device` archives for any iOS device (`xcodebuild archive`) and writes the `.ipa`: unsigned without
signing arguments; signed manually with `--provision <profile>` (a `.mobileprovision`, or the UUID or name of an
installed one; the export method follows the profile); or signed automatically for a team with `--team-id <team>`, which
lets Xcode create profiles and register the app id on that team (`--export-method`, `debugging` by default;
`src/targets/ios/signing.ts`). On Android, `ns compile android` writes the release APK and, with `--aab`, the bundle,
signed with `--key-store-path`, `--key-store-password`, `--key-store-alias` and `--key-store-alias-password` when they
are given, and with the debug key otherwise.

The generated Xcode project builds NativeScriptKit as a static library target with the app's settings (`-Osize`, full
LTO, dead-code stripping, and, for an app with no pods or Swift packages, virtual function and witness method
elimination over symbols internalized at the link; `src/targets/ios/build.ts`), so the link drops kit code the app never reaches. A framework the kit imports for code the
app never reaches (WebKit for `WebView`) is left out of the link, since a linked framework is loaded at launch.

## Usage

For everyday app builds, install the NativeScript CLI extension (`ns extension install @nstudio/nativescript-compiler`)
and run `ns compile ios` / `ns compile android` (see [CLI.md](CLI.md)).

### Run it from a checkout

```sh
cd packages/compiler && npm ci
node src/driver/cli.ts <app> --out <dir> --build                       # Swift, then xcodebuild for the simulator
node src/driver/cli.ts <app> --platform android --out <dir> --build    # Kotlin, then Gradle
node src/driver/cli.ts <app> --out <dir> --build --device --provision <profile>    # archive and .ipa
node src/driver/cli.ts --help                                           # every option
```

The app is an ordinary NativeScript project: `ns run` develops it with the JavaScript runtime as usual.
