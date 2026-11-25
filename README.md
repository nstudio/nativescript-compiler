# @nstudio/nativescript-compiler

Official nStudio NativeScript CLI plugin (`ns compile`) and framework adapters that compile NativeScript apps (TypeScript, `@nativescript/core`, framework templates, and plugins) directly to native **Swift** (iOS) and **Kotlin** (Android) — with **no JavaScript runtime** in the release binary.

## Packages

| Package | Path | Description |
| --- | --- | --- |
| `@nstudio/nativescript-compiler` | `packages/compiler` | CLI extension (`ns compile ios\|android\|verify\|retrace\|doctor`), Swift/Kotlin compiler, runtime kits, and public APIs (`adapter-api`, `binding-api`, `config`) |
| `@nstudio/nativescript-compiler-angular` | `packages/angular` | Angular 22 adapter (templates, signals, DI, routing, forms) |
| `@nstudio/nativescript-compiler-vue` | `packages/vue` | Vue 3 SFC adapter (`<script setup>`, reactivity, slots) |
| `@nstudio/nativescript-compiler-svelte` | `packages/svelte` | Svelte 4 & Svelte 5 runes adapter |
| `@nstudio/nativescript-compiler-react` | `packages/react` | React TSX adapter (hooks, reconciler) |
| `@nstudio/nativescript-compiler-solid` | `packages/solid` | Solid JSX adapter (signals, effects, control flow) |
| `@nstudio/nativescript-compiler-octane` | `packages/octane` | Octane adapter |
| `@nstudio/nativescript-compiler-stubs-nativescript-ui` | `packages/stubs-nativescript-ui` | Optional no-op stand-ins for closed-source `nativescript-ui-*` plugins (`private`) |
| `@triniwiz/compiled-nativescript-canvas` | `packages/nativescript-canvas` | Native Swift & Kotlin/JNI binding package for `@nativescript/canvas` (`private`) |

## Quick Start (End Users)

```sh
# 1. Install the NativeScript CLI extension (requires nativescript CLI >= 9.1.3 / PR #6215)
ns extension install @nstudio/nativescript-compiler@alpha

# 2. (Framework apps only) Install the matching adapter in your project
npm install --save-dev @nstudio/nativescript-compiler-angular@alpha

# 3. Check environment, kits, core version, and plugins
ns compile doctor

# 4. Build and run native Swift (iOS) or Kotlin (Android) releases
ns compile ios --run
ns compile android --run
```

For `nativescript.config.ts` autocompletion on `release`, `ios.release`, and `android.release`:

```ts
import { NativeScriptConfig } from '@nativescript/core';
import '@nstudio/nativescript-compiler/config';
```

## Local Development

```sh
npm install
npm run typecheck
npm run test:compiler
```

### Generating Swift & Kotlin Kits from `@nativescript/core`

Point `NS_CORE_REPO` at a built checkout of `NativeScript/NativeScript` (or keep it side-by-side at `../../NativeScript/NativeScript`):

```sh
NS_CORE_REPO=/path/to/NativeScript npm run kit
NS_CORE_REPO=/path/to/NativeScript npm run kit:android
```

### Packing & Publishing (npm OIDC Trusted Publishing)

- Sync versions across all packages: `npm run version:sync -- 9.2.0-alpha.10`
- Pack locally: `npm run pack`
- Publish via GitHub Actions: run **Actions → Publish to npm (OIDC)** (`.github/workflows/publish.yml`).
  Configure each package on npmjs.com under **Settings → Trusted Publisher → GitHub Actions**:
  - Owner: `nstudio`
  - Repository: `nativescript-compiler`
  - Workflow filename: `publish.yml`
  - Environment: `npm-publish`
