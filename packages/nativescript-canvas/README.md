# @triniwiz/compiled-nativescript-canvas

The [`@nativescript/canvas`](https://www.npmjs.com/package/@nativescript/canvas) binding of
[`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), which turns a NativeScript app into
Swift and Kotlin with no JavaScript engine. The plugin's native code installs its objects (`CanvasModule`: 2D, WebGL,
WebGPU) into the JavaScript engine; a compiled app has none, so this package gives the same objects over the plugin's
native library: Swift on iOS, Kotlin through a JNI layer on Android, where its script also replaces the plugin's.
An app using `@nativescript/canvas` needs it to build with `--compiled`.

```bash
npm install --save-dev @triniwiz/compiled-nativescript-canvas@9.2.0-alpha.9
ns run ios --compiled
ns run android --compiled
```

It binds `@nativescript/canvas ^3.0.0-alpha.10`, and declares so under `nativescript.compilerBinding` in its
package.json (the compiler's `src/api/binding-api.ts`). Android builds compile its JNI layer with the Android NDK.

Source and issues: https://github.com/nstudio/compiled-frameworks (`packages/nativescript-canvas`).
