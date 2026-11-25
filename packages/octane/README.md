# @nstudio/nativescript-compiler-octane

The Octane adapter of [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), which turns a
NativeScript app into Swift and Kotlin with no JavaScript engine. An app written with Octane (@nativescript-community/octane) needs it to
build with `--compiled`.

```bash
npm install --save-dev @nstudio/nativescript-compiler@9.2.0-alpha.9 @nstudio/nativescript-compiler-octane@9.2.0-alpha.9
ns run ios --compiled
ns run android --compiled
```

The adapter loads only into the compiler version it was released with (its `peerDependencies`); install the two at
the same version. An Octane app built without it stops with the `npm i` command to run.

Known break: Octane apps do not build on Android since the compiler's hand-ported Android kit was removed.

Tested with: `@nativescript-community/octane >=0.2.4 <0.3.0`.

Source and issues: https://github.com/nstudio/compiled-frameworks (`packages/octane`).
