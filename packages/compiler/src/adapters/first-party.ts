// The framework adapters NativeScript publishes, and the packages whose presence among an app's dependencies means the
// app is written with that framework: read only to name the package to install when an app's framework has no adapter
// installed. Detection itself reads the installed adapters' own declarations (`nativescript.compilerAdapter.detect`).
// Listed in the order detection tries them.

export interface FirstPartyAdapter {
	/** The adapter's package. */
	package: string;
	/** The packages an app of the framework depends on: any one of them names the framework. */
	markers: readonly string[];
}

export const FIRST_PARTY_ADAPTERS: Readonly<Record<string, FirstPartyAdapter>> = {
	vue: { package: '@nstudio/nativescript-compiler-vue', markers: ['nativescript-vue', 'vue'] },
	angular: { package: '@nstudio/nativescript-compiler-angular', markers: ['@nativescript/angular', '@angular/core'] },
	svelte: { package: '@nstudio/nativescript-compiler-svelte', markers: ['@nativescript-community/svelte-native', 'svelte'] },
	react: { package: '@nstudio/nativescript-compiler-react', markers: ['react-nativescript', 'react'] },
	solid: { package: '@nstudio/nativescript-compiler-solid', markers: ['@nativescript-community/solid-js', 'solid-js'] },
	octane: { package: '@nstudio/nativescript-compiler-octane', markers: ['@nativescript-community/octane', '@nativescript/octane'] },
};
