# @nstudio/nativescript-compiler

NativeScript CLI extension (`ns compile`) that compiles NativeScript apps directly to native Swift (iOS) and Kotlin (Android) with no JavaScript runtime.

- **No JavaScript engine in release builds.** App TypeScript, npm dependencies, and `@nativescript/core` compile directly to Swift and Kotlin and are built with Xcode and Gradle.
- **Source-mapped crash traces.** Generated native code preserves TypeScript source lines so release stack traces resolve back to your app source via `ns compile retrace`.
- **NativeScriptKit built from `@nativescript/core`.** Views, layout, and CSS are compiled from `@nativescript/core` and linked natively.

## Requirements

- Node.js `>= 20.17.0`
- NativeScript CLI `>= 9.1.0`
- Xcode (for iOS builds) / JDK & Android SDK (for Android builds)

## Installation

Install as a NativeScript CLI extension:

```bash
ns extension install @nstudio/nativescript-compiler
```

Plain TypeScript/XML apps need no additional packages. For framework apps, also install the matching adapter as a dev dependency at the same version:

```bash
# Example for Angular:
npm install --save-dev @nstudio/nativescript-compiler-angular
```

## Usage

```bash
ns compile doctor            # verify toolchain, kit, adapter, and plugins
ns compile ios               # compile and build iOS app
ns compile android           # compile and build Android app
ns compile verify            # verify compiled output against JS release behavior
ns compile retrace           # symbolicate release crash logs back to TypeScript
```

Run `ns compile --help` (or `ns compile <command> --help`) for all flags and options.

## Framework Adapters

| Framework | Package |
| --- | --- |
| Angular (`@nativescript/angular`) | `@nstudio/nativescript-compiler-angular` |
| Vue (`nativescript-vue`) | `@nstudio/nativescript-compiler-vue` |
| Svelte (`@nativescript-community/svelte-native`) | `@nstudio/nativescript-compiler-svelte` |
| React (`react-nativescript`) | `@nstudio/nativescript-compiler-react` |
| Solid (`@nativescript-community/solid-js`) | `@nstudio/nativescript-compiler-solid` |
| Octane (`@nativescript-community/octane`) | `@nstudio/nativescript-compiler-octane` |

## Configuration

Optional compiler settings live under `release` in `nativescript.config.ts` (TypeScript types are exported from `@nstudio/nativescript-compiler/config`):

```ts
import { NativeScriptConfig } from '@nativescript/core';

export default {
  id: 'org.nativescript.app',
  appPath: 'src',
  appResourcesPath: 'App_Resources',
  release: {
    pluginReplacements: {},
    stubPlugins: [],
  },
} as NativeScriptConfig;
```

## License

MIT
