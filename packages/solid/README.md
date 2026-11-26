# @nstudio/nativescript-compiler-solid

Solid adapter for [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), enabling NativeScript Solid apps (`@nativescript-community/solid-js`) to compile directly to Swift (iOS) and Kotlin (Android) with no JavaScript runtime.

## Installation

```bash
ns extension install @nstudio/nativescript-compiler
npm install --save-dev @nstudio/nativescript-compiler-solid
```

Install the adapter at the same version as `@nstudio/nativescript-compiler`.

## Usage

```bash
ns compile ios
ns compile android
```

## Supported Versions

- `@nativescript-community/solid-js`: `>=2.0.0-rc.0 <3.0.0`
- `solid-js`: `>=2.0.0-rc.0 <3.0.0`

## License

MIT
