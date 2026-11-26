# @triniwiz/compiled-nativescript-canvas

Native binding for [`@nativescript/canvas`](https://www.npmjs.com/package/@nativescript/canvas) with [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler).

Provides 2D, WebGL, and WebGPU canvas APIs directly over the native library in compiled apps (Swift on iOS, Kotlin/JNI on Android) without a JavaScript engine.

## Installation

```bash
npm install --save-dev @triniwiz/compiled-nativescript-canvas
```

## Usage

Once installed alongside `@nativescript/canvas`, build normally with the compiler:

```bash
ns compile ios
ns compile android
```

Android builds compile the JNI layer with the Android NDK.

## Supported Versions

- `@nativescript/canvas`: `^3.0.0-alpha.10`

## License

MIT
