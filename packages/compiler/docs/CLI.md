# The NativeScript CLI plugin (`ns compile`)

Develop as usual with `ns run` and `ns debug` (JavaScript runtime, HMR). For a compiled native release with no JavaScript
runtime, install `@nstudio/nativescript-compiler` as a NativeScript CLI extension — no fork of `nativescript-cli` is
required — and run `ns compile`.

## Install and use

```sh
ns extension install @nstudio/nativescript-compiler

# Plain XML + TypeScript apps need nothing else.
# Framework apps also install their framework adapter as a project devDependency:
npm install --save-dev @nstudio/nativescript-compiler-angular   # or -vue, -svelte, -react, -solid, -octane

ns compile ios                                    # simulator .app (Swift)
ns compile ios --for-device --team-id <TEAM>      # signed device archive and .ipa
ns compile ios --run                              # build, install, and launch on simulator/device
ns compile android                                # release APK (Kotlin; debug-signed if no keystore)
ns compile android --aab --key-store-path release.keystore --key-store-password … \
  --key-store-alias … --key-store-alias-password …    # signed Play Store bundle + APK
ns compile android --run                          # build, install, and launch on emulator/device
ns compile verify                                 # compare compiled vs JavaScript release on simulator
ns compile retrace platforms/compiled/ios crash.ips   # symbolicate crash report to TypeScript lines
```

If a project also pins `@nstudio/nativescript-compiler` in its own `devDependencies` (matching its `@nativescript/core`
version), `ns compile` automatically delegates to the project-local compiler; otherwise it runs the extension's own copy.

## Project configuration (`nativescript.config.ts`)

`release` (top-level, with `ios.release` and `android.release` merged over it) holds the compiler's per-project options.
Import `'@nstudio/nativescript-compiler/config'` in `nativescript.config.ts` to augment `NativeScriptConfig` and `IConfigPlatform` with types for `release`:

```ts
import { NativeScriptConfig } from '@nativescript/core';
import '@nstudio/nativescript-compiler/config';

export default {
  id: 'org.example.app',
  release: {
    pluginSources: { 'some-plugin': '../some-plugin' },
  },
} as NativeScriptConfig;
```

| Option | What it does |
| --- | --- |
| `pluginSources`, `pluginReplacements`, `stubPlugins` | How a package is compiled ([PACKAGE-TYPES.md](https://github.com/NativeScript/NativeScript/blob/main/packages/compiler/docs/PACKAGE-TYPES.md)) |
| `allowUnimplementedProperties` | Build, with warnings, when the app sets a property core declares that the kit does not apply (otherwise the build stops with the view, property and file:line) |
| `allowCoreMismatch` | Build, with a warning, when the app's `@nativescript/core` is not the release the kit was generated from |
| `allowUntestedFrameworks` | Build when the app's framework packages are outside the versions its adapter is tested with |

## How the CLI extension works

`@nstudio/nativescript-compiler` is a standard NativeScript CLI extension (`keywords: ["nativescript:extension"]`) declaring
lazy-loaded `nativescript.commands` in `package.json`:

| Command | Module | What it does |
| --- | --- | --- |
| `ns compile ios` | `dist/cli/commands/compile-ios.cjs` | Generates `platforms/compiled/ios`, runs `xcodebuild` (simulator `.app` or device `.xcarchive`/`.ipa`), optional `--copy-to` and `--run` |
| `ns compile android` | `dist/cli/commands/compile-android.cjs` | Generates `platforms/compiled/android`, runs Gradle `:assembleRelease` / `:bundleRelease`, optional `--copy-to` and `--run` |
| `ns compile verify` | `dist/cli/commands/compile-verify.cjs` | Builds JavaScript + compiled releases and runs `ns-compiled-verify` visual & crash comparison |
| `ns compile retrace` | `dist/cli/commands/compile-retrace.cjs` | Runs `ns-compiled-retrace` for iOS/Android crash symbolication, R8 mapping composition, and Kotlin build-log mapping |
| `ns compile doctor` | `dist/cli/commands/compile-doctor.cjs` | Checks toolchains, kits, `@nativescript/core` parity, framework adapters, and plugins before compiling |

Nothing from the extension is loaded when running normal `ns` commands (`ns run`, `ns debug`, `ns build`); each command
module is loaded lazily only when invoked. Command help is registered under `docs/cli/` so `ns help compile` and
`ns help compile ios` work natively.

Outputs stay under `platforms/compiled/<platform>`, so `platforms/ios` and `platforms/android` are never touched, and
`ns run` / `ns debug` continue to work unchanged. The app identifier is the project's own, so a compiled release replaces
the JavaScript build on a device.

The package's `bin/ns-compiled.js` runs `dist/driver/cli.js` when packed (`bin/build-dist.mjs`), supporting Node 20.17
and later; a checkout without `dist/` runs `src/driver/cli.ts` via Node 23.6+ type stripping. `ns-compiled --help` lists
every option; `compile()` in `src/driver/compile.ts` is the same build as a function.

Before compiling, the compiler checks the following, and stops with the file and line, or the version and what to do:

- the toolchain (`src/driver/toolchain.ts`): Xcode 26 or newer for iOS; JDK 17 or newer and the Android SDK for
  Android;
- the framework adapter (`src/adapters/load.ts`): a framework app needs `@nstudio/nativescript-compiler-<framework>` at the
  compiler's version, listed in its `package.json` and installed; the error names the command to run;
- the version contract (`src/driver/contract.ts`): the app's `@nativescript/core` against the core the kit was generated
  from, and the app's framework packages against the ranges its adapter declares under
  `nativescript.compilerAdapter.testedVersions`;
- the limits preflight finds (`src/driver/preflight.ts`), each with a rewrite; every refusal is listed in
  [LIMITS.md](https://github.com/NativeScript/NativeScript/blob/main/packages/compiler/docs/LIMITS.md).

## Environment

| Variable | What it changes |
| --- | --- |
| `NS_COMPILED_CACHE` | The compiler's cache folder (plugins' sources, their Android libraries, the SDK's tables, ktfmt); default `nativescript/compiled` in `$XDG_CACHE_HOME`, else `~/.cache` |
| `NS_COMPILER_ADAPTERS` | A folder of framework adapters and plugin binding packages, found before the app's dependencies (adapter development) |
| `NS_XCODEGEN` | The XcodeGen to run, in place of the one on `PATH` or the pinned download |
| `NS_COMPILED_TABLE_CACHE` | Where the SDK's native tables are cached, in place of the cache folder's `native-tables` |
| `NS_COMPILED_STACKS` | Errors print with their stack (for reporting a compiler bug) |
| `NS_COMPILED_DIAGNOSTICS` | How many type errors the build lists before stopping (default 12) |
| `NS_XML_PLAN`, `NS_XML_TREE_DUMP`, `NS_COMPILED_DEBUG_VERIFY` | Debug output: an XML app's page plan written to that file, both XML trees printed at run time, a plugin's source mismatches as JSON |
| `NS_DECISION_TRACE` | The shared front records each question it answers, for `tests/checks/decision-parity.ts`; unset in a build |
| `NS_COMPILED_COMPONENT_CSS` | Set by the compiler for its CSS worker (components' stylesheets); not for users |

## App_Resources

The generated projects carry `App_Resources` and the app's settings as the CLI carries them into `platforms/ios` and
`platforms/android` (`src/targets/resources.ts`, `src/targets/ios/plist.ts`), so the CLI has nothing to add.

| Resource | In the compiled build |
| --- | --- |
| iOS `Info.plist` | Merged as the CLI merges it: each production plugin's `platforms/ios/Info.plist`, then the app's, then `CFBundleIdentifier` from the build setting; Xcode adds its build keys; the version and build number are the app's |
| iOS `app.entitlements` | The plugins', then the app's, merged; `CODE_SIGN_ENTITLEMENTS` unless `build.xcconfig` sets it |
| iOS `build.xcconfig` | The app's, then each plugin's (a key already set wins unless it inherits), as the app target's configuration file; a deployment target below the kit's iOS 17 is raised to it, and the build says so |
| iOS `Assets.xcassets`, `LaunchScreen.storyboard`, `PrivacyInfo.xcprivacy`, `.lproj` folders, other files | Resources of the app target |
| `App_Resources/iOS/src` | Swift and Metal compiled into the app target, with a symbol table of its declarations, so TypeScript calls it through the `.d.ts` the app's tsconfig includes (`Greeter.greetingWithName('x')` becomes `Greeter.greeting(name: "x")`); Swift that needs the JavaScript runtime's code is left out with a message |
| `App_Resources/iOS/extensions/<name>` | An app extension target per folder, as the CLI's extension service adds it: `<app id>.<name>`, its `Info.plist`, `extension.json`'s frameworks and build settings, the packages that name it, the app's signing (its profile from the extensions folder's `provisioning.json` with `--provision`), embedded in `PlugIns/` |
| `App_Resources/iOS/Podfile`, plugins' `platforms/ios/Podfile` | One `Podfile` merged as the CLI merges it; the compile runs `pod install` and the project is built as the workspace |
| `ios.SPMPackages` (the app's and plugins' `nativescript.config.ts`) | Packages of the project, linked by the app and by the extensions their `targets` name |
| Android `AndroidManifest.xml` | The app's manifest with `__PACKAGE__` substituted and the runtime's activity as `MainActivity`; the runtime's application class and error activity left out; plugins' manifests merged by Gradle |
| Android `app.gradle`, `before-plugins.gradle` | Applied as the runtime's `build.gradle` applies them, so `versionCode`, `versionName`, the SDK levels and the rest of `defaultConfig` are the app's |
| Android `res/`, `java/`, `assets/` | Source directories of the Gradle project |
| Fonts in `<app>/fonts` | In the bundle (iOS) or as assets at `app/fonts` (Android), registered or loaded as core does |

## Known limitations

- **Simulator reinstall.** `simctl install` over an app with the same id merges bundles, so a compiled release installed
  over a JavaScript build keeps the JavaScript build's files in the bundle. `--clean` (which uninstalls first) avoids it.
- **Windows.** `kit-android` has no `gradlew.bat`.
- **Plugins** whose native code the build does not handle yet (a resource bundle, a `.framework`, native libraries)
  stop the build with the file ([PACKAGE-TYPES.md](https://github.com/NativeScript/NativeScript/blob/main/packages/compiler/docs/PACKAGE-TYPES.md#limits)).
