// What one build knows beyond its inputs' text: its framework adapter, the plugins it builds as stand-ins, the bundler's
// defines, and the refusals it made. `compile()` (driver/compile.ts) makes one per build; a harness makes one per program
// it translates. Nothing here outlives the build, so two builds in one process share nothing.
import { resolve, sep } from 'node:path';
import type { FrameworkAdapter } from '../api/adapter-api.ts';
import { ActiveAdapter } from '../adapters/active.ts';
import { RefusalLog } from '../semantics/refusals.ts';

export class BuildContext {
	/** The build's framework adapter; one of no framework until `useAdapter`. */
	adapter = new ActiveAdapter(null);
	/** The refusals the build made and reported. */
	readonly refusals = new RefusalLog(() => this.adapter);
	/** Binary-only plugins built as no-op stand-ins (`release.stubPlugins`). */
	readonly stubbedPlugins = new Set<string>();
	/** Each stubbed plugin's stand-in module, which its imports resolve to. */
	readonly pluginStubModules = new Map<string, string>();
	/** The bundler's `define` replacements, longest key first, applied to every source the build reads (program/platform.ts). */
	defines: readonly [string, string][] = [];
	private bindingRoots: string[] = [];

	/** The build's adapter, or null for an app with no framework: set before the program is made. */
	useAdapter(adapter: FrameworkAdapter | null): void {
		this.adapter = new ActiveAdapter(adapter);
	}

	/** The folders of the build's plugin bindings (plugins/bindings.ts), whose sources compile with the app as another package's. */
	useBindingRoots(roots: readonly string[]): void {
		this.bindingRoots = roots.map((r) => resolve(r) + sep);
	}

	/** A source of one of the build's plugin bindings. */
	isBindingSource(file: string): boolean {
		return this.bindingRoots.some((r) => file.startsWith(r));
	}

	/** What a translator of the build is given of it (semantics/config.ts). */
	translation(): { adapter: ActiveAdapter; refusals: RefusalLog; isBindingSource: (file: string) => boolean } {
		return { adapter: this.adapter, refusals: this.refusals, isBindingSource: (file) => this.isBindingSource(file) };
	}

	/** Builds a binary-only plugin as its stand-in module. */
	stubPlugin(name: string, module: string): void {
		this.stubbedPlugins.add(name);
		this.pluginStubModules.set(name, module);
	}

	/** The bundler's `define` replacements, as its build gives them. */
	useDefines(map: Record<string, string> | undefined): void {
		// The platform flags are folded for the target being built, whatever the bundler defined them as.
		const folded = /^(global\.|globalThis\.)?(isIOS|isAndroid|__IOS__|__ANDROID__|__APPLE__|__VISIONOS__|__DEV__)$/;
		this.defines = Object.entries(map ?? {})
			.filter(([k]) => !folded.test(k))
			.sort((a, b) => b[0].length - a[0].length);
	}
}
