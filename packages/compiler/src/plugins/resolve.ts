import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The package a bare module specifier names (`@scope/name/deep` → `@scope/name`). */
export function packageOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The file NativeScript's bundler loads for a module specifier: a package's
 * `main` (or a deep path into it), with the platform's `.ios`/`.android`
 * variant before the plain one, then the directory's index; for a package
 * with neither, the ES module its `exports` or `module` names.
 */
export function runtimeFile(specifier: string, modules: string, platform: 'ios' | 'android', localPackages?: ReadonlyMap<string, string>): { packageDir: string; file: string } | null {
	const name = packageOf(specifier);
	const inModules = join(modules, name);
	const packageDir = existsSync(join(inModules, 'package.json')) ? inModules : localPackages?.get(name);
	if (!packageDir || !existsSync(join(packageDir, 'package.json'))) return null;
	const deep = specifier.slice(name.length).replace(/^\//, '');
	const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
	const base = deep ? join(packageDir, deep) : resolve(packageDir, (pkg.main ?? 'index').replace(/\.js$/, ''));
	// Platform-specific NativeScript files (`*.ios.js`, `*.android.js`) take priority over generic `exports`/`module`.
	const platformSpecific = [`${base}.${platform}.js`, join(base, `index.${platform}.js`)].find(isFile);
	if (platformSpecific) return { packageDir, file: platformSpecific };
	// Prefer `exports` (matching browser/import conditions, never node) and `module` (ESM) over CommonJS `main`.
	const esm = exported(pkg.exports, deep ? `./${deep}` : '.') ?? (!deep && typeof pkg.module === 'string' ? pkg.module : null);
	const esmTarget = esm ? runtimeCandidate(resolve(packageDir, esm), platform, esm.endsWith('.mjs') ? '.mjs' : '.js') : null;
	if (esmTarget) return { packageDir, file: esmTarget };
	const file = (deep ? (asFile(base, platform) ?? entryOf(base, platform)) : null) ?? runtimeCandidate(base, platform);
	if (file) return { packageDir, file };
	return null;
}

const isFile = (f: string) => existsSync(f) && statSync(f).isFile();

function asFile(base: string, platform: 'ios' | 'android'): string | null {
	for (const f of [base.endsWith('.js') ? base : '', `${base}.${platform}.js`, `${base}.js`]) if (f && isFile(f)) return f;
	return null;
}

/**
 * A directory's own package.json entry (a secondary entry point, `pkg/sub`), before its index: `exports['.']`, then
 * the bundler's main fields in the order NativeScript's framework builds set them, `module` then `main`.
 */
function entryOf(dir: string, platform: 'ios' | 'android'): string | null {
	let pkg: { exports?: unknown; module?: unknown; main?: unknown };
	try {
		pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
	for (const field of [exported(pkg.exports, '.'), pkg.module, pkg.main]) {
		const f = typeof field === 'string' ? runtimeCandidate(resolve(dir, field), platform, field.endsWith('.mjs') ? '.mjs' : '.js') : null;
		if (f) return f;
	}
	return null;
}

/** The file `exports` maps a subpath to under the conditions a bundler importing it sets; type declarations are not one. */
function exported(exports: unknown, subpath: string): string | null {
	if (!exports) return null;
	const subpaths = typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
	const entry = subpaths ? (exports as Record<string, unknown>)[subpath] : subpath === '.' ? exports : undefined;
	const pick = (e: unknown): string | null => {
		if (typeof e === 'string') return /\.d\.[cm]?ts$/.test(e) ? null : e;
		if (Array.isArray(e)) return e.map(pick).find((x) => x) ?? null;
		if (!e || typeof e !== 'object') return null;
		// Prefer `browser` over generic `default`/`require` (NativeScript is not Node), then standard bundler conditions.
		const record = e as Record<string, unknown>;
		for (const cond of ['browser', 'import', 'module', 'default', 'require']) {
			if (Object.hasOwn(record, cond)) {
				const f = pick(record[cond]);
				if (f) return f;
			}
		}
		return null;
	};
	return pick(entry);
}

/** `base` as the bundler completes it: `base.ios.js`, `base.js`, `base/index.ios.js`, `base/index.js`. */
export function runtimeCandidate(base: string, platform: 'ios' | 'android', ext = '.js'): string | null {
	const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
	if (base.endsWith(ext) && isFile(base)) return base;
	for (const f of [`${base}.${platform}${ext}`, `${base}${ext}`, join(base, `index.${platform}${ext}`), join(base, `index${ext}`)]) if (isFile(f)) return f;
	return null;
}

/** A relative import in a plugin's source as the bundler resolves it, platform variant first. */
export function runtimeRelative(specifier: string, from: string, platform: 'ios' | 'android'): string | null {
	const base = resolve(dirname(from), specifier);
	for (const ext of ['.ts', '.tsx']) {
		const f = runtimeCandidate(base, platform, ext);
		if (f) return f;
	}
	return null;
}
