// The binding and stub packages available to an app (binding-api.ts): found as adapters are, in each folder of
// $NS_COMPILER_ADAPTERS, then among the app's dependencies, by the block their package.json declares.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ADAPTERS_OVERRIDE } from '../adapters/load.ts';
import { productionPlugins } from '../targets/resources.ts';
import type { BindingApiVersion, CompilerBinding, CompilerStubs } from '../api/binding-api.ts';
import type { AndroidBinding } from './bindings-android.ts';
import { satisfies } from '../driver/contract.ts';
import { collectDependencies, installedPackageDir, readPackageJson } from '../adapters/framework.ts';
import { boundToEngine } from '../targets/ios/dependencies.ts';

const BINDING_API_VERSION: BindingApiVersion = 1;

/** A plugin's binding as found, its paths absolute. */
export interface Binding {
	/** The binding package's name and folder. */
	name: string;
	root: string;
	/** The plugin it binds. */
	package: string;
	ios?: { dir: string; installer: string; conditions: string | null };
	android?: AndroidBinding;
}

/** The packages declaring `nativescript[key]`: $NS_COMPILER_ADAPTERS's folders first, then the app's dependencies. */
function declaring<T extends { apiVersion: unknown }>(app: string, key: string): { name: string; version: string; root: string; block: T }[] {
	const dirs: string[] = [];
	const override = process.env[ADAPTERS_OVERRIDE];
	if (override && existsSync(override) && statSync(override).isDirectory()) for (const d of readdirSync(override).sort()) dirs.push(join(override, d));
	for (const name of Object.keys(collectDependencies(app)).sort()) {
		const dir = installedPackageDir(app, name);
		if (dir) dirs.push(dir);
	}
	return dirs.flatMap((dir) => {
		const pkg = readPackageJson(dir) as any;
		const block = pkg?.nativescript?.[key];
		if (!block) return [];
		const root = resolve(dir);
		if (block.apiVersion !== BINDING_API_VERSION) throw new Error(`${pkg.name} ${pkg.version} (${root}) is written for compiler binding API ${block.apiVersion ?? '(none)'}, and this @nstudio/nativescript-compiler reads API ${BINDING_API_VERSION}`);
		return [{ name: String(pkg.name), version: String(pkg.version), root, block: block as T }];
	});
}

/** The plugins the app depends on, directly or through other plugins (not through those it stubs), with their installed versions. */
function appPlugins(app: string, platform: 'ios' | 'android', stubbed: ReadonlySet<string>): Map<string, string> {
	const out = new Map<string, string>();
	const add = (name: string, dir: string | undefined) => {
		const version = dir && (readPackageJson(dir) as any)?.version;
		if (version && !out.has(name)) out.set(name, String(version));
	};
	for (const name of Object.keys(collectDependencies(app))) add(name, installedPackageDir(app, name));
	for (const p of productionPlugins(app, platform, stubbed)) add(p.name, p.dir);
	return out;
}

/** The bindings of the plugins the app depends on: the first found for each, refused where it does not bind the installed version. */
export function appBindings(app: string, platform: 'ios' | 'android', stubbed: ReadonlySet<string> = new Set()): Binding[] {
	const plugins = appPlugins(app, platform, stubbed);
	const out: Binding[] = [];
	for (const { name, version, root, block } of declaring<CompilerBinding>(app, 'compilerBinding')) {
		const installed = plugins.get(block.package);
		if (installed === undefined || out.some((b) => b.package === block.package)) continue;
		if (!satisfies(installed, block.versions)) throw new Error(`${name} ${version} (${root}) binds ${block.package} ${block.versions}, and the app has ${block.package} ${installed}: install a ${name} that binds it`);
		const at = (f: string) => resolve(root, f);
		const { ios, android } = block;
		out.push({
			name,
			root,
			package: block.package,
			ios: ios && { dir: at(ios.sources), installer: ios.installer, conditions: ios.conditions ? at(ios.conditions) : null },
			android: android && { package: block.package, script: at(android.script), kotlin: at(android.kotlin), jni: at(android.jni), installer: android.installer, stubs: android.stubs, links: android.links },
		});
	}
	return out;
}

/** Whether a plugin's native code for `platform` binds the JavaScript engine (V8/Node-API headers or sources written against them). */
function bindsEngine(pluginDir: string, platform: 'ios' | 'android'): boolean {
	const dir = join(pluginDir, 'platforms', platform);
	if (!existsSync(dir)) return false;
	return readdirSync(dir)
		.sort()
		.some((f) => statSync(join(dir, f)).isDirectory() && boundToEngine(join(dir, f)));
}

/** The app's plugins whose native code binds the JavaScript engine and that no binding stands in for. */
export function unboundEnginePlugins(app: string, platform: 'ios' | 'android', bindings: readonly Binding[], stubbed: ReadonlySet<string> = new Set()): string[] {
	return productionPlugins(app, platform, stubbed)
		.filter((p) => !bindings.some((b) => b.package === p.name && b[platform]) && bindsEngine(p.dir, platform))
		.map((p) => `${p.name} installs objects into the JavaScript engine from its native code, and a compiled app has no engine: a compiled build needs a binding of ${p.name} for ${platform}, a package whose package.json declares nativescript.compilerBinding for it, installed for the app`);
}

/** The binary-only plugins a stand-in is found for, each with its module: the first found for each. */
export function pluginStubs(app: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const { root, block } of declaring<CompilerStubs>(app, 'compilerStubs')) for (const p of block.packages) if (!out.has(p)) out.set(p, resolve(root, block.module));
	return out;
}
