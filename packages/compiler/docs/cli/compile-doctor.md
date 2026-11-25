# ns compile doctor

### Description

Checks whether the current machine and NativeScript project are ready for native Swift/Kotlin compilation — verifying Xcode, JDK, Android SDK, generated kits, `@nativescript/core` version parity, framework adapter installation, and engine-bound/binary plugins.

### Commands

Usage | Synopsis
---|---
Check both platforms | `$ ns compile doctor`
Check one platform | `$ ns compile doctor ios`
JSON output for CI | `$ ns compile doctor --json`

### Options

* `--platform <Target>` - Limit checks to `ios`, `android`, or `both` (default: `both`).
* `--json` - Print the report as JSON for CI pipelines.
