# @nstudio/nativescript-compiler-stubs-nativescript-ui

No-op stand-ins for the binary-only `nativescript-ui-*` plugins (`-listview`, `-gauge`, `-sidedrawer`, `-calendar`,
`-dataform`, `-autocomplete`, `-chart`), which ship no TypeScript for
[`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler) to compile. With this package installed,
an app that opts in builds each as a stand-in: its views are empty `ContentView`s that keep their place in the layout,
and every method does nothing.

```bash
npm install --save-dev @nstudio/nativescript-compiler-stubs-nativescript-ui@9.2.0-alpha.9
```

```ts
// nativescript.config.ts
release: { stubPlugins: ['nativescript-ui-listview'] }
```

It declares its stand-ins under `nativescript.compilerStubs` in its package.json (the compiler's `src/api/binding-api.ts`).

Source and issues: https://github.com/nstudio/compiled-frameworks (`packages/stubs-nativescript-ui`).
