# Developing `@nstudio/nativescript-compiler`

Internal architecture references, package layout, and local development commands for contributors. This file is not published to npm.

## Internal Documentation

| Document | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The rule, pipeline, source layout, shared decision layer and guards, adapter API, value model, correctness checks |
| [docs/LIMITS.md](docs/LIMITS.md) | Every refusal (limits by design and gaps not yet translated) and platform differences |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Supported TypeScript/JavaScript subset, core API, direct iOS/Android calls, CSS, source lines, device builds |
| [docs/KIT.md](docs/KIT.md) | NativeScriptKit layout, runtime mapped to ECMA-262, kit generation from `@nativescript/core` |
| [docs/PACKAGE-TYPES.md](docs/PACKAGE-TYPES.md) | How npm packages and plugins are compiled, plus `release` configuration options |
| [docs/CLI.md](docs/CLI.md) | NativeScript CLI integration: flags, configuration, environment variables, `App_Resources`, limitations |
| [tests/README.md](tests/README.md) | Test harnesses, CI jobs, diff directives, and current counts |
| [tests/test262/README.md](tests/test262/README.md) | Test262 selection, adaptation, and baseline results |
| [tests/diff/WTFJS.md](tests/diff/WTFJS.md) | WTFJS examples and corresponding differential cases |

## Package Layout

| Folder | What it is |
| --- | --- |
| `src/` | Compiler source ([source layout](docs/ARCHITECTURE.md#source-layout)) |
| `kit-apple/` | NativeScriptKit for Apple platforms (Swift package linked by compiled iOS apps) |
| `kit-android/` | NativeScriptKit for Android (Gradle library module) |
| `bin/` | CLI entrypoints (`ns-compiled`, `ns-compiled-doctor`, `ns-compiled-retrace`, `ns-compiled-verify`, `ns-compiled-adapter`) |
| `verify/` | XCUITest UI driver used by `ns-compiled-verify` |
| `tools/kit/` | Swift and Kotlin kit generators from `@nativescript/core` |
| `tools/native-table.ts` | Checks iOS SDK table coverage (`node tools/native-table.ts verify UIKit`) |
| `bench/` | Optional device and binary size benchmarks (macOS / Xcode; not run by CI) |
| `tests/` | Test harnesses ([tests/README.md](tests/README.md)) |
| `docs/` | Technical reference documents listed above |

## Local Development

Requires Node.js 23.6+ (runs TypeScript sources directly), Xcode for iOS, and a JDK + Android SDK for Android. Run from the repository root:

```bash
npm install                  # workspace dependencies
npm run typecheck            # typecheck compiler, tests, and all framework adapters
npm run test:compiler        # layer checks, CLI extension checks, expression parser parity
npm run kit                  # generate iOS NativeScriptKit from @nativescript/core
npm run kit:android          # generate Android NativeScriptKit from @nativescript/core
npm run build                # build dist/ and types for compiler and all adapters
```

Run release checks and differential tests:

```bash
node packages/compiler/tests/release-checks/run.ts
node packages/compiler/tests/diff/run.ts --swift
node packages/compiler/tests/diff/run.ts --kotlin
```

Compile an app directly from this checkout:

```bash
node packages/compiler/src/driver/cli.ts <app-dir> --platform ios --out <out-dir> --build
```
