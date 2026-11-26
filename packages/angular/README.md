# @nstudio/nativescript-compiler-angular

Angular adapter for [`@nstudio/nativescript-compiler`](https://www.npmjs.com/package/@nstudio/nativescript-compiler), enabling NativeScript Angular apps (`@nativescript/angular`) to compile directly to Swift (iOS) and Kotlin (Android) with no JavaScript runtime.

## Installation

```bash
ns extension install @nstudio/nativescript-compiler
npm install --save-dev @nstudio/nativescript-compiler-angular
```

Install the adapter at the same version as `@nstudio/nativescript-compiler`.

## Usage

```bash
ns compile ios
ns compile android
```

## Supported Versions

- `@nativescript/angular`: `>=22.0.0 <23.0.0`
- `@angular/core`: `>=22.0.0 <23.0.0`

## License

MIT
