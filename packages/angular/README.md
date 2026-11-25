# @nstudio/nativescript-compiler-angular

The Angular adapter of [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), which turns a
NativeScript app into Swift and Kotlin with no JavaScript engine. An app written with Angular (@nativescript/angular) needs it to
build with `--compiled`.

```bash
npm install --save-dev @nstudio/nativescript-compiler@9.2.0-alpha.9 @nstudio/nativescript-compiler-angular@9.2.0-alpha.9
ns run ios --compiled
ns run android --compiled
```

The adapter loads only into the compiler version it was released with (its `peerDependencies`); install the two at
the same version. An Angular app built without it stops with the `npm i` command to run.

Tested with: `@nativescript/angular >=22.0.0 <23.0.0`, `@angular/core >=22.0.0 <23.0.0`.

Source and issues: https://github.com/nstudio/compiled-frameworks (`packages/angular`).
