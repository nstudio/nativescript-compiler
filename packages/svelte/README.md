# @nstudio/nativescript-compiler-svelte

The Svelte adapter of [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), which turns a
NativeScript app into Swift and Kotlin with no JavaScript engine. An app written with Svelte (@nativescript-community/svelte-native, Svelte 4 or 5) needs it to
build with `--compiled`.

```bash
npm install --save-dev @nstudio/nativescript-compiler@9.2.0-alpha.9 @nstudio/nativescript-compiler-svelte@9.2.0-alpha.9
ns run ios --compiled
ns run android --compiled
```

The adapter loads only into the compiler version it was released with (its `peerDependencies`); install the two at
the same version. A Svelte app built without it stops with the `npm i` command to run.

Tested with: `@nativescript-community/svelte-native >=1.0.0 <2.0.0 || >=5.0.0-alpha.0 <6.0.0`, `svelte >=4.2.0 <5.0.0 || >=5.50.0 <6.0.0`.

Source and issues: https://github.com/nstudio/compiled-frameworks (`packages/svelte`).
