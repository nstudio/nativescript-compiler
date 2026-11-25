// The framework adapters available to an app, found as packages and loaded only for the app's own framework, and the
// compiler functions each is given. An adapter is a package `@nativescript/compiler-<framework>` whose package.json
// declares `nativescript.compilerAdapter`: its API version, how an app of its framework is recognised (`detect`, read
// without loading its code) and the framework's versions it is tested with (`testedVersions`). Found, in this order:
// - each folder of $NS_COMPILER_ADAPTERS that holds one (development: adapter sources beside a compiler checkout; not
//   checked against the compiler's version);
// - each `@nativescript/compiler-*` package the app's package.json lists, installed for the app.
// The first found for a framework is its adapter. A plain XML app loads none.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ADAPTER_API_VERSION, type CoreApi, type FrameworkAdapter } from '../api/adapter-api.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { BuildContext } from '../program/build-context.ts';
import { satisfies } from '../driver/contract.ts';
import { canonical, ELEMENTS, MODELS } from '../api/elements.ts';
import { FIRST_PARTY_ADAPTERS } from './first-party.ts';
import { collectDependencies, installedPackageDir, readPackageJson, type AdapterDetect } from './framework.ts';
import { scopeTemplate } from '../api/ir.ts';
import { rowTemplates } from '../api/listview.ts';
import { PACKAGE } from '../driver/paths.ts';
import { foldPlatform } from '../program/platform.ts';
import { packageOf } from '../plugins/resolve.ts';
import { rewrite } from '../api/rewrite.ts';
import { NONISOLATED_DEINIT, ident as swiftIdent, isFunctionType as swiftFunctionType, isOptional, swiftString } from '../swift/syntax.ts';
import { ident as kotlinIdent, isFunctionType as kotlinFunctionType, isNullable, kotlinString } from '../kotlin/syntax.ts';
import { isAsync } from '../semantics/throws.ts';

const COMPILER_NAME = '@nstudio/nativescript-compiler';
const PREFIX = '@nstudio/nativescript-compiler-';
const ADAPTER_PREFIXES = [PREFIX, '@nativescript/compiler-'] as const;
const frameworkFromPackageName = (name: string): string | undefined => {
	const matched = ADAPTER_PREFIXES.find((p) => name.startsWith(p));
	return matched ? name.slice(matched.length) : undefined;
};
/** The environment variable naming a folder of adapter packages, which come before the app's own. */
export const ADAPTERS_OVERRIDE = 'NS_COMPILER_ADAPTERS';

/** An adapter package as found, before its code is loaded. */
export interface AdapterManifest {
	/** The package's name, `@nstudio/nativescript-compiler-<framework>` (or legacy `@nativescript/compiler-<framework>`). */
	name: string;
	framework: string;
	version: string;
	/** The package's folder. */
	root: string;
	/** Found through $NS_COMPILER_ADAPTERS. */
	development: boolean;
	/** The adapter API it is written for (`nativescript.compilerAdapter.apiVersion`). */
	apiVersion: unknown;
	/** The compiler versions it is built for (its peer dependency), if it names them. */
	compilerRange: string | undefined;
	detect: AdapterDetect;
	/** Each framework package's versions the adapter is tested with. */
	testedVersions: Record<string, string>;
	/** Its entry module's `exports['.']` (or `main`). */
	exports: unknown;
}

let ownVersion: string | undefined;
/** This compiler's version. */
export function compilerVersion(): string {
	return (ownVersion ??= JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')).version);
}

/** The adapter package at `dir`; undefined for a folder that holds none. */
function manifestAt(dir: string, development: boolean): AdapterManifest | undefined {
	const pkg = readPackageJson(dir) as any;
	const block = pkg?.nativescript?.compilerAdapter;
	const framework = typeof pkg?.name === 'string' ? frameworkFromPackageName(pkg.name) : undefined;
	if (!block || !framework) return undefined;
	return {
		name: pkg.name,
		framework,
		version: String(pkg.version),
		root: resolve(dir),
		development,
		apiVersion: block.apiVersion,
		compilerRange: pkg.peerDependencies?.[COMPILER_NAME] ?? pkg.peerDependencies?.['@nativescript/compiler'],
		detect: block.detect ?? {},
		testedVersions: block.testedVersions ?? {},
		exports: pkg.exports?.['.'] ?? pkg.main,
	};
}

/** The adapters an app can build with: $NS_COMPILER_ADAPTERS's, then those the app's package.json lists, one per framework. */
export function availableAdapters(app: string): AdapterManifest[] {
	const found = new Map<string, AdapterManifest>();
	const add = (m: AdapterManifest | undefined) => {
		if (m && !found.has(m.framework)) found.set(m.framework, m);
	};
	const override = process.env[ADAPTERS_OVERRIDE];
	if (override) {
		if (!existsSync(override) || !statSync(override).isDirectory()) throw new Error(`${ADAPTERS_OVERRIDE}=${override}: no such folder (it names a folder of adapter packages, one per subfolder)`);
		for (const d of readdirSync(override).sort()) add(manifestAt(join(override, d), true));
	}
	for (const name of Object.keys(collectDependencies(app))
		.filter((n) => frameworkFromPackageName(n) !== undefined)
		.sort()) {
		const dir = installedPackageDir(app, name);
		if (dir) add(manifestAt(dir, false));
	}
	return [...found.values()];
}

/** The command installing a framework's first-party adapter at this compiler's version. */
function installCommand(adapter: string): string {
	return `npm i -D ${adapter}@${compilerVersion()}`;
}

/** The adapter of a framework among those found; throws, naming what to install, when there is none. */
export function adapterOf(framework: string, adapters: readonly AdapterManifest[]): AdapterManifest {
	const found = adapters.find((a) => a.framework === framework);
	if (found) return found;
	const pkg = FIRST_PARTY_ADAPTERS[framework]?.package ?? `${PREFIX}${framework}`;
	// A checkout of the compiler is a development build: its adapters come from beside it rather than from npm.
	const checkout = !realpathSync(PACKAGE).split(sep).includes('node_modules');
	throw new Error(`the app is written with ${framework}, and building it needs the compiler's ${framework} adapter, ${pkg}, which is not installed: ${installCommand(pkg)}` + (checkout ? ` (or set ${ADAPTERS_OVERRIDE} to a folder of adapter packages)` : ''));
}

/** Whether an adapter can be loaded by this compiler: its API, the compiler versions it is built for, its TypeScript. */
function checkAdapter(m: AdapterManifest): void {
	const version = compilerVersion();
	const reinstall = `install the ${m.name} released with this compiler: ${installCommand(m.name)}`;
	if (m.apiVersion !== ADAPTER_API_VERSION) {
		throw new Error(`${m.name} ${m.version} (${m.root}) is written for compiler adapter API ${m.apiVersion ?? '(none)'}, and this ${COMPILER_NAME} ${version} reads API ${ADAPTER_API_VERSION}: ${reinstall}`);
	}
	if (!m.development && !(m.compilerRange !== undefined && satisfies(version, m.compilerRange))) {
		throw new Error(`${m.name} ${m.version} (${m.root}) is built for ${COMPILER_NAME} ${m.compilerRange ?? '(none named in its peerDependencies)'}, and this is ${version}: ${reinstall}`);
	}
	// One that loads a TypeScript of its own (rather than `CoreApi.ts`) works with it on the compiler's syntax trees and
	// checker, whose enums a TypeScript of another minor version numbers differently.
	const pkg = readPackageJson(m.root) as any;
	if (!pkg?.dependencies?.typescript && !pkg?.peerDependencies?.typescript) return;
	let theirs: string | undefined;
	try {
		theirs = JSON.parse(readFileSync(createRequire(join(m.root, 'package.json')).resolve('typescript/package.json'), 'utf8')).version;
	} catch {}
	const minor = (v: string) => v.split('.').slice(0, 2).join('.');
	if (theirs !== undefined && minor(theirs) !== minor(ts.version)) {
		throw new Error(`${m.name} ${m.version} (${m.root}) loads TypeScript ${theirs}, and this ${COMPILER_NAME} runs ${ts.version}: an adapter works on the compiler's syntax trees, so both need TypeScript ${minor(ts.version)}`);
	}
}

/**
 * The entry module of an adapter: its TypeScript (`exports['.'].source`) where Node strips types (outside node_modules,
 * on a Node that strips them), else its JavaScript.
 */
export function adapterEntry(m: AdapterManifest): string {
	const e = m.exports as any;
	const js = typeof e === 'string' ? e : (e?.import ?? e?.default);
	const source = typeof e === 'object' && e !== null ? e.source : undefined;
	const typescriptRuns = !!(process.features as { typescript?: unknown }).typescript && !realpathSync(m.root).split(sep).includes('node_modules');
	const file = (typescriptRuns && source) || js || source;
	if (typeof file !== 'string') throw new Error(`${m.name} (${m.root}) names no entry module (exports['.'])`);
	const full = resolve(m.root, file);
	if (!existsSync(full)) throw new Error(`${m.name} (${m.root}) has no ${file}${file === js && source ? ': build it' : ''}`);
	return full;
}

/** This compiler's functions and a build's state, as an adapter is given them. */
export function coreApi(build: BuildContext): CoreApi {
	return {
		apiVersion: ADAPTER_API_VERSION,
		ts,
		scopeTemplate,
		rewrite,
		canonical,
		ELEMENTS,
		MODELS,
		rowTemplates,
		foldPlatform: (text, fileName, platform, modulesDir) => foldPlatform(text, fileName, platform, modulesDir, build.defines),
		packageOf,
		stubbedPlugins: build.stubbedPlugins,
		isCoreDeclaration,
		isAsync,
		adapterRuntimeFile: (file) => build.adapter.runtimeFile(file),
		swift: { ident: swiftIdent, isOptional, isFunctionType: swiftFunctionType, tryIf: (throws, code) => (throws ? `try ${code}` : code), NONISOLATED_DEINIT, string: swiftString },
		kotlin: { ident: kotlinIdent, isNullable, isFunctionType: kotlinFunctionType, string: kotlinString },
	};
}

/** An adapter's code, checked against this compiler and given its functions, reading `build`'s state (`coreApi`). */
export async function loadAdapter(m: AdapterManifest, build: BuildContext = new BuildContext(), core: CoreApi = coreApi(build)): Promise<FrameworkAdapter> {
	checkAdapter(m);
	const adapter = ((await import(pathToFileURL(adapterEntry(m)).href)) as { default: (core: CoreApi) => FrameworkAdapter }).default(core);
	if (adapter.apiVersion !== ADAPTER_API_VERSION) throw new Error(`${m.name} ${m.version} (${m.root}) is written for adapter API ${adapter.apiVersion}; this ${COMPILER_NAME} has ${ADAPTER_API_VERSION}`);
	if (adapter.name !== m.framework) throw new Error(`${m.name} (${m.root}) is the adapter of ${adapter.name}, not of ${m.framework}`);
	return adapter;
}

/**
 * The adapter of a framework (`detectFramework`'s name) among those available to `app` (by default the working
 * folder), or null for `core` (XML and TypeScript), which needs none.
 */
export async function frameworkAdapter(framework: string, app: string = process.cwd(), build: BuildContext = new BuildContext()): Promise<FrameworkAdapter | null> {
	return framework === 'core' ? null : loadAdapter(adapterOf(framework, availableAdapters(app)), build);
}
