# Packages and plugins

A compiled build has no JavaScript runtime: it compiles the app and every npm package the app reaches from TypeScript,
as one program with the app, and links each plugin's native code as the plugin ships it. Each package is one of the
kinds below, and `release` in `nativescript.config.ts` holds the options for those that need help.

| The package ships | The build | Option |
| --- | --- | --- |
| Its TypeScript (rxjs's `src/`) | compiles it as installed | — |
| JavaScript built from TypeScript in its repository | fetches the source at the published revision, checks that it compiles to the installed files, and compiles it | `pluginSources` |
| JavaScript only, or code that only means something in a JavaScript VM (`moment`, `stacktrace-js`) | stops, naming the package | `pluginReplacements` |
| Native code that installs objects into the JavaScript engine (V8 headers, `v8::` code) | builds over the plugin's binding package; stops, naming the plugin, when none is installed | a binding package |
| A closed binary with no TypeScript anywhere | stops, naming the package and both remedies | `pluginReplacements` or `stubPlugins` |

A package's Angular entry (`<package>/angular`) is compiled from its source like the rest of the package. When the app
uses components of that entry, they are compiled with the app's components and the entry keeps its declarations.

## Source

`src/plugins/source.ts` finds the commit a published version was built from (the `gitHead` npm recorded, else the
version's tag, else the commit that set the version, in the repository the package's `package.json` names, in its
`directory` when it names one). It clones it once into the compiler's cache (`plugins/<package>@<version>` under
`$NS_COMPILED_CACHE`, [CLI.md](CLI.md#environment)), maps each published JavaScript file to its TypeScript through the
package's source maps, and checks the source by transpiling it and comparing the result with the published JavaScript
(formatting, emit helpers and the `@NativeClass` lowering aside). A package whose source cannot be found or does not
match stops the build.

An ES module bundle (`fesm2022/*.mjs`) and a package that ships its TypeScript are not transpiled and compared; for
them the check is the installed file against its own source map. A map names positions only in the file it was written
with, so a mapped line the file lacks, or a column past its line's end, stops the build (`<package>: <file> is not the
file its source map describes`). An edit that leaves every mapped position inside its line, such as one changing a
string in place, is not detected; give such a package a source patch or a `pluginSources` checkout.

### `pluginSources`

`{ 'package': 'path' }`: a checkout of the package's TypeScript, used as it is instead of fetching the published
revision. Use it for a fork or a local tarball whose source is not public. It is not checked against the installed
files.

### Patches

The installed files are what `patch-package` patches; the compiled build never sees them. A source patch goes in
`compiled/patches/<package>+<version>.patch` (scoped names with `+` for `/`), with paths relative to the package's
directory or to its repository's root. When the installed files do not match their source and `patches/<package>+<version>.patch` exists, the error
says so.

### Core patches

The JavaScript build runs `@nativescript/core` as the app's patch-package patch leaves it
(`patches/@nativescript+core+<version>.patch`), so the compiled build must too. `src/program/core-patches.ts` recognizes
the hunks it knows, each as a kit switch where the kit has something to change (the iOS and Android lists differ: on iOS
box-shadow colors, insertion below a native view, clamped scroll offsets, gradient stops; on Android children clipped
only by `clipToBounds`, edge-to-edge refreshed, gradient stops). A hunk it does not recognize stops the build. The iOS
kit has no `CorePatches` switches yet, so an iOS build stops at a hunk that needs one, naming the patch.

## `pluginReplacements`

`{ 'package': './src/stand-in.ts' }`: every import of the package resolves to a TypeScript module of the app, which
exports what the app uses of the package, typed. The package's native code is not linked.

## `stubPlugins`

`['some-binary-plugin', ...]`: a binary-only plugin builds as a stand-in that does nothing. Its views are empty
`ContentView`s that keep their place in the layout (row, column, size, margins, classes); their content, items and
events are dropped, and every method does nothing. The build prints a warning naming each stubbed package. The
stand-ins come from a stubs package installed for the app, one whose `package.json` declares
`nativescript.compilerStubs` (`src/api/binding-api.ts`); naming a package none declares is an error.

## Binding packages

A plugin whose native code installs objects into the JavaScript engine has no engine to install them into in a
compiled app. A binding package stands in for that code: the same objects in Swift and Kotlin over the plugin's native
library, and on Android a script in place of the plugin's. It declares `nativescript.compilerBinding` in its
`package.json` (`src/api/binding-api.ts`): the plugin and versions it binds, and its sources per platform. Install it for
the app as a dev dependency; it applies when the app depends on the plugin it names.

## How plugin code compiles

- **Reachability** (`src/program/reach.ts`): only the modules and members the app reaches are translated, with the
  platform's constants folded, so the other platform's branches drop out; imports keep their evaluation order.
- **Core extension** (`src/program/patterns.ts`, `src/program/properties.ts`): `new Property({...})` and `CssProperty`
  registered on any class (core's `View` included) are properties by name, with `[prop.setNative]` replayed when a view
  sets up; `applyMixins(View, [Extended])` becomes an extension of the kit class; a property a plugin adds to a native
  object is kept with it. Any other change to core's prototypes stops the build with the file and line.
- **Untyped code.** Most plugins are written without `strictNullChecks`, and their files are translated at the
  `lenient` trust level ([ARCHITECTURE.md](ARCHITECTURE.md#values)); on iOS a plugin file written strict is trusted as
  strict code (ledger `pluginsWrittenStrict`). Objects held untyped are extensible `JSObject`s, their methods are
  reachable by name from untyped callers, and `NSDictionary` and `NSArray` answer as the JavaScript runtime marshals
  them.

## Native code

- **iOS** (`src/plugins/native-ios.ts`): `platforms/ios` is copied unchanged into `Plugins/` of the generated project.
  Objective-C and C are targets of a local Swift package (the module its `module.modulemap` declares, else
  `NSPlugin_<package>`), Swift is a static library target built with the app's settings, and an `.xcframework` is a
  binary target. Each module gets a symbol table as the SDK's frameworks do, so `GestureHandlerManager.alloc().init()`
  resolves to its Swift spelling. A member a Swift module isolates to the main actor is reached through
  `MainActor.assumeIsolated`: translated code runs on the main thread.
- **Swift packages and pods** (`src/targets/ios/dependencies.ts`): `ios.SPMPackages` in the app's and each production
  plugin's `nativescript.config.ts` are packages of the project, merged as the CLI merges them. Each plugin's
  `platforms/ios/Podfile` and the app's `App_Resources/iOS/Podfile` become one `Podfile`, as the CLI writes it. The
  modules they build get symbol tables, so `IQKeyboardManager.shared.isEnabled = true` resolves through the package's
  typings: the first compile builds them once for the simulator and extracts their symbol graphs, cached by a hash of
  the dependencies.
- **Android** (`src/plugins/native-android.ts`): `platforms/android` builds as the CLI builds it (Java and Kotlin sources,
  `res/` and the manifest) into an AAR per plugin, cached in the compiler's cache, with the AARs it ships and the
  dependencies, repositories and minimum SDK its `include.gradle` declares. The manifests merge into the app's, the
  AARs' classes join the class path direct calls resolve against, and R8 keeps the plugin packages that untyped code
  reaches by reflection. A plugin's replacement of a core method (`Page.prototype.createNativeView`) becomes a kit hook.

## Limits

These stop the build with the file and what is not supported:

- iOS: a `.framework` or a static library (an `.xcframework` is supported), a resource bundle, a `.podspec` (a Podfile
  is supported);
- Android: `assets/`, `jniLibs/`, `cpp/` or `.so` files in `platforms/android`; a `buildscript.gradle`,
  `rootbuildscript.gradle`, `include-settings.gradle` or `before-plugins.gradle`; anything in `include.gradle` beyond
  dependencies, repositories and the minimum SDK; CocoaPods do not apply.

Swift packages and pods are not compiled with the app's dead-code settings (a package target gets none of the
project's settings; pods are dynamic frameworks).
