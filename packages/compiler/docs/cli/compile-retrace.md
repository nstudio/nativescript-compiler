# ns compile retrace

### Description

Maps a compiled iOS or Android stack trace, crash report, or Kotlin build log back to the original TypeScript file and line numbers, or composes Android R8 `mapping.txt` for crash reporters.

### Commands

Usage | Synopsis
---|---
Symbolicate crash | `$ ns compile retrace <target> [trace.txt]`
Compose R8 mapping | `$ ns compile retrace --compose-mapping <android-project> [out.txt]`
Map Kotlin build log | `$ ns compile retrace --build-log <android-project> <log-file>`

### Options

* `--compose-mapping` - Composes R8 `mapping.txt` with `source-lines.json` so Crashlytics/Sentry show TypeScript source lines.
* `--build-log` - Rewrites Kotlin compiler errors in a Gradle build log to their TypeScript file and line.
