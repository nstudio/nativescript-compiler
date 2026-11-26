import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

/** Packages whose resolution always belongs to the framework/core/kit rather than a monorepo tsconfig path alias. */
const PACKAGE_ONLY = /^(@nativescript\/(core|types|types-ios|types-android|types-minimal|angular|vue|svelte|react|react-dom|solid|webpack|vite|tailwind|android|ios)|@angular\/|vue|svelte|react|react-dom|solid-js|tslib|typescript)(\/|$)/;

type ViteAlias = { find: string | RegExp; replacement: string };
const viteAliasCache = new Map<string, ViteAlias[]>();

/** App-level `resolve.alias` entries from a Vite config (`vite.config.*`) that point to workspace TypeScript sources. */
function viteAliases(root: string): ViteAlias[] {
	const cached = viteAliasCache.get(root);
	if (cached) return cached;
	const configFile = ['vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js'].map((f) => resolve(root, f)).find(existsSync);
	if (!configFile) {
		viteAliasCache.set(root, []);
		return [];
	}
	const out: ViteAlias[] = [];
	try {
		const script = `
			import { createRequire } from 'node:module';
			import { pathToFileURL } from 'node:url';
			const req = createRequire(${JSON.stringify(resolve(root, 'package.json'))});
			const vite = await import(pathToFileURL(req.resolve('vite')).href);
			const cfg = await vite.resolveConfig({ configFile: ${JSON.stringify(configFile)}, mode: 'production' }, 'build', 'production', 'production');
			const list = (cfg.resolve?.alias ?? []).map((a) => ({
				find: a.find instanceof RegExp ? { re: a.find.source, flags: a.find.flags } : a.find,
				replacement: a.replacement,
			}));
			process.stdout.write('\\n__NS_VITE_ALIASES__' + JSON.stringify(list) + '__END__\\n');
		`;
		const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
			timeout: 15_000,
		}).toString('utf8');
		const m = /__NS_VITE_ALIASES__([\s\S]*?)__END__/.exec(stdout);
		if (m) {
			for (const entry of JSON.parse(m[1]) as { find: string | { re: string; flags: string }; replacement: string }[]) {
				const rep = entry.replacement;
				if (!rep || !isAbsolute(rep) || rep.startsWith('/@fs/') || /[\\/]node_modules[\\/]/.test(rep)) continue;
				const find = typeof entry.find === 'string' ? entry.find : new RegExp(entry.find.re, entry.find.flags);
				out.push({ find, replacement: rep });
			}
		}
	} catch {
		// Fall back cleanly to tsconfig paths if Vite cannot load in this environment.
	}
	viteAliasCache.set(root, out);
	return out;
}

/**
 * The `compilerOptions.paths` of the tsconfig.json nearest `from` (its `extends` followed), plus app-level Vite
 * `resolve.alias` entries when a `vite.config.*` is present: `~/app/x` is `<app>/src/app/x` for `"~/*": ["./src/*"]`,
 * and monorepo shared TypeScript aliases resolve to their workspace TypeScript sources.
 * A specifier targeting `node_modules`, a built JS package directory, or core/framework packages is undefined.
 */
export function pathAliases(from: string): (specifier: string) => string | undefined {
	let config: string | undefined;
	for (let dir = from; !config; dir = dirname(dir)) {
		if (existsSync(resolve(dir, 'tsconfig.json'))) config = resolve(dir, 'tsconfig.json');
		else if (dirname(dir) === dir) break;
	}
	const root = config ? dirname(config) : resolve(from);
	const vAliases = viteAliases(root);
	const options = config ? ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })?.options : undefined;
	const base = options?.baseUrl ?? (options as { pathsBasePath?: string } | undefined)?.pathsBasePath ?? root;
	const patterns = Object.entries(options?.paths ?? {}).map(([pattern, targets]) => {
		const star = pattern.indexOf('*');
		return { prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? null : pattern.slice(star + 1), targets };
	});
	// As TypeScript matches them: an exact pattern first, then the longest prefix.
	patterns.sort((a, b) => Number(a.suffix !== null) - Number(b.suffix !== null) || b.prefix.length - a.prefix.length);
	if (!patterns.length && !vAliases.length) return () => undefined;
	const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
	const names = (path: string) => ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'].some((x) => isFile(path + x)) || ['ios', 'android'].some((p) => isFile(`${path}.${p}.ts`) || isFile(`${path}/index.${p}.ts`));
	return (spec) => {
		if (!PACKAGE_ONLY.test(spec)) {
			for (const a of vAliases) {
				if (typeof a.find === 'string') {
					if (spec === a.find && names(a.replacement)) return a.replacement;
					if (spec.startsWith(a.find + '/')) {
						const sub = resolve(a.replacement, spec.slice(a.find.length + 1));
						if (!/[\\/]node_modules[\\/]/.test(sub) && names(sub)) return sub;
					}
				} else if (a.find.test(spec)) {
					const rep = spec.replace(a.find, a.replacement);
					if (isAbsolute(rep) && !/[\\/]node_modules[\\/]/.test(rep) && names(rep)) return rep;
				}
			}
		}
		for (const p of patterns) {
			let star = '';
			if (p.suffix === null) {
				if (spec !== p.prefix) continue;
			} else {
				if (spec.length < p.prefix.length + p.suffix.length || !spec.startsWith(p.prefix) || !spec.endsWith(p.suffix)) continue;
				star = spec.slice(p.prefix.length, spec.length - p.suffix.length);
			}
			const found = p.targets
				.map((t) => resolve(base, t.replace('*', star)))
				.find((t) => {
					if (/[\\/]node_modules[\\/]/.test(t) || !names(t)) return false;
					if (t.startsWith(root + sep)) return true;
					// Outside the app folder (monorepo shared libraries): allow TypeScript sources, never core/framework packages.
					return !PACKAGE_ONLY.test(spec);
				});
			if (found) return found;
		}
		return undefined;
	};
}
