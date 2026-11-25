// The contract between the compiler and the packages that supply what a plugin's own code cannot give a compiled app.
// Both are declared in the package's package.json, read without loading any of its code; paths are relative to the
// package's folder. Types only.
// - `nativescript.compilerBinding` (CompilerBinding): a binding of a plugin whose native code installs objects into the
//   JavaScript engine (V8 headers, `v8::` code, objects set on `global`), which no compiled app has: the same objects
//   over the same native API, in Swift and Kotlin.
// - `nativescript.compilerStubs` (CompilerStubs): no-op stand-ins for binary-only plugins, which ship no TypeScript to
//   compile, built when the app opts in with `release.stubPlugins`.
// Packages are found in each folder of $NS_COMPILER_ADAPTERS, then among the app's dependencies; the first found for a
// plugin is used, and only when the app depends on that plugin.

/** The version of this contract; the compiler refuses a package written against another. */
export type BindingApiVersion = 1;

/** `nativescript.compilerBinding`. */
export interface CompilerBinding {
	apiVersion: BindingApiVersion;
	/** The plugin bound, as an app depends on it. */
	package: string;
	/** The plugin's versions the binding builds over (a semver range). */
	versions: string;
	ios?: IosBinding;
	android?: AndroidBinding;
}

export interface IosBinding {
	/** A folder of Swift sources, compiled with the app. */
	sources: string;
	/** The type whose `install()` the app's entry calls before any module runs. */
	installer: string;
	/**
	 * A JSON file of compilation conditions (condition → C symbol): each one whose symbol the plugin's headers declare
	 * is set, so one binding builds over versions of the native library that differ in API.
	 */
	conditions?: string;
}

export interface AndroidBinding {
	/** The module the app's imports of the plugin resolve to, in place of the plugin's own script. */
	script: string;
	/** A folder of Kotlin sources, compiled with the app. */
	kotlin: string;
	/** The JNI layer's CMake project, over the plugin's native libraries. */
	jni: string;
	/** The object whose `install()` the app's entry calls before any module runs. */
	installer: string;
	/** Libraries of the plugin's that bind the engine: empty libraries of their names stand in for them. */
	stubs: string[];
	/** Libraries of the plugin's the JNI layer links, given to CMake as `-D<define>=<dir>` (`<dir>/<abi>/lib<lib>.so`). */
	links: { lib: string; define: string }[];
}

/** `nativescript.compilerStubs`. */
export interface CompilerStubs {
	apiVersion: BindingApiVersion;
	/** The binary-only plugins the module stands in for. */
	packages: string[];
	/** A TypeScript module every import of those plugins resolves to: what apps use of them, each method doing nothing. */
	module: string;
}
