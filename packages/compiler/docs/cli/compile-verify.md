# ns compile verify

### Description

Builds both the JavaScript release and the compiled native release, runs both through the same interaction steps on a simulator, and compares screenshots pixel by pixel.

### Commands

Usage | Synopsis
---|---
General | `$ ns compile verify [ios] [--steps <verify.json>] [--out <Dir>] [--js-app <App>] [--compiled-app <App>]`

### Options

* `--steps <Path>` - Path to a `verify.json` interaction script (defaults to `verify.json` in the project root if present).
* `--out <Dir>` - Directory for captured screenshots and diff report (defaults to `platforms/compiled/verify`).
* `--js-app <Path>` - Existing JavaScript release `.app` bundle to skip rebuilding the JS release.
* `--compiled-app <Path>` - Existing compiled release `.app` bundle to skip rebuilding the compiled release.
