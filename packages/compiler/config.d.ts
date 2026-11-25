import '@nativescript/core';

/**
 * Per-project options read by `@nstudio/nativescript-compiler` from `nativescript.config.ts`
 * under `release`, `ios.release`, and `android.release`.
 *
 * Import `'@nstudio/nativescript-compiler/config'` in `nativescript.config.ts` (or in a project
 * `.d.ts`) to augment `NativeScriptConfig` and `IConfigPlatform` with these fields.
 */
export interface NativeScriptCompilerReleaseConfig {
	/** Packages the compiled build replaces with a module of the app's, as `'package': 'path'`. */
	pluginReplacements?: Record<string, string>;
	/** Local checkouts of plugins' TypeScript source, as `'package': 'path'`, used instead of fetching the published revision. */
	pluginSources?: Record<string, string>;
	/**
	 * Binary-only plugins (no TypeScript source, such as `nativescript-ui-listview`) to build as no-op stand-ins:
	 * their views render empty and their methods do nothing. Without it, such a plugin stops the build.
	 */
	stubPlugins?: string[];
	/** Build despite properties core declares that the compiled build does not apply, with a warning for each. */
	allowUnimplementedProperties?: boolean;
	/** Build with a `@nativescript/core` version other than the one the compiler was made for, with a warning. */
	allowCoreMismatch?: boolean;
	/** Build with a framework version outside the compiler's tested range, with a warning. */
	allowUntestedFrameworks?: boolean;
	/** Android: build on the kit generated from core (the default when the compiler ships it); `false` uses the hand-written kit. */
	generatedKit?: boolean;
	/** Android: R8 keeps only what the kit's reflection needs, instead of every kit class. */
	narrowKitKeeps?: boolean;
}

declare module '@nativescript/core' {
	interface IConfigPlatform {
		/** Release options for this platform, merged over the top-level `release`; object options merge by key. */
		release?: NativeScriptCompilerReleaseConfig;
	}
	interface NativeScriptConfig {
		/** Compiled release options for `@nstudio/nativescript-compiler`; `ios.release` and `android.release` override per platform. */
		release?: NativeScriptCompilerReleaseConfig;
	}
}
