import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { foldPlatform, type Platform } from './platform.ts';
import { desugarConstructorFactories } from './constructor-factories.ts';
import { desugarClassMixins } from './class-mixins.ts';
import { expandImportMetaGlob } from './glob.ts';
import { NO_VITE_PLUGINS, type ViteAppPlugins } from './vite-plugins.ts';
import { NATIVE_CONTROLLERS, NATIVE_VIEWS, nativeViewOf } from './core-facts.ts';
import type { PluginSources } from '../plugins/source.ts';
import { packageOf, runtimeFile } from '../plugins/resolve.ts';
import { localFilePackages } from '../targets/resources.ts';
import { NATIVE_VIEWS_ANDROID } from '../kotlin/core-api.ts';
import { BuildContext } from './build-context.ts';
import { compiledEnv } from './env.ts';

/**
 * The release build's own primitives, which front ends' sources import beside their framework's modules (the
 * adapter's shims). Only their types matter here: the translator recognizes the calls (`$signal`, `$writable`,
 * `$state`, `$navigateTo`) and emits Swift for them.
 */
const SHIMS: Record<string, string> = {
	'@nativescript/release': `
    export interface Sig<T> { value: T }
    export declare function $signal<T>(value: T): Sig<T>;
    /** Deeply reactive: arrays and objects it holds notify on mutation. */
    export interface DeepRef<T> { value: T }
    export declare function $ref<T>(value: T): DeepRef<T>;
    import type { ItemEventData, PanGestureEventData, PinchGestureEventData, PropertyChangeData, RotationGestureEventData, SwipeGestureEventData, TouchGestureEventData, Pointer as CorePointer } from '@nativescript/core';
    /** A template handler's \$event: whichever of core's event types the handler declares. */
    export type EventData = ItemEventData & PanGestureEventData & PinchGestureEventData & PropertyChangeData & RotationGestureEventData & SwipeGestureEventData & TouchGestureEventData & { value: any; item: any; target?: any; currentTarget?: any; preventDefault?(): void; stopPropagation?(): void };
    export type Pointer = CorePointer;
    export declare function $navigate(page: () => any): void;
    export interface WritableSignal<T> { (): T; set(value: T): void; update(fn: (value: T) => T): void; $write(value: T | ((previous: T) => T)): void }
    export declare function $writable<T>(value: T): WritableSignal<T>;
    /** Component state its handlers read as of the last commit. */
    export declare function $state<T>(signal: WritableSignal<T>): WritableSignal<T>;
    export declare function $navigateTo(component: any, options?: { props?: Record<string, any> }): void;
    /** An event a component emits, to the listener its parent gives. */
    export interface OutputEmitterRef<T> { emit(value: T): void }
    export declare function output<T = void>(options?: any): OutputEmitterRef<T>;
  `,
};

/** Globals NativeScript provides that neither the ES library nor core's declarations type. */
const GLOBALS = `
  declare var console: {
    log(...data: any[]): void; info(...data: any[]): void; warn(...data: any[]): void; error(...data: any[]): void; debug(...data: any[]): void;
    time(label?: string): void; timeLog(label?: string, ...data: any[]): void; timeEnd(label?: string): void;
    count(label?: string): void; countReset(label?: string): void; assert(condition?: boolean, ...data: any[]): void; dir(item?: any, options?: any): void; trace(...data: any[]): void;
    dirxml(...data: any[]): void; group(...label: any[]): void; groupCollapsed(...label: any[]): void; groupEnd(): void; table(tabularData?: any, properties?: string[]): void;
  };
  declare function queueMicrotask(callback: () => void): void;
  // Core declares the delay required; JavaScript defaults it to 0.
  declare function setTimeout(callback: (...args: any[]) => void): number;
  declare function setInterval(callback: (...args: any[]) => void): number;
  /** What \`types: ["node"]\` gives an app for the timers' results. */
  declare namespace NodeJS { type Timeout = number; type Timer = number; type Immediate = number }
  declare var global: typeof globalThis;
  declare function requestAnimationFrame(callback: (frameTime: number) => void): number;
  declare function cancelAnimationFrame(id: number | undefined): void;
  declare function __nsRegisterAppModules(modules: any): void;
  declare function __nsClass(make: () => any): any;
  declare function __nsRegisterCompiledBinding(key: string, binding: any): void;
  declare function __nsRegisterPage(file: string, factory: ((exports: any, moduleName: string, xmlModule: string) => any) | undefined, codeModule?: string, codeExports?: any): void;
  declare function atob(data: string): string;
  declare function btoa(data: string): string;
  interface TextEncoder { readonly encoding: string; encode(input?: string): Uint8Array<ArrayBuffer> }
  declare var TextEncoder: { prototype: TextEncoder; new (): TextEncoder };
  interface TextDecoderOptions { fatal?: boolean; ignoreBOM?: boolean }
  interface TextDecoder { readonly encoding: string; readonly fatal: boolean; readonly ignoreBOM: boolean; decode(input?: AllowSharedBufferSource): string }
  declare var TextDecoder: { prototype: TextDecoder; new (label?: string, options?: TextDecoderOptions): TextDecoder };
  type AllowSharedBufferSource = ArrayBufferLike | ArrayBufferView;
  type BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer;
  interface Algorithm { name: string }
  type AlgorithmIdentifier = Algorithm | string;
  type HashAlgorithmIdentifier = AlgorithmIdentifier;
  type BigInteger = Uint8Array<ArrayBuffer>;
  type KeyType = 'private' | 'public' | 'secret';
  type KeyUsage = 'decrypt' | 'deriveBits' | 'deriveKey' | 'encrypt' | 'sign' | 'unwrapKey' | 'verify' | 'wrapKey';
  interface KeyAlgorithm { name: string }
  interface HmacKeyGenParams extends Algorithm { hash: HashAlgorithmIdentifier; length?: number }
  interface RsaKeyGenParams extends Algorithm { modulusLength: number; publicExponent: BigInteger }
  interface RsaHashedKeyGenParams extends RsaKeyGenParams { hash: HashAlgorithmIdentifier }
  interface RsaOaepParams extends Algorithm { label?: BufferSource }
  interface CryptoKey { readonly algorithm: KeyAlgorithm; readonly extractable: boolean; readonly type: KeyType; readonly usages: KeyUsage[] }
  interface CryptoKeyPair { privateKey: CryptoKey; publicKey: CryptoKey }
  interface SubtleCrypto {
    digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
    generateKey(algorithm: RsaHashedKeyGenParams, extractable: boolean, keyUsages: ReadonlyArray<KeyUsage>): Promise<CryptoKeyPair>;
    generateKey(algorithm: HmacKeyGenParams, extractable: boolean, keyUsages: ReadonlyArray<KeyUsage>): Promise<CryptoKey>;
    sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
    verify(algorithm: AlgorithmIdentifier, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean>;
    encrypt(algorithm: AlgorithmIdentifier | RsaOaepParams, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
    decrypt(algorithm: AlgorithmIdentifier | RsaOaepParams, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  }
  interface Crypto {
    readonly subtle: SubtleCrypto;
    getRandomValues<T extends ArrayBufferView | null>(array: T): T;
    randomUUID(): \`\${string}-\${string}-\${string}-\${string}-\${string}\`;
  }
  declare var crypto: Crypto;
  interface DOMException extends Error {
    readonly code: number;
    readonly message: string;
    readonly name: string;
  }
  declare var DOMException: { prototype: DOMException; new (message?: string, name?: string): DOMException };
  interface Performance {
    now(): number;
    readonly timeOrigin: number;
  }
  declare var performance: Performance;
  interface Storage {
    readonly length: number;
    clear(): void;
    getItem(key: string): string | null;
    key(index: number): string | null;
    removeItem(key: string): void;
    setItem(key: string, value: string): void;
    [name: string]: any;
  }
  declare var localStorage: Storage;
  declare var sessionStorage: Storage;
  interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
  }
`;

/**
 * The worker API Android's kit runs (kit-android `runtime/Workers.kt`): workers compiled with the app, a transfer list copied.
 * Both platforms type it, so an iOS build refuses it by name (semantics/platform-globals.ts) rather than failing to type-check.
 */
const WORKER_GLOBALS = `
  interface MessageEvent<T = any> { readonly data: T }
  interface ErrorEvent { readonly message: string }
  interface Worker {
    onmessage: ((ev: MessageEvent) => any) | null;
    onerror: ((ev: ErrorEvent) => any) | null;
    postMessage(message: any, transfer?: any[]): void;
    terminate(): void;
  }
  declare var Worker: { prototype: Worker; new (scriptURL: string | URL): Worker };
  interface URL { readonly href: string; toString(): string }
  declare var URL: { prototype: URL; new (url: string | URL, base?: string | URL): URL };
  declare function postMessage(message: any, transfer?: any[]): void;
  declare function close(): void;
`;

/** Minimal non-DOM globals added when the app's tsconfig includes `lib: ["dom"]` (which already declares console, URL, Worker, crypto, etc.). */
const DOM_COMPAT_GLOBALS = `
  declare function setTimeout(callback: (...args: any[]) => void): number;
  declare function setInterval(callback: (...args: any[]) => void): number;
  declare namespace NodeJS { type Timeout = number; type Timer = number; type Immediate = number }
  declare var global: typeof globalThis;
  declare function cancelAnimationFrame(id: number | undefined): void;
  declare function __nsRegisterAppModules(modules: any): void;
  declare function __nsClass(make: () => any): any;
  declare function __nsRegisterCompiledBinding(key: string, binding: any): void;
  declare function __nsRegisterPage(file: string, factory: ((exports: any, moduleName: string, xmlModule: string) => any) | undefined, codeModule?: string, codeExports?: any): void;
  interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
  }
`;

/** The platform's native API typings, as an app's `references.d.ts` includes them. */
const PLATFORM_TYPES: Record<Platform, string> = { ios: '@nativescript/types-ios/index.d.ts', android: '@nativescript/types-android/index.d.ts' };

/** The nearest `node_modules` above `from` that has @nativescript/core. */
export function nodeModules(from: string): string {
	for (let dir = from; ; dir = dirname(dir)) {
		if (existsSync(resolve(dir, 'node_modules/@nativescript/core/package.json'))) return resolve(dir, 'node_modules');
		if (dirname(dir) === dir) throw new Error(`${from}: no node_modules with @nativescript/core above it`);
	}
}

export interface Program {
	program: ts.Program;
	checker: ts.TypeChecker;
	/** The app's files and the components' virtual files, in translation order. */
	files: ts.SourceFile[];
	/** The plugins' source files the program reached, beside the app's. */
	pluginFiles: string[];
	/** The file a module specifier resolved to from a file, as the program resolved it. */
	resolved: (containing: string, specifier: string) => string | undefined;
	/** The app's own configuration checks without strictNullChecks. */
	lenient: boolean;
	/** The app's configuration assigns class fields rather than defining them (`useDefineForClassFields` off). */
	assignsFields: boolean;
}

/**
 * Packages whose imports stay on their declarations: core is NativeScriptKit,
 * the framework's are its adapter's, and the rest are typings or tooling.
 */
const NOT_PLUGINS = /^(@nativescript\/(core|types|types-ios|types-android|types-minimal|webpack|vite|tailwind|android|ios)|tslib|typescript|vite)$/;

/**
 * Rewrites ES `export default <expr>;` (`ts.ExportAssignment`) into `export { <id> as default };` (introducing
 * `const __nsDefault = <expr>;` when `<expr>` is not already a plain identifier) so TypeScript's `getAliasedSymbol`
 * resolves default and namespace imports directly to a real declaration in both Swift and Kotlin backends.
 */
function desugarDefaultExport(code: string, name: string): string {
	// Desugar standard UMD `if (typeof module !== 'undefined' && module.exports) { module.exports = X; }` to an ES default export.
	if (/\.m?js$/.test(name) && code.includes('module.exports') && !/\brequire\s*\(/.test(code)) {
		code = code.replace(
			/if\s*\(\s*typeof\s+module\s*!==?\s*['"]undefined['"]\s*&&\s*module\.exports\s*\)\s*(?:\{\s*module\.exports\s*=\s*([^;{}]+?);?\s*\}|module\.exports\s*=\s*([^;]+?);?)/g,
			(_, a: string | undefined, b: string | undefined) => {
				const rhs = (a ?? b ?? '').trim();
				return /^[A-Za-z_$][\w$]*$/.test(rhs) ? `export { ${rhs} as default };` : `const __nsDefault = ${rhs}; export { __nsDefault as default };`;
			},
		);
	}
	if (!code.includes('export default')) return code;
	const sf = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true);
	const edits: { start: number; end: number; text: string }[] = [];
	for (const st of sf.statements) {
		if (!ts.isExportAssignment(st) || st.isExportEquals) continue;
		const exprText = code.slice(st.expression.getStart(sf), st.expression.getEnd());
		if (ts.isIdentifier(st.expression)) {
			edits.push({ start: st.getStart(sf), end: st.getEnd(), text: `export { ${exprText} as default };` });
		} else {
			edits.push({ start: st.getStart(sf), end: st.getEnd(), text: `const __nsDefault = ${exprText}; export { __nsDefault as default };` });
		}
	}
	if (!edits.length) return code;
	let out = code;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}

/**
 * A program over the app's modules and the components' virtual classes,
 * typed by the real ES2022 library, @nativescript/core's own declarations
 * and the platform's native API typings. `appLenient` says whether the app's
 * own configuration is non-strict where no tsconfig.json of its says (a test's). `build`: the framework adapter's module
 * rules, the plugins built as stand-ins and the bundler's defines it is read with (by default, none).
 */
export function createProgram(roots: string[], virtual: Map<string, string>, platform: Platform = 'ios', modulesDir?: string, plugins?: PluginSources, declarations: string[] = [], replacements: Record<string, string> = {}, overrides: ts.CompilerOptions = {}, aliased: (specifier: string, importer?: string) => string | undefined = () => undefined, appLenient?: boolean, build: BuildContext = new BuildContext(), vitePlugins: ViteAppPlugins = NO_VITE_PLUGINS): Program {
	const shimPath = (m: string) => `/__shims__/${m.replace(/[@/]/g, '_')}.d.ts`;
	const rules = build.adapter.rules;
	const notPlugin = (pkg: string) => NOT_PLUGINS.test(pkg) || build.adapter.isFrameworkPackage(pkg) || build.stubbedPlugins.has(pkg);
	// A build that compiles packages from their source compiles some packages the framework's adapter otherwise shims.
	const shims: Record<string, string> = { ...SHIMS, ...rules.shims, ...(plugins ? {} : rules.fallbackShims) };
	const substituted = new Set(Object.values(rules.substitutions ?? {}).map((s) => s.file));
	const files = new Map<string, string>(virtual);
	for (const [m, text] of Object.entries(shims)) files.set(shimPath(m), text);
	const hasDom = appIncludesDomLib(roots[0] ?? [...virtual.keys()][0]);
	files.set('/__shims__/globals.d.ts', hasDom ? DOM_COMPAT_GLOBALS : GLOBALS + WORKER_GLOBALS);
	const modules = modulesDir ?? nodeModules(dirname([...roots, ...virtual.keys()][0]));
	const platformTypes = resolve(modules, PLATFORM_TYPES[platform]);
	if (!existsSync(platformTypes)) throw new Error(`${platformTypes} is missing: install ${PLATFORM_TYPES[platform].split('/index')[0]}`);

	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		// Of ES2024, only what both runtimes implement (groupBy, withResolvers): the rest would type-check and then not translate.
		strict: true,
		lib: ['lib.es2023.d.ts', 'lib.es2024.object.d.ts', 'lib.es2024.collection.d.ts', 'lib.es2024.promise.d.ts', ...(hasDom ? ['lib.dom.d.ts', 'lib.dom.iterable.d.ts'] : [])],
		types: [],
		skipLibCheck: true,
		experimentalDecorators: true,
		noEmit: true,
		allowJs: true,
		allowImportingTsExtensions: true,
		jsx: ts.JsxEmit.Preserve,
		// Each file is a module, as the bundler makes it: a file without imports does not merge into the platform's globals (`double`, `long`).
		moduleDetection: ts.ModuleDetectionKind.Force,
		// A lenient app's caught values are `any`, as its own build types them.
		...(appStrictness(roots[0] ?? [...virtual.keys()][0]) ? { useUnknownInCatchVariables: false } : {}),
		...overrides,
	};
	const host = ts.createCompilerHost(options);
	const readLib = host.getSourceFile.bind(host);
	// The app's declarations may reach `@nativescript/types`, which declares both platforms, as the app's own build reads them:
	// the other platform's types name what code for that platform holds (`signal<android.view.View | null>`).
	const pluginFiles = new Set<string>();
	const extraRoots = new Set<string>();
	const isSource = (name: string) => !name.startsWith('/__shims__/') && !name.endsWith('.d.ts') && (build.adapter.isRuntimeSource(name) || !name.includes('/node_modules/'));
	const isApp = (name: string) => isSource(name) && !pluginFiles.has(name);
	// The app's declarations are read for the native APIs they declare: the frameworks' own typings they reference would replace the shims.
	const appTypings = new Set(declarations);
	const nativeReferences = (text: string, file: string) =>
		text.replace(/^\/\/\/\s*<reference\s+(path|types)="([^"]*)"\s*\/>.*$/gm, (line, kind: string, ref: string) => {
			const target = resolve(dirname(file), ref);
			const pkg = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(target)?.[1].replace(/\\/g, '/');
			return kind === 'path' && (!pkg || pkg.startsWith('@nativescript/types') || !notPlugin(pkg)) ? line : '';
		});
	// TypeScript loads a file's `/// <reference path>` sources (a package's index referencing its operators barrel) before resolving
	// the file's imports, so a plugin's referenced source is claimed here or its imports resolve as the app's.
	const declaredExports = (name: string, code: string) => {
		if (!pluginFiles.has(name)) return code;
		for (const [, ref] of code.matchAll(/^\/\/\/\s*<reference\s+path="([^"]*\.tsx?)"\s*\/>/gm)) if (!ref.endsWith('.d.ts')) pluginFiles.add(resolve(dirname(name), ref));
		return pluginDeclaredExports(code, name, platform);
	};
	const appRoot = plugins?.options?.app ? resolve(plugins.options.app) : null;
	const rootSet = new Set(roots);
	host.getSourceFile = (name, version, onError) => {
		const text = files.get(name) ?? (isSource(name) && existsSync(name) ? readFileSync(name, 'utf8') : appTypings.has(name) ? nativeReferences(readFileSync(name, 'utf8'), name) : undefined);
		if (text === undefined) {
			// A package's own TypeScript (or pure-JS ESM) source.
			if (!/\.(tsx?|m?js)$/.test(name) || name.endsWith('.d.ts') || !existsSync(name)) return readLib(name, version, onError);
			const raw = desugarDefaultExport(expandImportMetaGlob(readFileSync(name, 'utf8'), name, appRoot), name);
			if (/\.m?js$/.test(name)) {
				const typedefs = pluginJsTypedefs(name, plugins);
				return ts.createSourceFile(name, typedefs ? `${raw}\n${typedefs}\n` : raw, version, true, ts.ScriptKind.JS);
			}
			return ts.createSourceFile(name, desugarClassMixins(desugarConstructorFactories(declaredExports(name, raw), name), name), version, true);
		}
		const transformed = !name.startsWith('/__shims__/') && !name.startsWith('/__raw__/') && !name.startsWith('/__vite__/') && !name.endsWith('.d.ts') ? vitePlugins.transform(text, name) : text;
		const expanded = !name.startsWith('/__shims__/') && !name.endsWith('.d.ts') ? desugarDefaultExport(expandImportMetaGlob(transformed, name, appRoot), name) : transformed;
		const code = /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? desugarClassMixins(desugarConstructorFactories(declaredExports(name, expanded), name), name) : expanded;
		return ts.createSourceFile(name, isSource(name) ? foldPlatform(code, name, platform, modules, build.defines) : code, version, true);
	};
	const fileExists = host.fileExists.bind(host);
	host.fileExists = (name) => files.has(name) || fileExists(name);
	const readFile = host.readFile.bind(host);
	host.readFile = (name) => files.get(name) ?? readFile(name);
	const resolutions = new Map<string, string>();
	// A plugin's augmentations of other packages (`declare module '@nativescript/firebase-core'`), which its source keeps in
	// the declarations beside it (`index.d.ts`), apply as its published typings apply them.
	const augmenting = new Map<string, string | null>();
	const augmentations = (source: string) => {
		if (!augmenting.has(source)) {
			const beside = source.replace(/(\.(ios|android))?\.tsx?$/, '.d.ts');
			augmenting.set(source, beside !== source && existsSync(beside) && /^\s*declare module ['"]/m.test(readFileSync(beside, 'utf8')) ? beside : null);
		}
		return augmenting.get(source);
	};
	host.resolveModuleNameLiterals = (literals, containing) =>
		literals.map((lit) => {
			const r = resolveLiteral(lit, containing);
			if (r.resolvedModule) resolutions.set(`${containing}\0${lit.text}`, r.resolvedModule.resolvedFileName);
			return r;
		});
	const localPackages = appRoot ? localFilePackages(appRoot) : new Map<string, string>();
	const resolveLiteral = (lit: ts.StringLiteralLike, containing: string): ts.ResolvedModuleWithFailedLookupLocations => {
		{
			// Vite `?raw` asset import (`import css from 'pkg/file.css?raw'` or `'./example.ts?raw'`): inline file contents as default export.
			if (lit.text.endsWith('?raw')) {
				const rawSpec = lit.text.slice(0, -4);
				const aliasedRaw = isSource(containing) ? aliased(rawSpec, containing) : undefined;
				const candidate = aliasedRaw ?? (rawSpec.startsWith('.') || isAbsolute(rawSpec) ? resolve(dirname(containing), rawSpec) : resolve(modules, rawSpec));
				if (existsSync(candidate)) {
					const hash = createHash('sha256').update(candidate).digest('hex').slice(0, 16);
					const rawPath = `/__raw__/${hash}.ts`;
					if (!files.has(rawPath)) files.set(rawPath, `const __nsRaw_${hash}: string = ${JSON.stringify(readFileSync(candidate, 'utf8'))};\nexport { __nsRaw_${hash} as default };\n`);
					pluginFiles.add(rawPath);
					return { resolvedModule: { resolvedFileName: rawPath, extension: ts.Extension.Ts } };
				}
			}
			// JSON module import (`import data from 'pkg/data.json'` or `'./data.json'`): parse at runtime via JSON.parse so large data maps don't explode into native struct definitions.
			if (lit.text.endsWith('.json') && !containing.startsWith('/__shims__/')) {
				const aliasedJson = isSource(containing) ? aliased(lit.text, containing) : undefined;
				let candidate = aliasedJson ?? (lit.text.startsWith('.') || isAbsolute(lit.text) ? resolve(dirname(containing), lit.text) : resolve(modules, lit.text));
				if (!existsSync(candidate) && !lit.text.startsWith('.') && !isAbsolute(lit.text)) {
					for (let dir = dirname(containing); ; dir = dirname(dir)) {
						const probe = resolve(dir, 'node_modules', lit.text);
						if (existsSync(probe)) {
							candidate = probe;
							break;
						}
						if (dirname(dir) === dir) break;
					}
				}
				if (existsSync(candidate)) {
					const hash = createHash('sha256').update(candidate).digest('hex').slice(0, 16);
					const jsonPath = `/__json__/${hash}.ts`;
					if (!files.has(jsonPath)) files.set(jsonPath, `const __nsJson_${hash}: any = JSON.parse(${JSON.stringify(readFileSync(candidate, 'utf8'))});\nexport { __nsJson_${hash} as default };\n`);
					pluginFiles.add(jsonPath);
					return { resolvedModule: { resolvedFileName: jsonPath, extension: ts.Extension.Ts } };
				}
			}
			// Custom Vite plugin `load(id)` hook for query-suffixed virtual modules (e.g. `.md?ns-analog-content`).
			const qIdx = lit.text.indexOf('?');
			if (qIdx > 0) {
				const baseSpec = lit.text.slice(0, qIdx);
				const query = lit.text.slice(qIdx);
				const resolvedBase = baseSpec.startsWith('.') || isAbsolute(baseSpec) ? resolve(dirname(containing), baseSpec) : (isSource(containing) ? aliased(baseSpec, containing) : undefined) ?? resolve(modules, baseSpec);
				const loaded = vitePlugins.load(resolvedBase + query);
				if (loaded !== undefined) {
					const hash = createHash('sha256').update(resolvedBase + query).digest('hex').slice(0, 16);
					const vPath = `/__vite__/${hash}.ts`;
					if (!files.has(vPath)) files.set(vPath, desugarDefaultExport(loaded, vPath));
					pluginFiles.add(vPath);
					return { resolvedModule: { resolvedFileName: vPath, extension: ts.Extension.Ts } };
				}
			}
			// The app's own tsconfig `paths` / Vite aliases (`~/app/x`), as its bundler resolves them: workspace sources outside node_modules share them.
			const aliasTarget = isSource(containing) ? aliased(lit.text, containing) : undefined;
			const m = aliasTarget ?? lit.text;
			const substitution = rules.substitutions && Object.hasOwn(rules.substitutions, m) && !replacements[m] ? rules.substitutions[m] : undefined;
			if (substitution && (plugins || !substitution.sourcesOnly)) {
				pluginFiles.add(substitution.file);
				return { resolvedModule: { resolvedFileName: substitution.file, extension: ts.Extension.Ts } };
			}
			if (substitution?.otherwise) return { resolvedModule: { resolvedFileName: shimPath(substitution.otherwise), extension: ts.Extension.Dts } };
			if (shims[m]) return { resolvedModule: { resolvedFileName: shimPath(m), extension: ts.Extension.Dts } };
			const stub = !m.startsWith('.') && !isAbsolute(m) ? build.pluginStubModules.get(packageOf(m)) : undefined;
			if (stub) {
				pluginFiles.add(stub);
				return { resolvedModule: { resolvedFileName: stub, extension: ts.Extension.Ts } };
			}
			// The build's own glue imports app modules by absolute path (`__elements.release.ts`).
			if (m.startsWith('.') || (isAbsolute(m) && !m.startsWith('/__shims__/'))) {
				const base = resolve(dirname(containing), m);
				const stem = base.replace(/\.m?js$/, '');
				// A platform's own file first, as NativeScript's bundler resolves `./x` to `x.ios.ts`.
				// A platform file importing its own module's name (`import type { HingeListener } from './hinge-tracker'` in
				// hinge-tracker.ios.ts) means the module's declarations: `x.d.ts`, else the platforms' shared `x.ts`.
				const typeOnly = (ts.isImportDeclaration(lit.parent) && !!lit.parent.importClause?.isTypeOnly) || (ts.isExportDeclaration(lit.parent) && lit.parent.isTypeOnly);
				// A type-only import is TypeScript's, which reads `x.d.ts` beside the platforms' files; only the bundler picks `x.ios.ts`.
				const own = containing === `${stem}.${platform}.ts` || (typeOnly && existsSync(stem + '.d.ts'));
				const direct = /\.(tsx?|d\.ts)$/.test(base) ? [base] : [];
				const jsFallback = pluginFiles.has(containing) ? [...(/\.m?js$/.test(base) ? [base] : []), stem + '.js', stem + '.mjs', stem + '/index.js', stem + '/index.mjs'] : [];
				for (const candidate of own ? [...direct, stem + '.d.ts', stem + '.ts'] : [...direct, `${stem}.${platform}.ts`, stem + '.ts', stem + '.tsx', `${stem}/index.${platform}.ts`, stem + '/index.ts', ...jsFallback]) {
					if (files.has(candidate) || existsSync(candidate)) {
						if (candidate.endsWith('.d.ts')) return { resolvedModule: { resolvedFileName: candidate, extension: ts.Extension.Dts } };
						// A component file replaced by a compiled `.release.ts` virtual file must resolve to the virtual file everywhere so classes with private members stay nominally identical.
						const released = candidate.endsWith('.ts') && !candidate.endsWith('.release.ts') ? candidate.replace(/\.ts$/, '.release.ts') : undefined;
						if (released && virtual.has(released) && containing !== released) return { resolvedModule: { resolvedFileName: released, extension: ts.Extension.Ts } };
						// A plugin's own modules, a substitution's file, or a monorepo workspace library outside the app folder
						// (not already compiled as an app/component root) are compiled through closed-world reachability.
						const isCompiledRoot = rootSet.has(candidate) || virtual.has(candidate) || virtual.has(candidate.replace(/\.ts$/, '.release.ts'));
						if (!isCompiledRoot && (pluginFiles.has(containing) || substituted.has(candidate) || (aliasTarget && appRoot && !candidate.startsWith(appRoot + sep)))) pluginFiles.add(candidate);
						const extension = candidate.endsWith('.tsx') ? ts.Extension.Tsx : candidate.endsWith('.mjs') ? ts.Extension.Mjs : candidate.endsWith('.js') ? ts.Extension.Js : ts.Extension.Ts;
						return { resolvedModule: { resolvedFileName: candidate, extension } };
					}
				}
			}
			// A package the app replaces for the native build is the app's module.
			const replacement = !m.startsWith('.') && !m.startsWith('/') ? replacements[packageOf(m)] : undefined;
			if (replacement) return { resolvedModule: { resolvedFileName: replacement, extension: ts.Extension.Ts } };
			// A plugin is compiled from its source: an import that reaches its code resolves to the file it was built from,
			// from the app or from another plugin's source (one shipped in its package sits under node_modules).
			// A type-only import still resolves to the source where the file also imports values from the package: TypeScript resolves a specifier once per file.
			const valueImport = (st: ts.Statement) => ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === m;
			const typeOnly = !containing.startsWith('/__shims__/') && ts.isImportDeclaration(lit.parent) && !!lit.parent.importClause?.isTypeOnly && !(lit.parent.parent && ts.isSourceFile(lit.parent.parent) && lit.parent.parent.statements.some(valueImport));
			// A plugin's augmentation of another's module augments the module the program compiles: that package's source.
			const augments = ts.isModuleDeclaration(lit.parent) && lit.parent.name === lit && !!plugins?.all().some((p) => containing.startsWith(p.root + '/'));
			// Every import of `rxjs` (including `import type` and `.d.ts` files like `@angular/cdk`) must resolve to the same compiled `rxjs` source so Observable/OperatorFunction types match across the whole program.
			const sharedRxjs = m === 'rxjs' || m.startsWith('rxjs/');
			if (plugins && (isSource(containing) || pluginFiles.has(containing) || augments || containing.startsWith('/__shims__/') || (containing.endsWith('.d.ts') && sharedRxjs)) && !m.startsWith('.') && !m.startsWith('/') && !notPlugin(packageOf(m)) && (!typeOnly || sharedRxjs)) {
				const js = runtimeFile(m, modules, platform, localPackages);
				if (js) {
					plugins.get(js.packageDir);
					const source = plugins.sourceOf(js.file);
					// An entry whose components the front end compiles from their source keeps its declarations: claiming it
					// would compile those components' files a second time, as plugin modules.
					const library = !!source && !!rules.isLibraryEntry?.(m, source, [...virtual.keys()]);
					// The entry's own declarations are the app's modules when the front end compiles their file with the app's.
					if (source && roots.includes(source)) return { resolvedModule: { resolvedFileName: source, extension: ts.Extension.Ts } };
					if (source && !library) {
						pluginFiles.add(source);
						for (const t of plugins.get(js.packageDir).typings) extraRoots.add(t);
						const beside = augmentations(source);
						if (beside) extraRoots.add(beside);
						const extension = source.endsWith('.tsx') ? ts.Extension.Tsx : source.endsWith('.mjs') ? ts.Extension.Mjs : source.endsWith('.js') ? ts.Extension.Js : ts.Extension.Ts;
						return { resolvedModule: { resolvedFileName: source, extension } };
					}
				}
			}
			// Type-only imports of local `file:` packages (outside node_modules): resolve to the package's typings.
			if (!m.startsWith('.') && !m.startsWith('/')) {
				const localDir = localPackages.get(packageOf(m));
				if (localDir) {
					const deep = m.slice(packageOf(m).length).replace(/^\//, '');
					const target = deep ? resolve(localDir, deep) : resolve(localDir, 'index');
					for (const dts of [target + '.d.ts', resolve(target, 'index.d.ts')]) {
						if (existsSync(dts)) return { resolvedModule: { resolvedFileName: dts, extension: ts.Extension.Dts } };
					}
				}
			}
			// The shims import core's types from the app's node_modules; a plugin's source is typed against the app's packages.
			// Shims, plugins' sources and plugin components compiled with the app (outside its folder) import the app's packages.
			const from = containing.startsWith('/__shims__/') || pluginFiles.has(containing) || (!m.startsWith('.') && !containing.startsWith(dirname(modules) + '/')) ? resolve(modules, '..', 'index.ts') : containing;
			if (pluginFiles.has(containing) && m.startsWith('.')) return ts.resolveModuleName(m, containing, options, host);
			return ts.resolveModuleName(m, from, options, host);
		}
	};

	// An Android build types iOS API too, as an app's references to `@nativescript/types` do: code reaching it is code NativeScript runs only on iOS.
	// An iOS build types Android API where the app names it (`android.view.View` in code shared by both platforms), which is large to load otherwise.
	const namesAndroid = platform === 'ios' && roots.some((f) => /(?<![.\w$])(android|androidx|java|org)\.[a-z]/.test(ts.sys.readFile(f) ?? ''));
	const otherTypes = platform === 'android' || namesAndroid ? resolve(modules, PLATFORM_TYPES[platform === 'android' ? 'ios' : 'android']) : null;
	const rootNames = [...roots, ...virtual.keys(), '/__shims__/globals.d.ts', platformTypes, ...(otherTypes && existsSync(otherTypes) ? [otherTypes] : []), resolve(modules, '@nativescript/core/global-types.d.ts'), ...declarations];
	// A copy: a program keeps the array it is given, and a later program with equal root names reuses its files.
	let program = ts.createProgram([...rootNames], options, host);
	// A plugin's sources use frameworks the default typings leave out (CoreLocation): every framework's, where the package has them.
	const complete = platform === 'ios' ? resolve(dirname(platformTypes), 'complete.d.ts') : null;
	if (pluginFiles.size && complete && existsSync(complete)) extraRoots.add(complete);
	// A plugin's native API declarations (`typings/ios.d.ts`) are found as its sources are.
	if (extraRoots.size) {
		rootNames.push(...extraRoots);
		program = ts.createProgram(rootNames, options, host, program);
	}
	// `import * as fs from '@nativescript/core/file-system'` then `fs.knownFolders`: each member read as it would be imported by name.
	const named = coreNamespaceMembers(program, isSource);
	if (named.size) {
		for (const [name, text] of named) files.set(name, text);
		program = ts.createProgram(rootNames, options, host, program);
	}
	// kit-android does not compile core's fetch and XMLHttpRequest yet.
	const webGlobals = platform === 'ios' ? coreGlobalImports(program, (name) => isSource(name) || pluginFiles.has(name), modules) : new Map<string, string>();
	if (webGlobals.size) {
		for (const [name, text] of webGlobals) files.set(name, text);
		program = ts.createProgram(rootNames, options, host, program);
	}
	// `view.ios` is `any` in core's declarations: typed as the view's native class, everything read from it is typed too.
	const casts = nativeViewCasts(program, isSource, platform);
	if (casts.size) {
		for (const [name, text] of casts) files.set(name, text);
		program = ts.createProgram(rootNames, options, host, program);
	}
	// The build types the app strictly; an app whose own configuration is not strict is held only to what that configuration checks.
	const lenient = appLenient ?? appStrictness(roots[0] ?? [...virtual.keys()][0]);
	const strictOnly = new Set([
		2322, 2345, 2531, 2532, 2533, 2454, 2564, 2722, 7005, 7006, 7008, 7015, 7031, 7034, 7053, 18047, 18048, 18049,
		// What JavaScript defines that a lenient app's own build does not check: a key a spread overwrites, a `??` that never applies,
		// an operand always nullish, truthy or falsy.
		2783, 2869, 2871, 2872, 2873,
	]);
	// Strict narrowing leaves a lenient program's value `never` where its own build reads it as declared.
	const neverRead = (d: ts.Diagnostic) => d.code === 2339 && /on type 'never'/.test(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
	// Another platform's file (`x.android.ts`, which a declaration file may import for its types) is not part of this build.
	const otherPlatform = platform === 'android' ? /\.ios\.tsx?$/ : /\.android\.tsx?$/;
	// The app is checked with its own configuration's checks; the program it is translated from stays strict, for the types it gives.
	// Class fields as the app's target defines them: a field redeclaring a base accessor is an error only where fields are defined (ES2022).
	const defineFields = appDefinesFields(roots[0] ?? [...virtual.keys()][0]);
	const checks: ts.CompilerOptions = {
		...(lenient ? { strict: false, strictNullChecks: false, strictFunctionTypes: false, strictBindCallApply: false, strictPropertyInitialization: false, noImplicitAny: false, noImplicitThis: false, useUnknownInCatchVariables: false } : {}),
		...(defineFields === false ? { useDefineForClassFields: false } : {}),
	};
	const checked = Object.keys(checks).length ? ts.createProgram([...rootNames], { ...options, ...checks }, host, program) : program;
	// A plugin's components (`<package>/<framework>`) compile with the app's but are typed by the plugin's own build, against its declarations
	// rather than this platform's implementation.
	const pluginRoots = (plugins?.all() ?? []).map((p) => p.root + '/');
	const ofPlugin = (name: string) => pluginRoots.some((r) => name.startsWith(r));
	const diagnostics = ts.getPreEmitDiagnostics(checked).filter((d) => d.category === ts.DiagnosticCategory.Error && (!d.file || (isApp(d.file.fileName) && !ofPlugin(d.file.fileName) && !otherPlatform.test(d.file.fileName))) && !(lenient && (strictOnly.has(d.code) || neverRead(d))));
	if (diagnostics.length) {
		const text = ts.formatDiagnostics(diagnostics.slice(0, Number(compiledEnv('DIAGNOSTICS') ?? 12)), { getCanonicalFileName: (f) => f, getCurrentDirectory: () => '/', getNewLine: () => '\n' });
		throw new Error(`the app does not type-check as the release build sees it:\n${text}`);
	}
	const ordered = [...roots, ...virtual.keys(), ...pluginFiles].map((f) => program.getSourceFile(f)!).filter(Boolean);
	return { program, checker: program.getTypeChecker(), files: ordered, pluginFiles: [...pluginFiles], resolved: (containing, specifier) => resolutions.get(`${containing}\0${specifier}`), lenient, assignsFields: defineFields === false };
}

/**
 * Each app file's text with a core module imported whole (`import * as fs from '@nativescript/core/file-system'`) read
 * by member: `fs.knownFolders` is `__fs_knownFolders`, imported by name from the same module, as the kit has each
 * member under its own name, not the module's. A member written to (`ns.x = …`) stays as it is.
 */
function coreNamespaceMembers(program: ts.Program, isApp: (name: string) => boolean): Map<string, string> {
	const checker = program.getTypeChecker();
	const out = new Map<string, string>();
	const writes = (sf: ts.SourceFile, symbol: ts.Symbol | undefined): boolean => {
		let found = false;
		const visit = (n: ts.Node) => {
			if (found) return;
			if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === symbol && !ts.isVariableDeclaration(n.parent)) {
				const p = n.parent;
				found = (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken));
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		return found;
	};
	for (const sf of program.getSourceFiles()) {
		if (!isApp(sf.fileName)) continue;
		const edits: { at: number; end: number; text: string }[] = [];
		for (const st of sf.statements) {
			const clause = ts.isImportDeclaration(st) ? st.importClause : undefined;
			if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamespaceImport(clause.namedBindings)) continue;
			const spec = (st as ts.ImportDeclaration).moduleSpecifier;
			if (!ts.isStringLiteral(spec) || !/^@nativescript\/core(\/|$)/.test(spec.text)) continue;
			const ns = clause.namedBindings.name;
			const local = checker.getSymbolAtLocation(ns);
			const members = new Map<string, string>();
			const renamed: string[] = [];
			const aliasOf = (member: string) => members.get(member) ?? (members.set(member, `__${ns.text}_${member}`), members.get(member)!);
			const visit = (n: ts.Node) => {
				// `const { Color } = colorModule`: each name bound to the member imported by name.
				if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ts.isIdentifier(n.initializer) && checker.getSymbolAtLocation(n.initializer) === local && n.name.elements.every((el) => !el.dotDotDotToken && !el.initializer && ts.isIdentifier(el.name) && (!el.propertyName || ts.isIdentifier(el.propertyName)))) {
					const statement = n.parent.parent;
					// At the module's top, alone in its statement: the names imported, a class then the class itself, as an import is.
					if (ts.isVariableStatement(statement) && statement.parent === sf && statement.declarationList.declarations.length === 1) {
						for (const el of n.name.elements) renamed.push(`${((el.propertyName ?? el.name) as ts.Identifier).text} as ${(el.name as ts.Identifier).text}`);
						edits.push({ at: statement.getStart(), end: statement.getEnd(), text: ' '.repeat(statement.getEnd() - statement.getStart()) });
						return;
					}
					const bound = n.name.elements.map((el) => `${(el.name as ts.Identifier).text} = ${aliasOf(((el.propertyName ?? el.name) as ts.Identifier).text)}`);
					edits.push({ at: n.getStart(), end: n.getEnd(), text: bound.join(', ') });
					return;
				}
				// `var Color = colorModule.Color` at the module's top, never written again: imported under that name.
				if (ts.isVariableStatement(n) && n.parent === sf && n.declarationList.declarations.length === 1) {
					const d = n.declarationList.declarations[0];
					const init = d.initializer;
					if (ts.isIdentifier(d.name) && !d.type && init && ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression) && checker.getSymbolAtLocation(init.expression) === local && !n.modifiers?.length && !writes(sf, checker.getSymbolAtLocation(d.name))) {
						renamed.push(`${init.name.text} as ${d.name.text}`);
						edits.push({ at: n.getStart(), end: n.getEnd(), text: ' '.repeat(n.getEnd() - n.getStart()) });
						return;
					}
				}
				if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && checker.getSymbolAtLocation(n.expression) === local && !(ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
					const member = checker.getSymbolAtLocation(n.name);
					const target = member && member.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(member) : member;
					if (target && target.flags & ts.SymbolFlags.Value) {
						edits.push({ at: n.getStart(), end: n.getEnd(), text: aliasOf(n.name.text) });
						return;
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
			const names = [...[...members].map(([m, a]) => `${m} as ${a}`), ...renamed];
			if (names.length) edits.push({ at: st.getEnd(), end: st.getEnd(), text: `\nimport { ${names.join(', ')} } from ${spec.getText()};` });
		}
		if (!edits.length) continue;
		let text = sf.text;
		for (const e of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.text + text.slice(e.end);
		out.set(sf.fileName, text);
	}
	return out;
}

/**
 * The globals core installs from its own modules (`globals/index.ts`), and the types the web names beside them
 * (`type`): what the NativeScript runtime runs for `fetch` or `new XMLHttpRequest()` is core's module.
 */
const CORE_GLOBALS: [module: string, names: string[]][] = [
	// core's ui index sets them on `global`.
	['@nativescript/core/ui/dialogs', ['alert', 'confirm', 'prompt', 'login', 'action']],
	['@nativescript/core/fetch', ['fetch', 'Headers', 'Request', 'Response', 'type BodyInit', 'type HeadersInit', 'type RequestInfo', 'type RequestInit', 'type ResponseInit']],
	['@nativescript/core/xhr', ['XMLHttpRequest', 'FormData', 'Blob', 'File', 'FileReader']],
	['@nativescript/core/abortcontroller', ['AbortController', 'AbortSignal']],
];

/**
 * Each app file's text with the core globals it names (and does not declare or import) imported from core's
 * modules at its end, where the import moves no line: `fetch(…)` is then core's `fetch`, as the kit has it.
 * A core whose module has no typed declarations (a fetch before core's own TypeScript one) is left out.
 */
function coreGlobalImports(program: ts.Program, isApp: (name: string) => boolean, modules: string): Map<string, string> {
	const checker = program.getTypeChecker() as ts.TypeChecker & { resolveName(name: string, at: ts.Node, meaning: ts.SymbolFlags, excludeGlobals: boolean): ts.Symbol | undefined };
	const available = CORE_GLOBALS.filter(([m]) => existsSync(resolve(modules, m, 'index.d.ts')));
	const wanted = new Map(available.flatMap(([m, names]) => names.map((n) => [n.replace(/^type /, ''), { module: m, spec: n }] as const)));
	const K = ts.SyntaxKind;
	const named = (n: ts.Identifier): boolean => {
		const p = n.parent;
		if (ts.isPropertyAccessExpression(p)) return p.name === n;
		if (ts.isQualifiedName(p)) return p.right === n;
		if (ts.isBindingElement(p)) return p.propertyName === n;
		if ([K.PropertyAssignment, K.PropertyDeclaration, K.PropertySignature, K.MethodDeclaration, K.MethodSignature, K.GetAccessor, K.SetAccessor, K.EnumMember, K.JsxAttribute].includes(p.kind)) return (p as ts.NamedDeclaration).name === n;
		return [K.ImportSpecifier, K.ExportSpecifier, K.ImportClause, K.NamespaceImport, K.LabeledStatement, K.BreakStatement, K.ContinueStatement].includes(p.kind);
	};
	// Undeclared (the DOM's names, which the program's library leaves out), or declared in the global scope by a declaration file (including `declare global` in `@types/node`).
	const global = (s: ts.Symbol | undefined) => !s || (!(s.flags & ts.SymbolFlags.Alias) && (!(s as { parent?: ts.Symbol }).parent || (s as { parent?: ts.Symbol }).parent!.name === '__global') && !!s.declarations?.length && s.declarations.every((d) => d.getSourceFile().isDeclarationFile));
	const out = new Map<string, string>();
	for (const sf of program.getSourceFiles()) {
		if (!isApp(sf.fileName) || !wanted.size) continue;
		const used = new Map<string, Set<string>>();
		const visit = (n: ts.Node) => {
			if (ts.isImportDeclaration(n)) return;
			const want = ts.isIdentifier(n) ? wanted.get(n.text) : undefined;
			if (want && !named(n as ts.Identifier) && global(checker.resolveName((n as ts.Identifier).text, n, ts.SymbolFlags.Value | ts.SymbolFlags.Type, false))) {
				(used.get(want.module) ?? used.set(want.module, new Set()).get(want.module)!).add(want.spec);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		if (!used.size) continue;
		out.set(sf.fileName, sf.text + [...used].map(([m, names]) => `\nimport { ${[...names].join(', ')} } from '${m}';`).join(''));
	}
	return out;
}

/** Each app file's text with `x.ios` (x a core view) written `(x.ios as UILabel)`, or `x.android` as its Android class. */
function nativeViewCasts(program: ts.Program, isApp: (name: string) => boolean, platform: Platform): Map<string, string> {
	const members = platform === 'android' ? ['android', 'nativeView', 'nativeViewProtected'] : ['ios', 'nativeView', 'nativeViewProtected'];
	const table = platform === 'android' ? NATIVE_VIEWS_ANDROID : undefined;
	const checker = program.getTypeChecker();
	// The cast only where what the code reads of it is the native class's: a member newer than the typings
	// (`prominentTabIdentifier`), or a property called (`visibleCells()`), stays as untyped as core declares it.
	// A value given where a narrower type is declared (`let lb: LayoutBase = view.android`) stays untyped, as the app's assignment needs it.
	const fits = (n: ts.PropertyAccessExpression, native: string): boolean => {
		const cls = (checker as unknown as { resolveName(name: string, at: ts.Node, meaning: ts.SymbolFlags, excludeGlobals: boolean): ts.Symbol | undefined }).resolveName(native, n, ts.SymbolFlags.Type, false);
		if (!ts.isPropertyAccessExpression(n.parent) || n.parent.expression !== n) {
			const wanted = checker.getContextualType(n);
			if (!wanted || wanted.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
			// A qualified Java class (`android.view.View`): its namespaces' exports, one name at a time.
			const [first, ...rest] = native.split('.');
			let sym = rest.length ? (checker as unknown as { resolveName(name: string, at: ts.Node, meaning: ts.SymbolFlags, excludeGlobals: boolean): ts.Symbol | undefined }).resolveName(first, n, ts.SymbolFlags.Namespace, false) : cls;
			for (const part of rest) sym = sym && checker.getExportsOfModule(sym).find((s) => s.name === part);
			return !sym || checker.isTypeAssignableTo(checker.getDeclaredTypeOfSymbol(sym), wanted);
		}
		if (!cls) return false;
		const member = checker.getDeclaredTypeOfSymbol(cls).getProperty(n.parent.name.text);
		if (!member) return false;
		const called = ts.isCallExpression(n.parent.parent) && n.parent.parent.expression === n.parent;
		return !called || checker.getTypeOfSymbolAtLocation(member, n).getCallSignatures().length > 0;
	};
	const out = new Map<string, string>();
	for (const sf of program.getSourceFiles()) {
		if (!isApp(sf.fileName)) continue;
		const edits: { at: number; text: string }[] = [];
		const visit = (n: ts.Node) => {
			if (
				ts.isPropertyAccessExpression(n) &&
				members.includes(n.name.text) &&
				!ts.isAsExpression(n.parent) &&
				// An optional chain stays as written: a cast around it would stop TypeScript narrowing its root.
				!n.questionDotToken &&
				checker.getTypeAtLocation(n).flags & ts.TypeFlags.Any
			) {
				const native = nativeViewOf(checker, checker.getTypeAtLocation(n.expression), table ?? (n.name.text === 'ios' ? { ...NATIVE_VIEWS, ...NATIVE_CONTROLLERS } : NATIVE_VIEWS));
				if (native && fits(n, native)) edits.push({ at: n.getStart(), text: '(' }, { at: n.getEnd(), text: ` as ${native})` });
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		if (!edits.length) continue;
		let text = sf.text;
		for (const e of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.text + text.slice(e.at);
		out.set(sf.fileName, text);
	}
	return out;
}

const parseTsConfig = (file: string) => ts.getParsedCommandLineOfConfigFile(file, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });

/** The declaration files the app's tsconfig.json includes (its `references.d.ts`, its own typings), outside node_modules. */
export function appDeclarations(app: string): string[] {
	const file = resolve(app, 'tsconfig.json');
	if (!existsSync(file)) return [];
	const parsed = parseTsConfig(file);
	return (parsed?.fileNames ?? []).filter((f) => f.endsWith('.d.ts') && !f.includes('/node_modules/'));
}

/** Whether the app's configuration defines class fields (`useDefineForClassFields`, on from target ES2022); undefined where it has none. */
function appDefinesFields(from: string | undefined): boolean | undefined {
	if (!from) return undefined;
	for (let dir = dirname(from); dirname(dir) !== dir; dir = dirname(dir)) {
		const file = resolve(dir, 'tsconfig.json');
		if (!existsSync(file)) continue;
		const o = parseTsConfig(file)?.options ?? {};
		return o.useDefineForClassFields ?? (o.target ?? ts.ScriptTarget.ES5) >= ts.ScriptTarget.ES2022;
	}
	return undefined;
}

/** Whether the app's tsconfig.json (its `extends` followed) includes the DOM library (`"dom"`). */
function appIncludesDomLib(from: string | undefined): boolean {
	if (!from) return false;
	for (let dir = dirname(from); dirname(dir) !== dir; dir = dirname(dir)) {
		const file = resolve(dir, 'tsconfig.json');
		if (!existsSync(file)) continue;
		const libs = parseTsConfig(file)?.options?.lib ?? [];
		return libs.some((l) => /^lib\.dom(\.|$)/i.test(l) || /^dom$/i.test(l));
	}
	return false;
}

/** Whether the app's tsconfig.json (its `extends` followed) leaves strict checking off. */
function appStrictness(from: string | undefined): boolean {
	if (!from) return false;
	for (let dir = dirname(from); dirname(dir) !== dir; dir = dirname(dir)) {
		const file = resolve(dir, 'tsconfig.json');
		if (!existsSync(file)) continue;
		const o = parseTsConfig(file)?.options ?? {};
		return !(o.strict || o.strictNullChecks);
	}
	return false;
}

/**
 * For a pure-JS plugin compiled from `.js`/`.mjs` (e.g. `clsx`), exposes type/interface names declared in its
 * package `.d.ts` as JSDoc `@typedef` so `import { clsx, type ClassValue } from 'clsx'` type-checks.
 */
function pluginJsTypedefs(file: string, plugins?: PluginSources): string {
	const owner = plugins?.all().find((p) => file.startsWith(p.root + sep) || file.startsWith(p.dir + sep));
	if (!owner) return '';
	const pkgPath = resolve(owner.dir, 'package.json');
	if (!existsSync(pkgPath)) return '';
	let typesRel: string | undefined;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		typesRel = typeof pkg.types === 'string' ? pkg.types : typeof pkg.typings === 'string' ? pkg.typings : undefined;
	} catch {
		return '';
	}
	if (!typesRel) return '';
	const dtsPath = resolve(owner.dir, typesRel);
	if (!existsSync(dtsPath)) return '';
	const dts = ts.createSourceFile(dtsPath, readFileSync(dtsPath, 'utf8'), ts.ScriptTarget.Latest, false);
	const names = new Set<string>();
	const scan = (st: ts.Statement) => {
		if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) && st.name) names.add(st.name.text);
		else if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body)) st.body.statements.forEach(scan);
	};
	dts.statements.forEach(scan);
	return [...names].map((n) => `/** @typedef {any} ${n} */`).join('\n');
}

/**
 * A plugin's platform file (`index.ios.ts`) with the exports of the declarations beside it (`index.d.ts`) that it
 * lacks: an app is written against those declarations, and the build compiles the platform file in their place. A
 * name the file declares or imports is exported as it is; a type only the declarations have is exported from them. A
 * value only the declarations have is left out: the platform's JavaScript doesn't define it either.
 */
export function pluginDeclaredExports(code: string, file: string, platform: Platform): string {
	const stem = file.endsWith(`.${platform}.ts`) ? file.slice(0, -`.${platform}.ts`.length) : null;
	if (!stem || !existsSync(`${stem}.d.ts`)) return code;
	const exportsOf = (sf: ts.SourceFile) => {
		const exported = new Set<string>(),
			local = new Map<string, 'type' | 'value'>(),
			stars = new Set<string>(),
			from = new Map<string, string>();
		for (const st of sf.statements) {
			const isExported = ts.canHaveModifiers(st) && !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
			const names = ts.isVariableStatement(st) ? st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : [])) : (ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isEnumDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name ? [st.name.text] : [];
			for (const n of names) {
				local.set(n, ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) ? 'type' : 'value');
				if (isExported) exported.add(n);
			}
			const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
			if (ts.isImportDeclaration(st) && spec) {
				const c = st.importClause;
				for (const n of [c?.name, c?.namedBindings && ts.isNamespaceImport(c.namedBindings) ? c.namedBindings.name : undefined, ...(c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.map((e) => e.name) : [])]) {
					if (n) {
						local.set(n.text, 'value');
						from.set(n.text, spec);
					}
				}
			} else if (ts.isExportDeclaration(st)) {
				if (!st.exportClause && spec) stars.add(spec);
				else if (st.exportClause && ts.isNamedExports(st.exportClause))
					for (const e of st.exportClause.elements) {
						exported.add(e.name.text);
						if (spec && !e.propertyName) from.set(e.name.text, spec);
					}
			}
		}
		return { exported, local, stars, from };
	};
	const ownSf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
	const declaredSf = ts.createSourceFile(`${stem}.d.ts`, readFileSync(`${stem}.d.ts`, 'utf8'), ts.ScriptTarget.Latest, false);
	const own = exportsOf(ownSf);
	const declared = exportsOf(declaredSf);
	// Give unannotated exported functions in a plugin's platform file their sibling `.d.ts` return type so callers see the published contract.
	const dtsFnReturn = new Map<string, number>();
	for (const st of declaredSf.statements) {
		if (!ts.isFunctionDeclaration(st) || !st.name || !st.type || st.typeParameters?.length) continue;
		dtsFnReturn.set(st.name.text, (dtsFnReturn.get(st.name.text) ?? 0) + 1);
	}
	const fnEdits: { at: number; text: string }[] = [];
	const relBase = `./${basename(stem)}`;
	for (const st of ownSf.statements) {
		if (!ts.isFunctionDeclaration(st) || !st.name || st.type || !st.body || st.typeParameters?.length) continue;
		const isExported = !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
		if (!isExported || dtsFnReturn.get(st.name.text) !== 1) continue;
		fnEdits.push({ at: st.body.getStart(ownSf), text: `: ReturnType<typeof import(${JSON.stringify(relBase)}).${st.name.text}> ` });
	}
	let patched = code;
	for (const e of fnEdits.sort((a, b) => b.at - a.at)) patched = patched.slice(0, e.at) + e.text + patched.slice(e.at);
	const lines: string[] = [];
	for (const name of declared.exported) {
		if (own.exported.has(name)) continue;
		const spec = declared.from.get(name);
		if (own.local.has(name)) lines.push(`export { ${name} };`);
		else if (spec) lines.push(`export { ${name} } from ${JSON.stringify(spec)};`);
		else if (declared.local.get(name) === 'type') lines.push(`export type { ${name} } from ${JSON.stringify(relBase)};`);
	}
	for (const spec of declared.stars) if (!own.stars.has(spec)) lines.push(`export * from ${JSON.stringify(spec)};`);
	return lines.length ? `${patched}\n${lines.join('\n')}\n` : patched;
}
