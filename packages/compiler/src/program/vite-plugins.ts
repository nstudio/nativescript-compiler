// Loads app-authored Vite plugins from an app's `vite.config.*` so ahead-of-time compilation honors
// custom `resolveId`, `transform`, and `load` hooks (e.g. monorepo component shims, virtual markdown modules).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ViteAppPlugins {
	resolveId(specifier: string, importer?: string): string | undefined;
	transform(code: string, id: string): string;
	load(id: string): string | undefined;
}

export const NO_VITE_PLUGINS: ViteAppPlugins = {
	resolveId: () => undefined,
	transform: (code) => code,
	load: () => undefined,
};

/** Built-in Vite, @nativescript/vite, and framework bundler plugins skipped when running app-level hooks. */
const BUILTIN_PLUGIN_PREFIX = /^(vite:|builtin:|native:|ns-|nsvite-|@analogjs\/|vite-plugin-static-copy)/;
const BUILTIN_PLUGIN_NAMES = new Set([
	'alias',
	'replace',
	'main-entry',
	'source-map-js-compat',
	'html-entities-compat',
	'fast-xml-parser-compat',
	'angular-template-deps',
	'nativescript-package-resolver',
	'nativescript-worker-loader-stub',
	'nativescript-angular-worker-url-preserve',
	'nativescript-app-components',
	'nativescript-worker-url-transform',
	'nativescript-dynamic-import-fix',
	'nativescript-cli-integration',
]);

type HookFn = (...args: any[]) => any;
type PluginLike = {
	name?: string;
	resolveId?: HookFn | { handler?: HookFn };
	transform?: HookFn | { handler?: HookFn };
	load?: HookFn | { handler?: HookFn };
};

function hookFn(hook: HookFn | { handler?: HookFn } | undefined): HookFn | undefined {
	if (typeof hook === 'function') return hook;
	if (hook && typeof hook.handler === 'function') return hook.handler;
	return undefined;
}

const cache = new Map<string, ViteAppPlugins>();

/** Resolves the app's `vite.config.*` (if any) and returns a synchronous bridge to its custom app plugins. */
export async function loadViteAppPlugins(root: string): Promise<ViteAppPlugins> {
	const absRoot = resolve(root);
	const cached = cache.get(absRoot);
	if (cached) return cached;
	const configFile = ['vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js'].map((f) => resolve(absRoot, f)).find(existsSync);
	if (!configFile || !existsSync(resolve(absRoot, 'package.json'))) {
		cache.set(absRoot, NO_VITE_PLUGINS);
		return NO_VITE_PLUGINS;
	}
	const prevCwd = process.cwd();
	const prevIgnore = process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING;
	let plugins: PluginLike[] = [];
	try {
		process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';
		process.chdir(absRoot);
		const req = createRequire(resolve(absRoot, 'package.json'));
		const vite = await import(pathToFileURL(req.resolve('vite')).href);
		const cfg = await vite.resolveConfig({ configFile, root: absRoot, mode: 'production' }, 'build', 'production', 'production');
		plugins = (cfg.plugins ?? []).filter((p: PluginLike) => {
			const name = p?.name ?? '';
			return !!name && !BUILTIN_PLUGIN_PREFIX.test(name) && !BUILTIN_PLUGIN_NAMES.has(name);
		});
	} catch {
		plugins = [];
	} finally {
		process.chdir(prevCwd);
		if (prevIgnore === undefined) delete process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING;
		else process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = prevIgnore;
	}
	if (!plugins.length) {
		cache.set(absRoot, NO_VITE_PLUGINS);
		return NO_VITE_PLUGINS;
	}
	const resolvers = plugins.map((p) => hookFn(p.resolveId)).filter((fn): fn is HookFn => !!fn);
	const transformers = plugins.map((p) => hookFn(p.transform)).filter((fn): fn is HookFn => !!fn);
	const loaders = plugins.map((p) => hookFn(p.load)).filter((fn): fn is HookFn => !!fn);
	const ctx = { warn: () => {}, error: (e: unknown) => { throw new Error(String(e)); } };
	const bridge: ViteAppPlugins = {
		resolveId(specifier, importer) {
			for (const fn of resolvers) {
				try {
					const out = fn.call(ctx, specifier, importer, {});
					if (out && typeof out.then === 'function') continue;
					const id = typeof out === 'string' ? out : out && typeof out.id === 'string' ? out.id : undefined;
					if (id && !id.startsWith('\0')) return id;
				} catch {
					// Ignore plugins that rely on full Rollup context for unrelated specifiers.
				}
			}
			return undefined;
		},
		transform(code, id) {
			let cur = code;
			for (const fn of transformers) {
				try {
					const out = fn.call(ctx, cur, id);
					if (out && typeof out.then === 'function') continue;
					if (typeof out === 'string') cur = out;
					else if (out && typeof out.code === 'string') cur = out.code;
				} catch {
					// Ignore plugins that cannot transform this file synchronously.
				}
			}
			return cur;
		},
		load(id) {
			for (const fn of loaders) {
				try {
					const out = fn.call(ctx, id);
					if (out && typeof out.then === 'function') continue;
					if (typeof out === 'string') return out;
					if (out && typeof out.code === 'string') return out.code;
				} catch {
					// Ignore plugins that do not handle this id.
				}
			}
			return undefined;
		},
	};
	cache.set(absRoot, bridge);
	return bridge;
}
