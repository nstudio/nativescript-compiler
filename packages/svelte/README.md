# @nstudio/nativescript-compiler-svelte

Svelte adapter for [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), enabling NativeScript Svelte apps (`@nativescript-community/svelte-native`, Svelte 4 or 5) to compile directly to Swift (iOS) and Kotlin (Android) with no JavaScript runtime.

## Installation

```bash
ns extension install @nstudio/nativescript-compiler
npm install --save-dev @nstudio/nativescript-compiler-svelte
```

Install the adapter at the same version as `@nstudio/nativescript-compiler`.

## Usage

```bash
ns compile ios
ns compile android
```

## Supported Versions

- `@nativescript-community/svelte-native`: `>=1.0.0 <2.0.0` or `>=5.0.0-alpha.0 <6.0.0`
- `svelte`: `>=4.2.0 <5.0.0` or `>=5.50.0 <6.0.0`

## License

MIT
