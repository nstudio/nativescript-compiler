# @nstudio/nativescript-compiler

NativeScript CLI plugin (`ns compile`) and compiler targeting `@nativescript/core` — compiles a NativeScript app to
Swift for iOS and Kotlin for Android, so its release build runs with no JavaScript engine.

- **No JavaScript engine in the release.** The app's TypeScript and core are compiled to native source, linked with a
  runtime that keeps JavaScript's semantics, and built by Xcode and Gradle.
- **Output that traces to the source.** Each generated statement carries the TypeScript line it came from; release
  crash reports resolve to those lines.
- **A kit generated from core.** The native views, layout and CSS are `@nativescript/core`'s own code, compiled by this
  compiler, so they follow core release by release.

Compiled code behaves as the same code does in JavaScript, for code the type checker accepts and whose types are
honest; what it cannot translate stops the build at the construct, and what is known not to match yet is listed in
[docs/LIMITS.md](docs/LIMITS.md#other-known-divergences) and measured in [tests/test262/README.md](tests/test262/README.md#results).

Install this package as a NativeScript CLI extension (`ns extension install @nstudio/nativescript-compiler`) to enable
`ns compile ios`, `ns compile android`, `ns compile verify`, and `ns compile retrace` with no fork of `nativescript-cli`.
A plain XML and TypeScript app needs nothing else. An app written with a framework (Angular, Vue, Svelte, React, Solid,
Octane) also installs that framework's adapter, `@nstudio/nativescript-compiler-<framework>`, a package of its own built
against this one's adapter API and published on npm at this package's version.

## Install and use

```bash
ns extension install @nstudio/nativescript-compiler              # Node.js 20.17 or newer, NativeScript CLI 9.1+
npm install --save-dev @nstudio/nativescript-compiler-angular    # framework apps: install the matching adapter
ns compile ios                                                   # or android, verify, retrace
```

Framework adapters and plugin binding packages compile against `@nstudio/nativescript-compiler/adapter-api` and
`@nstudio/nativescript-compiler/binding-api`, the package's only API entries (types; `TranslatorView` is experimental).

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Start here: the rule, the pipeline, the source layout, the shared decision layer and its guards, the adapter API, values, how correctness is checked, what is not done yet |
| [docs/LIMITS.md](docs/LIMITS.md) | Every refusal (limits by design and gaps not yet translated) and every difference between the platforms, generated from the source |
| [docs/REFERENCE.md](docs/REFERENCE.md) | What compiles: the TypeScript and JavaScript supported, core's API, direct iOS and Android calls, CSS, source lines and stack traces, device builds |
| [docs/KIT.md](docs/KIT.md) | NativeScriptKit: its layout, the runtime mapped to ECMA-262, generating the kit from core |
| [docs/PACKAGE-TYPES.md](docs/PACKAGE-TYPES.md) | How each npm package and plugin is compiled, and the `release` options for those that need help |
| [docs/CLI.md](docs/CLI.md) | The NativeScript CLI integration: flags, configuration, environment variables, App_Resources, known limitations |
| [tests/README.md](tests/README.md) | Every test harness: command, CI job, cost; the diff cases' directives; the suite's current numbers |
| [tests/test262/README.md](tests/test262/README.md) | The test262 selection, how tests are adapted, and the results with their commit |
| [tests/diff/WTFJS.md](tests/diff/WTFJS.md) | The wtfjs examples and the diff cases that hold them |

## What is in this package

| Folder | What it is |
| --- | --- |
| `src/` | The compiler ([source layout](docs/ARCHITECTURE.md#source-layout)) |
| `kit-apple/` | NativeScriptKit for Apple platforms, the Swift package every compiled iOS app links |
| `kit-android/` | NativeScriptKit for Android, a Gradle project |
| `bin/` | `ns-compiled` (what the CLI runs), `ns-compiled-retrace` (release stack traces in source lines), `ns-compiled-verify` (a compiled release compared with its JavaScript release) and `ns-compiled-adapter` (a framework adapter's own build) |
| `verify/` | The UI driver `ns-compiled-verify` builds (an XCUITest project) |
| `tools/kit/` | Kit generation from core (`nx run compiler:kit`, `compiler:kit-android`) |
| `tools/native-table.ts` | How much of a framework's typings the iOS SDK tables map (`node tools/native-table.ts verify UIKit`) |
| `bench/` | Optional device and size measurements of compiled apps against their JavaScript builds (Python, macOS, Xcode; not run by CI) |
| `tests/` | The test harnesses ([tests/README.md](tests/README.md)) |
| `docs/` | The documents above |

## Develop

Node.js 23.6 or newer (the compiler runs its TypeScript sources directly), Xcode for iOS, a JDK for Android.

```bash
npx nx run compiler:deps       # the compiler's and the tests' dependencies
npx nx run compiler:kit        # generate the iOS kit from core (compiler:kit-android for Android)
npx nx run compiler:test       # the static checks, the front's unit tests and the differential tests
npx nx run compiler:typecheck  # src, the tests and the kit generators, strict; the public API's declarations
npx nx run compiler:build      # dist/, as packing builds it
npx nx run compiler:pack       # the npm tarball, kits included, in dist/packages
```

Compile an app with this checkout:

```bash
node packages/compiler/src/driver/cli.ts <app folder> --platform ios --out <folder> --build   # --help lists the options
```

Scripts are TypeScript wherever CI runs them (Node runs them as they are), bash for the few shell wrappers, and Python
only in `bench/`. The package keeps its own `package-lock.json` and installs apart from the workspace
(`compiler:deps`): it is published alone and resolves its own TypeScript. `tests/` has its own lock (the core and
typings the cases are typed against), and `tests/app` is a fixture app with its own.
