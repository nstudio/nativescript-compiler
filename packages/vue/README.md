# @nstudio/nativescript-compiler-vue

The Vue adapter of [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), which turns a
NativeScript app into Swift and Kotlin with no JavaScript engine. An app written with Vue (nativescript-vue) needs it to
build with `--compiled`.

```bash
npm install --save-dev @nstudio/nativescript-compiler@9.2.0-alpha.9 @nstudio/nativescript-compiler-vue@9.2.0-alpha.9
ns run ios --compiled
ns run android --compiled
```

The adapter loads only into the compiler version it was released with (its `peerDependencies`); install the two at
the same version. A Vue app built without it stops with the `npm i` command to run.

Tested with: `nativescript-vue >=3.1.0 <4.0.0`.

Source and issues: https://github.com/nstudio/compiled-frameworks (`packages/vue`).
