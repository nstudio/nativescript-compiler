# @nstudio/nativescript-compiler

Official nStudio NativeScript CLI plugin (`ns compile`) and framework adapters that compile NativeScript apps (TypeScript, `@nativescript/core`, framework templates, and plugins) directly to native **Swift** (iOS) and **Kotlin** (Android) — with **no JavaScript runtime** in the release binary.

[Packages](#packages) · [Quick Start](#quick-start-end-users) · [Speed & Footprint](#speed-and-footprint-compiled-vs-js-v8-release) · [Local Development](#local-development) · [Generating Kits](#generating-swift--kotlin-kits-from-nativescriptcore)

---

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

## Speed and footprint: Compiled vs JS (V8) Release

Measured in alternating 5-round A/B runs (`ns compile` vs `--release --no-compiled`, built from the same TypeScript benchmark app and `@nativescript/core`) on a fresh iPhone 17 Pro simulator (iOS 26.5) and Pixel 9 emulator (Android API 36, speed-compiled via `cmd package compile -m speed`). Numbers are medians across 5 alternating runs (simulator/emulator indications, not physical-device guarantees):

| Metric | iOS JS (V8) | iOS Compiled | iOS Delta | Android JS (V8) | Android Compiled | Android Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Release package size** | 55.9 MB `.app` *(32.9 MB Frameworks, 1.4 MB JS)* | **29.9 MB `.app`** *(0.2 MB Frameworks, 0 JS)* | **−47%** | 94.5 MB APK *(92.3 MB `libNativeScript.so`)* | **2.5 MB APK** *(0 `.so`, 0 JS)* | **−97% (38× smaller)** |
| **Cold launch** | 531 ms | **493 ms** | **−7%** | 230 ms | **187 ms** | **−19%** |
| **Memory at launch** | 41.0 MB Footprint | **19.0 MB Footprint** | **−54%** | 86.8 MB PSS | **79.5 MB PSS** | **−8%** |
| **Memory after workload** | 59.0 MB Footprint | **32.0 MB Footprint** | **−46%** | 204.6 MB PSS | **80.0 MB PSS** *(flat)* | **−61% (2.6× less)** |
| **Full CPU suite (`cpu-total`)** | 6,017 ms | **4,045 ms** | **1.49× faster** | 2,113 ms | 7,346 ms | 3.48× slower *(see below)* |
| **`class-methods`** | 78.88 ms | **0.80 ms** | **99× faster** | 3.16 ms | 3.45 ms | 1.09× |
| **`nbody`** | 109.46 ms | **8.32 ms** | **13.2× faster** | 2.57 ms | 4.91 ms | 1.91× |
| **`num-sort`** | 244.06 ms | **57.61 ms** | **4.2× faster** | 194.14 ms | 320.99 ms | 1.65× |
| **`virtual-calls` / `object-literal`** | 18.9 / 39.9 ms | **4.9 / 10.4 ms** | **3.9× / 3.8× faster** | 0.8 / 3.8 ms | 3.3 / 6.7 ms | 4.1× / 1.8× |
| **`list-open` (2,000 rows)** | 63.5 ms | 109.0 ms | 1.72× | 81.7 ms | **66.5 ms** | **−19% faster** |
| **`list-jank-pct`** | 0.28% | **0.00%** | **zero jank** | 0.00% | **0.00%** | parity |
| **`views-500-to-frame`** | 83.3 ms | 167.3 ms | 2.01× | 49.9 ms | **50.1 ms** | **parity** |
| **`nav-round-trip`** | 16.0 ms | 24.9 ms | 1.56× | 84.3 ms | **85.6 ms** | **parity** |
| **`json-parse` / `json-stringify`** | 3.8 / 1.9 ms | 12.9 / 11.4 ms | 3.4× / 5.9× | 3.4 / 1.3 ms | 6.1 / 11.1 ms | 1.8× / 8.9× |

**Recent iOS runtime optimizations (`-Osize -wmo` on 5-level `View`/`Label`/`Style` `Property.set` workloads):**
- `views-500-build-sim`: **87.53 ms → 40.25 ms** (**2.17× faster**, −54.0%)
- `relayout-200-sim`: **25.85 ms → 13.81 ms** (**1.87× faster**, −46.6%)

**Where compiled wins today:** dropping the JavaScript engine cuts package size dramatically (**2.5 MB vs 94.5 MB** universal Android APK; **29.9 MB vs 55.9 MB** iOS `.app`), cuts memory roughly in half on iOS and by **61%** under load on Android (80 MB flat vs 205 MB), speeds up cold launch on both platforms, and — because iOS forbids JIT — runs the full iOS compute suite **1.5× faster overall** (up to **99× faster** on typed class methods and **13× faster** on `nbody`, with **0.00%** list jank). On Android, UI benchmarks (`list-open`, `views-500-to-frame`, `nav-round-trip`) are at parity or faster.

**Where V8 is still faster (active optimization targets):**
- **iOS dynamic CSS-property reads:** building 500 views and 200-row relayouts (already cut by ~50% via per-class `jsClassShape`, `JSExpando.jsSymbolFieldsPlain`, cached `JSHolding.setter`, and 32-slot `jsRecentShapes`) still pay dynamic expando lookups where V8 uses inline caches. Generating typed slots for core's CSS properties is the next targeted optimization.
- **Android JIT-heavy pure JS microbenchmarks:** V8 on Android runs full TurboFan JIT, so tight numeric-array loops (`matmul` on boxed `JSArray<Double>` vs V8 unboxed double arrays) and repeated `+=` string concatenation loops favor V8 JIT today.
- **JSON (`json-parse`/`json-stringify`):** V8's C++ JSON engine is currently 2×–9× faster than the Swift/Kotlin runtime JSON helpers.

**Verification & correctness snapshot (Node is the oracle):**

| Suite | Swift (iOS) | Kotlin (Android) |
| --- | ---: | ---: |
| **Differential suite (990 cases)** | **924 / 979** match Node *(45 declared refusals, 10 known failures)* | **873 / 917** match Node *(39 declared refusals, 5 known failures)* |
| **Decision parity (shared front)** | **8,825,940** decisions across 48 cases — **0** answered differently | *(same)* |
| **Module layering & shared-front tests** | **303** modules, **0** cycles · **23 / 23** semantics tests · **85 / 85** expression-parser checks | *(same)* |

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
