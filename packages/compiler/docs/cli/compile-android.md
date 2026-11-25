# ns compile android

### Description

Compiles the NativeScript project to native Kotlin and builds an Android release `.apk` (or `.aab` with `--aab`) with no JavaScript runtime.

### Commands

Usage | Synopsis
---|---
General | `$ ns compile android [--aab] [--key-store-path <Path> --key-store-password <Pass> --key-store-alias <Alias> --key-store-alias-password <Pass>] [--run] [--prepare-only] [--clean] [--copy-to <Path>]`

### Options

* `--aab` - Builds an Android App Bundle (`.aab`) beside the release `.apk`.
* `--key-store-path <Path>` - Path to the Android release keystore file.
* `--key-store-password <Pass>` - Password for the Android release keystore.
* `--key-store-alias <Alias>` - Key alias inside the keystore.
* `--key-store-alias-password <Pass>` - Password for the key alias.
* `--run` - Installs and launches the compiled APK on a running emulator or connected Android device.
* `--device <Id>` - Target Android emulator or device identifier for `--run`.
* `--prepare-only` - Generates the native Kotlin/Gradle project under `platforms/compiled/android` without running Gradle.
* `--clean` - Removes previous build outputs under `platforms/compiled/android` before building.
* `--copy-to <Path>` - Copies the built `.apk` or `.aab` to the specified file or directory.
* `--out <Dir>` - Custom output directory (defaults to `platforms/compiled/android`).
* `--all-errors` - Reports every unsupported construct instead of stopping at the first.
* `--allow-unimplemented-properties` - Warns instead of stopping on core properties not applied by the kit.
* `--allow-core-mismatch` - Warns instead of stopping when `@nativescript/core` differs from the kit version.
* `--allow-untested-frameworks` - Warns instead of stopping when framework versions are outside the adapter range.
* `--skip-toolchain-check` - Skips JDK and Android SDK validation.
