import ts from 'typescript';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** Packages whose resolution always belongs to the framework/core/kit rather than a monorepo tsconfig path alias. */
const PACKAGE_ONLY = /^(@nativescript\/(core|types|types-ios|types-android|types-minimal|angular|vue|svelte|react|solid|webpack|vite|tailwind|android|ios)|@angular\/|vue|svelte|react|react-dom|solid-js|tslib|typescript)(\/|$)/;

/**
 * The `compilerOptions.paths` of the tsconfig.json nearest `from` (its `extends` followed), as the app's bundler applies
 * them to the app's own files: `~/app/x` is `<app>/src/app/x` for `"~/*": ["./src/*"]`, and monorepo shared TypeScript
 * aliases (such as `"@demo/shared": ["../../tools/demo/index.ts"]`) resolve to their workspace TypeScript sources.
 * A specifier targeting `node_modules`, a built JS package directory, or core/framework packages is undefined.
 */
export function pathAliases(from: string): (specifier: string) => string | undefined {
	let config: string | undefined;
	for (let dir = from; !config; dir = dirname(dir)) {
		if (existsSync(resolve(dir, 'tsconfig.json'))) config = resolve(dir, 'tsconfig.json');
		else if (dirname(dir) === dir) return () => undefined;
	}
	const options = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })?.options;
	if (!options?.paths) return () => undefined;
	const root = dirname(config);
	const base = options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? root;
	const patterns = Object.entries(options.paths).map(([pattern, targets]) => {
		const star = pattern.indexOf('*');
		return { prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? null : pattern.slice(star + 1), targets };
	});
	// As TypeScript matches them: an exact pattern first, then the longest prefix.
	patterns.sort((a, b) => Number(a.suffix !== null) - Number(b.suffix !== null) || b.prefix.length - a.prefix.length);
	const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
	const names = (path: string) => ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'].some((x) => isFile(path + x)) || ['ios', 'android'].some((p) => isFile(`${path}.${p}.ts`) || isFile(`${path}/index.${p}.ts`));
	return (spec) => {
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
