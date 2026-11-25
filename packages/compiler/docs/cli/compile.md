# ns compile

### Description

Compiles a NativeScript application directly to native Swift (iOS) or Kotlin (Android) with no JavaScript runtime, using `@nstudio/nativescript-compiler`.

### Commands

Usage | Synopsis
---|---
Compile for iOS | `$ ns compile ios [--for-device] [--team-id <Team>] [--provision <Profile>] [--run]`
Compile for Android | `$ ns compile android [--aab] [--key-store-path <Path> ...] [--run]`
Verify compiled vs JS | `$ ns compile verify [ios] [--steps <verify.json>]`
Retrace crash logs | `$ ns compile retrace <target> [trace-file]`
Check setup | `$ ns compile doctor [platform] [--json]`
