# ns compile ios

### Description

Compiles the NativeScript project to native Swift and builds an iOS release `.app` (simulator) or `.xcarchive` / `.ipa` (device) with no JavaScript runtime.

### Commands

Usage | Synopsis
---|---
General | `$ ns compile ios [--for-device] [--team-id <Team>] [--provision <Profile>] [--export-method <Method>] [--run] [--prepare-only] [--clean] [--copy-to <Path>]`

### Options

* `--for-device` - Builds an iOS device archive (`.xcarchive`) and exports an `.ipa`.
* `--team-id <Team>` - Automatic code signing team ID for `--for-device`.
* `--provision <Profile>` - Provisioning profile UUID or name for manual signing with `--for-device`.
* `--export-method <Method>` - Export method with `--team-id` (`debugging`, `release-testing`, `app-store-connect`, `enterprise`).
* `--run` - Installs and launches the compiled app on a booted iOS Simulator or connected device after building.
* `--device <Id>` - Target simulator or device identifier for `--run`.
* `--prepare-only` - Generates the native Swift/Xcode project under `platforms/compiled/ios` without running `xcodebuild`.
* `--clean` - Removes previous build outputs under `platforms/compiled/ios` before building.
* `--copy-to <Path>` - Copies the built `.app` or `.ipa` to the specified file or directory.
* `--out <Dir>` - Custom output directory (defaults to `platforms/compiled/ios`).
* `--all-errors` - Reports every unsupported construct instead of stopping at the first.
* `--allow-unimplemented-properties` - Warns instead of stopping on core properties not applied by the kit.
* `--allow-core-mismatch` - Warns instead of stopping when `@nativescript/core` differs from the kit version.
* `--allow-untested-frameworks` - Warns instead of stopping when framework versions are outside the adapter range.
* `--skip-toolchain-check` - Skips Xcode version validation.
* `--whole-kit` - Compiles every file of NativeScriptKit instead of closed-world tree-shaking.

### Platform Notes

* `new Worker(...)` background threads are currently supported in compiled Android builds (`ns compile android`) and refused at compile time on iOS (`worker` refusal); guard worker usage behind `if (__ANDROID__)` or use async/Promise concurrency for cross-platform builds.
