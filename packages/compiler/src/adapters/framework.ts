import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AdapterManifest } from './load.ts';
import { FIRST_PARTY_ADAPTERS } from './first-party.ts';
import { byName } from '../program/order.ts';

/**
 * How an app is recognised as written with an adapter's framework, as its package.json declares it
 * (`nativescript.compilerAdapter.detect`): read without loading the adapter.
 */
export interface AdapterDetect {
	/** Adapters are tried highest first, equal ones by package name. */
	priority?: number;
	/** Packages any one of which among the app's dependencies or devDependencies names the framework. */
	dependencies?: string[];
	/** Text any of which in the app's entry file names the framework: tried only when no adapter's dependencies match. */
	entryMentions?: string[];
	/** Specifiers the entry file imports from (`from '<specifier>'`), tried as `entryMentions` are. */
	entryImports?: string[];
}

const FLAVOR_CONFIG_KEYS = [
	['nativescript', 'compiler', 'flavor'],
	['nativescript', 'vite', 'flavor'],
] as const;

function readNestedString(obj: unknown, path: readonly string[]): string | undefined {
	let cur: unknown = obj;
	for (const key of path) {
		if (!cur || typeof cur !== 'object' || !(key in cur)) return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return typeof cur === 'string' ? cur : undefined;
}

export function readPackageJson(dir: string): Record<string, unknown> | undefined {
	const pkgPath = join(dir, 'package.json');
	if (!existsSync(pkgPath)) return undefined;
	try {
		return JSON.parse(readFileSync(pkgPath, 'utf8'));
	} catch {
		return undefined;
	}
}

/** The dependencies and devDependencies of the package.json nearest the app's folder. */
export function collectDependencies(projectRoot: string): Record<string, string> {
	let dir = resolve(projectRoot);
	for (let depth = 0; depth < 5; depth++) {
		const pkg = readPackageJson(dir);
		if (pkg) {
			const devDeps = (pkg.devDependencies as Record<string, string>) || {};
			const deps = (pkg.dependencies as Record<string, string>) || {};
			return { ...devDeps, ...deps };
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}

/** The folder of a package installed for the app: in its node_modules, a `file:` dependency, or a parent folder's. */
export function installedPackageDir(projectRoot: string, depName: string): string | undefined {
	let dir = resolve(projectRoot);
	for (let depth = 0; depth < 5; depth++) {
		const candidate = join(dir, 'node_modules', depName);
		if (readPackageJson(candidate)) return candidate;
		const pkg = readPackageJson(dir);
		const spec = (pkg?.dependencies as Record<string, unknown> | undefined)?.[depName] ?? (pkg?.devDependencies as Record<string, unknown> | undefined)?.[depName];
		if (typeof spec === 'string' && spec.startsWith('file:')) {
			const local = resolve(dir, spec.slice(5));
			if (readPackageJson(local)) return local;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function hasXmlViews(dir: string, appFiles?: string[], appDir?: string): boolean {
	if (appFiles && appDir) {
		return appFiles.some((f) => f.endsWith('.xml') && f.startsWith(appDir));
	}
	for (const sub of ['src', 'app']) {
		const target = join(dir, sub);
		if (!existsSync(target)) continue;
		try {
			const entries = readdirSync(target, { withFileTypes: true }).sort(byName);
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith('.xml')) return true;
			}
		} catch {}
	}
	return false;
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The framework an app is written with: an adapter's framework, `core` (XML and TypeScript, no adapter), or null. A
 * framework a first-party adapter is published for (adapters/first-party.ts) is returned when the app names it or
 * depends on its packages even with that adapter not installed (`adapters`), so that the build can say which to install.
 */
export function detectFramework(projectRoot: string, adapters: readonly AdapterManifest[], entryFile?: string, appFiles?: string[], appDir?: string): string | null {
	const known = (f: string | undefined) => f !== undefined && (f === 'core' || adapters.some((a) => a.framework === f) || Object.hasOwn(FIRST_PARTY_ADAPTERS, f));
	const rootPkg = readPackageJson(projectRoot);
	if (rootPkg) {
		for (const keyPath of FLAVOR_CONFIG_KEYS) {
			const explicit = readNestedString(rootPkg, keyPath);
			if (known(explicit)) return explicit!;
		}
	}

	const allDeps = collectDependencies(projectRoot);

	// Check installed packages that declare nativescript.compiler.flavor or nativescript.vite.flavor.
	for (const depName of Object.keys(allDeps)) {
		const dir = installedPackageDir(projectRoot, depName);
		const depPkg = dir && readPackageJson(dir);
		if (!depPkg) continue;
		for (const keyPath of FLAVOR_CONFIG_KEYS) {
			const declared = readNestedString(depPkg, keyPath);
			if (known(declared)) return declared!;
		}
	}

	const ordered = [...adapters].sort((a, b) => (b.detect.priority ?? 0) - (a.detect.priority ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const depends = (names: readonly string[] | undefined) => !!names?.some((n) => allDeps[n]);
	const byDependency = ordered.find((a) => depends(a.detect.dependencies));
	if (byDependency) return byDependency.framework;
	const uninstalled = Object.entries(FIRST_PARTY_ADAPTERS).find(([f, a]) => !adapters.some((x) => x.framework === f) && depends(a.markers));
	if (uninstalled) return uninstalled[0];

	if (entryFile && existsSync(entryFile)) {
		try {
			const src = readFileSync(entryFile, 'utf8');
			const named = ordered.find(({ detect }) => detect.entryMentions?.some((m) => src.includes(m)) || detect.entryImports?.some((s) => new RegExp(`from\\s+['"]${escaped(s)}['"]`).test(src)));
			if (named) return named.framework;
		} catch {}
	}

	if (hasXmlViews(projectRoot, appFiles, appDir)) return 'core';
	return null;
}
