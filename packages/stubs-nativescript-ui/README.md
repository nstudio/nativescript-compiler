# @nstudio/nativescript-compiler-stubs-nativescript-ui

No-op stand-in views for binary-only `nativescript-ui-*` plugins (`-listview`, `-gauge`, `-sidedrawer`, `-calendar`, `-dataform`, `-autocomplete`, `-chart`) when building with [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler).

Each opted-in plugin compiles as an empty `ContentView` stand-in that preserves layout structure with no-op methods.

## Installation

```bash
npm install --save-dev @nstudio/nativescript-compiler-stubs-nativescript-ui
```

## Usage

Opt in per plugin in `nativescript.config.ts`:

```ts
export default {
  // ...
  release: {
    stubPlugins: ['nativescript-ui-listview'],
  },
};
```

## License

MIT
