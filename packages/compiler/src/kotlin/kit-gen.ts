// kit-android generated from @nativescript/core's own TypeScript, as swift/kit-gen.ts
// generates the iOS kit: the modules listed are translated from their Android
// files as one program, lenient and in library mode, into Kotlin beside
// kit-android's runtime. Imports of core modules not listed resolve to core's
// published declarations. Native calls are checked against android.jar and
// core's widgets AAR (`org.nativescript.widgets`), as an app's are.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { allowedDeprecation } from '../targets/android/deprecations.ts';
import { moduleThreads, THREAD_ANNOTATIONS } from '../semantics/threading.ts';
import { foldPlatform } from '../program/platform.ts';
import { Translator } from './translator.ts';
import { splitTopLevel } from './syntax.ts';
import { AndroidNativeAPI } from './native/api.ts';
import { androidClassPath } from './native/classpath.ts';
import { collectProperties } from '../program/properties.ts';
import { resultShapesOf } from '../semantics/shapes.ts';
import { evaluationOrder } from '../program/module-order.ts';
import { SourceLines } from '../program/source-lines.ts';
import { overlayInterfaces, pruneXmlFree, XML_FREE_FILES, XML_NOT_LINKED, XML_RUN_TIME_FILES, xmlFreeCounterparts } from '../kit/overlay.ts';
import { dropAt, located, withCoreDefines } from '../kit/core-source.ts';

export interface KotlinKitOptions {
	/** `packages/core` of the NativeScript repository. */
	core: string;
	/** Core as published (`node_modules/@nativescript/core`): the declarations of the modules not compiled. */
	declarations: string;
	/** `@nativescript/types-android` (its `index.d.ts` and `lib/`), where none is installed beside the declarations. */
	typesAndroid?: string;
	/** Core's widgets AAR (`platforms/android/widgets-release.aar`); defaults to the one beside the declarations. */
	widgets?: string;
	/** Core's files to compile, relative to `core`: a file, or a folder ending in `/` for everything in it. */
	modules: string[];
	/** As swift/kit-gen.ts's, to Kotlin: core file → function → the kit's Kotlin replacing it. */
	counterparts?: Record<string, Record<string, string>>;
	/** Formats the generated files' code, each in order. */
	format?: (codes: string[]) => string[];
	/** Folders of modules a compiled app has no use for: what core reads from them is untyped. */
	moot?: string[];
	/** Functions that return their last argument, and as decorators leave what they decorate as it is. */
	identities?: string[];
	/** npm packages compiled with core from their TypeScript sources: package → its files, the first its entry. */
	packages?: Record<string, string[]>;
	/** Compiler-owned TypeScript modules compiled as core modules (virtual core path → file on disk). */
	extra?: Record<string, string>;
	read?: (file: string) => string;
	/** Report every construct that does not translate instead of stopping at the first. */
	report?: boolean;
	/** Also generate the XML-free overlay (kit/overlay.ts). */
	overlay?: boolean;
}

export interface KotlinKitFile {
	/** The Kotlin file's name in the generated folder. */
	name: string;
	code: string;
	/** The core files it was generated from, relative to `core`, with their hashes. */
	sources: Record<string, string>;
}

export interface KotlinKitResult {
	files: KotlinKitFile[];
	/** With `report`: each construct that did not translate, as `file:line:col: what`. */
	errors: string[];
	/** The modules attempted and those translated with nothing left out. */
	attempted: number;
	translated: number;
	/** For each file, `[first Kotlin line, core file relative to core, its line]` ranges, as an app's source-lines.json. */
	lines: Record<string, [number, string, number][]>;
	/** With `overlay`: the overlay's files, named as the files they replace, and the classes only the XML run time uses. */
	overlay?: { files: KotlinKitFile[]; unkept: string[] };
}

export const KIT_PACKAGE = 'org.nativescript.kit';
const header = (pkg = KIT_PACKAGE, annotations = '') => `// Generated from @nativescript/core by tools/kit: edit core, not this file.\n${annotations}package ${pkg}\n\n${pkg === KIT_PACKAGE ? '' : `import ${KIT_PACKAGE}.*\n\n`}`;

/** The Android files of a module list: a platform's file over the shared one, no tests, no other platform. */
export function coreFilesAndroid(core: string, modules: string[]): string[] {
	const out = new Set<string>();
	const take = (rel: string) => {
		if (!rel.endsWith('.ts') || rel.endsWith('.d.ts') || /\.(ios|visionos|spec|test)\.ts$|-for-ios\.ts$|(^|\/)__tests__\//.test(rel)) return;
		if (!rel.endsWith('.android.ts') && existsSync(join(core, rel.replace(/\.ts$/, '.android.ts')))) return;
		out.add(rel);
	};
	for (const m of modules) {
		if (!m.endsWith('/')) {
			take(m);
			continue;
		}
		for (const f of readdirSync(join(core, m), { recursive: true }).sort() as string[]) if (statSync(join(core, m, f)).isFile()) take(m + f);
	}
	return [...out].sort();
}

/** A core file's Kotlin file name: `ui/core/view/index.android.ts` → `ui_core_view_index`. */
export function kotlinModuleName(rel: string): string {
	return rel.replace(/\.(android\.)?ts$/, '').replace(/[^A-Za-z0-9]+/g, '_');
}

/** The object holding a module's functions and variables, named as the Swift kit's module enum: `Core_ui_core_view_index`, `Package_css_what_src_parse`. */
export function moduleObjectName(rel: string): string {
	return rel.startsWith('npm/')
		? 'Package_' +
				rel
					.slice(4)
					.replace(/\.ts$/, '')
					.replace(/[^A-Za-z0-9]+/g, '_')
		: 'Core_' + kotlinModuleName(rel);
}

export function generateKotlinKit(o: KotlinKitOptions): KotlinKitResult {
	const core = resolve(o.core);
	const rels = coreFilesAndroid(core, o.modules);
	const extraFiles = new Map<string, string>();
	for (const [rel, disk] of Object.entries(o.extra ?? {})) {
		const abs = join(core, rel);
		if (!existsSync(disk)) throw new Error(`${disk} is missing`);
		extraFiles.set(abs, disk);
		if (!rels.includes(rel)) rels.push(rel);
	}
	rels.sort();
	const compiled = new Set(rels.map((r) => join(core, r)));
	const read = o.read ?? ((f: string) => readFileSync(f, 'utf8'));
	const modules = resolve(o.declarations, '../..');
	const packageDir = (pkg: string) => {
		for (let dir = resolve(o.declarations); ; dir = dirname(dir)) {
			if (existsSync(join(dir, 'node_modules', pkg))) return join(dir, 'node_modules', pkg);
			if (dirname(dir) === dir) return join(modules, pkg);
		}
	};
	const typesAndroid = resolve(o.typesAndroid ?? packageDir('@nativescript/types-android'));
	if (!existsSync(join(typesAndroid, 'index.d.ts'))) throw new Error(`no @nativescript/types-android at ${typesAndroid}: install it beside the declarations, or pass typesAndroid`);
	const widgets = o.widgets ?? join(o.declarations, 'platforms/android/widgets-release.aar');
	if (!existsSync(widgets)) throw new Error(`no widgets AAR at ${widgets}: build core, or pass widgets`);
	const packageFiles = new Map<string, string>();
	const packageEntries = new Map<string, string>();
	for (const [pkg, list] of Object.entries(o.packages ?? {})) {
		list.forEach((f, k) => {
			const abs = join(packageDir(pkg), f);
			if (!existsSync(abs)) throw new Error(`${abs} is missing: install ${pkg} as core's package.json has it`);
			packageFiles.set(abs, `npm/${pkg}/${f}`);
			compiled.add(abs);
			if (k === 0) packageEntries.set(pkg, abs);
		});
	}
	const relOf = (abs: string) => packageFiles.get(abs) ?? relative(core, abs);

	const options: ts.CompilerOptions = {
		// Core's own compiler settings: ES2020 class fields (a redeclared field does not reset), legacy decorators, not strict.
		target: ts.ScriptTarget.ES2022,
		useDefineForClassFields: false,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: false,
		lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
		types: [],
		skipLibCheck: true,
		experimentalDecorators: true,
		noEmit: true,
		allowImportingTsExtensions: true,
	};
	const host = ts.createCompilerHost(options);
	const readLib = host.getSourceFile.bind(host);
	const baseFileExists = host.fileExists.bind(host);
	host.fileExists = (name) => extraFiles.has(name) || baseFileExists(name);
	const sources = new Map<string, string>();
	const MOOT = '/__moot__/';
	const isMoot = (abs: string) => (o.moot ?? []).some((d) => relative(core, abs).startsWith(d));
	host.getSourceFile = (name, version, onError) => {
		if (name.startsWith(MOOT)) return ts.createSourceFile(name, 'declare const moot: any;\nexport = moot;\n', version, true);
		if (!compiled.has(name)) return readLib(name, version, onError);
		if (!sources.has(name)) sources.set(name, read(extraFiles.get(name) ?? name));
		if (packageFiles.has(name)) return ts.createSourceFile(name, sources.get(name)!, version, true);
		return ts.createSourceFile(name, foldPlatform(withCoreDefines(sources.get(name)!), name, 'android'), version, true);
	};
	const declarationOf = (abs: string): string | undefined => {
		const rel = relative(core, abs).replace(/\.(android\.)?ts$/, '');
		for (const c of [`${rel}.d.ts`, `${rel}/index.d.ts`]) if (existsSync(join(o.declarations, c))) return join(o.declarations, c);
		return undefined;
	};
	const resolutions = new Map<string, string>();
	host.resolveModuleNameLiterals = (literals, containing) =>
		literals.map((lit) => {
			const m = lit.text;
			let file: string | undefined;
			if (m.startsWith('.') && containing.startsWith(core + '/')) {
				const base = resolve(dirname(containing), m.replace(/\.js$/, ''));
				const source = [`${base}.android.ts`, `${base}.ts`, `${base}/index.android.ts`, `${base}/index.ts`].find((c) => existsSync(c));
				const self = (m === '.' || m === './index') && source === containing;
				file = source && isMoot(source) ? MOOT + relative(core, source).replace(/\.ts$/, '.d.ts') : source && compiled.has(source) && !self ? source : declarationOf(source ?? base);
			}
			if (m.startsWith('.') && packageFiles.has(containing)) file = [resolve(dirname(containing), m.replace(/\.js$/, '.ts')), resolve(dirname(containing), m) + '.ts'].find((c) => packageFiles.has(c));
			if (!file && packageEntries.has(m) && (containing.startsWith(core + '/') || packageFiles.has(containing))) file = packageEntries.get(m);
			if (!file && containing.startsWith(core + '/') && /^[@a-z]/i.test(m) && !m.startsWith('@nativescript/')) file = `${MOOT}npm/${m}.d.ts`;
			if (file) {
				resolutions.set(`${containing}\0${m}`, file);
				return { resolvedModule: { resolvedFileName: file, extension: file.endsWith('.d.ts') ? ts.Extension.Dts : ts.Extension.Ts } };
			}
			const r = ts.resolveModuleName(m, containing.startsWith(core + '/') ? join(modules, '..', 'index.ts') : containing, options, host);
			if (r.resolvedModule) resolutions.set(`${containing}\0${m}`, r.resolvedModule.resolvedFileName);
			return r;
		});
	const roots = [...compiled, join(core, 'index.ts'), join(typesAndroid, 'index.d.ts'), join(o.declarations, 'global-types.d.ts')];
	const program = ts.createProgram(roots, options, host);
	const checker = program.getTypeChecker();
	const files = program.getSourceFiles().filter((f) => compiled.has(f.fileName));

	const counterparts = new Map<string, Record<string, string>>(Object.entries(o.counterparts ?? {}).map(([f, m]) => [f.startsWith('npm:') ? `${MOOT}npm/${f.slice(4)}.d.ts` : f.startsWith('moot:') ? MOOT + f.slice(5).replace(/\.ts$/, '.d.ts') : f.startsWith('~/') ? f : join(core, f), m]));
	// Which of core's modules run on the main thread only; an `any` module importing a `ui` one stops the generation.
	const threads = moduleThreads({ program, modules: rels.map((r) => join(core, r)), coreModuleOf: (f) => (f.startsWith(core + '/') ? relative(core, f) : null) });
	const sourceLines = new SourceLines(new Map());
	const classPath = androidClassPath(widgets);
	const translator = new Translator(checker, new Map(), files, {
		pluginFiles: files.map((f) => f.fileName),
		properties: collectProperties(checker, files),
		lenient: true,
		library: {
			identities: new Set(o.identities ?? []),
			counterpart: (file, name) => counterparts.get(file)?.[name] ?? null,
			moduleName: (file) => (compiled.has(file) ? moduleObjectName(relOf(file)) : null),
			internalTypes: handWrittenTypes(),
			resultShapes: resultShapesOf(files, checker, program.getSourceFile(join(core, 'index.ts'))!),
		},
		moduleThread: (file) => threads.get(file),
		appModule: KIT_PACKAGE,
		lines: sourceLines,
		native: (t) => {
			const native = new AndroidNativeAPI(t, classPath);
			// The repository's typings are no installed package: their declarations are the SDK's all the same.
			for (const f of program.getSourceFiles()) if (f.isDeclarationFile && f.fileName.startsWith(typesAndroid + '/')) native.pluginTypings.add(f.fileName);
			return native;
		},
	});
	const native = translator.native as AndroidNativeAPI;

	const errors: string[] = [];
	const order = evaluationOrder(program, [...compiled], (c, s) => resolutions.get(`${c}\0${s}`), [join(core, 'index.ts')]);
	const out: KotlinKitFile[] = [];
	const paths = new Map<KotlinKitFile, string>();
	const inits: string[] = [];
	const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);
	let translated = 0;
	const results = new Map<string, { code: string; init: string[] }>();
	for (const file of order) {
		const sf = program.getSourceFile(file)!;
		let result: { code: string; init: string[] } | null = null;
		let dropped = 0;
		for (let attempt = 0; attempt < 1000 && !result; attempt++) {
			try {
				result = translator.module(sf);
			} catch (e) {
				if (!o.report) throw e;
				errors.push(located(e, sf, core));
				dropped++;
				if (!dropAt(e, sf)) break;
			}
		}
		if (!result) continue;
		if (!dropped) translated++;
		results.set(file, result);
	}
	translator.foreign.length = 0;
	// Again, now that every declaration the first pass found nullable (a field core leaves unset) is known where code
	// translated before it reads it.
	for (const file of order) {
		if (!results.has(file)) continue;
		const sf = program.getSourceFile(file)!;
		const rel = relOf(file);
		const name = kotlinModuleName(rel);
		let result = results.get(file)!;
		try {
			result = translator.module(sf);
		} catch (e) {
			errors.push(located(e, sf, core));
		}
		if (result.init.length) inits.push(`${moduleObjectName(rel)}.__init`);
		const kitFile = { name: `${name}.kt`, code: result.code, sources: { [rel]: hash(sources.get(file) ?? '') } };
		paths.set(kitFile, file);
		out.push(kitFile);
	}
	// A declaration file of core's (`ui/dialogs/index.d.ts`) stands for the compiled file beside it.
	const sourceOf = (dts: string): string | null => {
		if (!dts.startsWith(resolve(o.declarations) + '/')) return null;
		const rel = relative(o.declarations, dts).replace(/\.d\.ts$/, '');
		return [`${rel}.android.ts`, `${rel}.ts`].map((c) => join(core, c)).find((c) => compiled.has(c)) ?? null;
	};
	const exported = indexExports(program, checker, join(core, 'index.ts'), compiled, (f) => moduleObjectName(relOf(f)), sourceOf, out);
	// The statement markers, taken out before the imports are written, become the line table a stack trace's kit
	// frames are read with (retrace.ts): `[first Kotlin line, core file, its line]` ranges.
	const lines: Record<string, [number, string, number][]> = {};
	const kitCodes = out.map((f) => (translator.interfacesOf(paths.get(f)!) + f.code).trim());
	const foreign = [...new Map(translator.foreign.map((x) => [x.name, x])).values()];
	const shapes = translator.shapesCode().trim();
	// What the kit's package declares at its top level: a Java class of the same simple name is imported under an alias.
	const taken = topLevelNames([...kitCodes, exported ?? '', shapes, ...handWrittenFiles().map((f) => readFileSync(f, 'utf8'))]);
	// The markers stay through imports and formatting, so the table names the lines as written.
	const withKitImports = (_name: string, code: string, pkg?: string): string => withImports(code, taken, pkg, (internal) => !!native.classpath.get(internal)?.deprecated && allowedDeprecation(internal));
	const lineTable = (name: string, code: string, formatted: boolean): string => {
		const body = sourceLines.kotlin(code, formatted);
		const ranges: [number, string, number][] = [];
		body.lines.forEach((at, i) => {
			const last = ranges.at(-1);
			if (at ? !last || last[1] !== relative(core, at.file) || last[2] !== at.line : last && last[2] !== 0) ranges.push([i + 1, at ? relative(core, at.file) : '', at?.line ?? 0]);
		});
		if (ranges.length) lines[name] = ranges;
		return body.code;
	};
	// Translated after the shared kit's shapes, so that none of them comes from the overlay.
	const overlay: KotlinKitFile[] = [];
	if (o.overlay) {
		for (const [f, m] of Object.entries(xmlFreeCounterparts({ parse: 'xmlRunTimeNotLinked', expression: 'xmlRunTimeNotLinked' }))) counterparts.set(join(core, f), { ...counterparts.get(join(core, f)), ...m });
		for (const rel of XML_FREE_FILES) {
			const path = join(core, rel);
			const sf = program.getSourceFile(path)!;
			if (rel === 'ui/builder/index.ts') pruneXmlFree(sf);
			const result = translator.module(sf);
			const shared = out.find((f) => paths.get(f) === path)!;
			const code = (overlayInterfaces(translator.interfacesOf(path), result.code) + result.code).trim() + (rel === 'ui/builder/index.ts' ? XML_FREE_KOTLIN : '');
			overlay.push({ name: shared.name, code: withKitImports(shared.name, code), sources: shared.sources });
		}
	}
	out.forEach((f, k) => {
		f.code = withKitImports(f.name, kitCodes[k]);
	});
	if (exported) out.push({ name: '__Exports.kt', code: withKitImports('__Exports.kt', exported.trim()), sources: {} });
	// Classes under Java names of other packages (`com.tns.NativeScriptActivity`), as an app's manifest names them.
	for (const f of foreign) {
		out.push({ name: `${f.name}.kt`, code: withKitImports(`${f.name}.kt`, f.code.trim(), f.name.slice(0, f.name.lastIndexOf('.'))), sources: {} });
	}
	if (shapes) out.push({ name: '__Objects.kt', code: withKitImports('__Objects.kt', shapes), sources: {} });
	// A file ktfmt cannot format is left as written.
	const format = (codes: string[]) => {
		const formatted = o.format?.(codes) ?? codes;
		return codes.map((c, k) => ({ code: formatted[k], formatted: formatted[k] !== c }));
	};
	format(out.map((f) => f.code)).forEach((r, k) => {
		out[k].code = lineTable(out[k].name, r.code, r.formatted);
	});
	if (overlay.length)
		format(overlay.map((f) => f.code)).forEach((r, k) => {
			overlay[k].code = sourceLines.kotlin(r.code, r.formatted).code;
		});
	const runTime = new Set(XML_RUN_TIME_FILES.map((r) => join(core, r)));
	const unkept = out
		.filter((f) => runTime.has(paths.get(f) ?? ''))
		.flatMap((f) => [...f.code.matchAll(/^(?:(?:open|abstract|data|sealed|internal|private)\s+)*(?:class|object|interface)\s+(\w+)/gm)].map((m) => `${KIT_PACKAGE}.${m[1]}`))
		.sort();
	// Core's modules run their top level once, in the order core's index evaluates them.
	out.push({ name: '__Modules.kt', sources: {}, code: `${header()}import androidx.annotation.MainThread\n\nobject CoreModules {\n    private var initialized = false\n\n    @MainThread\n    fun initialize() {\n        if (initialized) return\n        initialized = true\n${inits.map((i) => `        ${i}()\n`).join('')}    }\n}\n` });
	if (errors.length && !o.report) throw new Error(errors.join('\n'));
	return { files: out, errors: [...new Set(errors)], attempted: order.length, translated, lines, overlay: o.overlay ? { files: overlay, unkept } : undefined };
}

/** What the overlay calls in place of the parser and the evaluator: a JavaScript Error, as core's own failures are. */
const XML_FREE_KOTLIN = `

fun <T> xmlRunTimeNotLinked(vararg arguments: Any?): T = throw JSException(JSError(${JSON.stringify(XML_NOT_LINKED)}))
`;

/**
 * The functions and constants core's index exports (`getRootLayout`, `widthProperty`), as an app
 * imports them from `@nativescript/core`: top-level declarations forwarding to the module object each
 * is compiled into, with its own Kotlin signature. A default argument other than a literal may name
 * what only the module's object sees: the forwarding function has an overload without it instead.
 */
function indexExports(program: ts.Program, checker: ts.TypeChecker, index: string, compiled: Set<string>, moduleOf: (file: string) => string, sourceOf: (dts: string) => string | null, out: KotlinKitFile[]): string {
	const sf = program.getSourceFile(index);
	const sym = sf && checker.getSymbolAtLocation(sf);
	if (!sym) return '';
	const types = new Set<string>();
	for (const f of out) for (const m of f.code.matchAll(/^(?:(?:open|abstract|data|enum|sealed|final)\s+)*(?:class|interface|object|typealias)\s+(\w+)/gm)) types.add(m[1]);
	const codeOf = (module: string) => out.find((f) => f.code.includes(`object ${module} {\n`))?.code;
	const implementation = (target: ts.Symbol): ts.Symbol => {
		const dts = target.declarations?.[0]?.getSourceFile().fileName;
		const file = dts?.endsWith('.d.ts') ? sourceOf(dts) : null;
		const impl = file ? program.getSourceFile(file) : undefined;
		const module = impl && checker.getSymbolAtLocation(impl);
		const found = module && checker.getExportsOfModule(module).find((x) => x.name === target.name);
		return found ? (found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found) : target;
	};
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const e of checker.getExportsOfModule(sym)) {
		const aliased = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
		const target = implementation(aliased);
		if (seen.has(e.name) || types.has(e.name) || e.name === 'default') continue;
		const decl = target.declarations?.find((d) => (ts.isFunctionDeclaration(d) && !!d.body) || ts.isVariableDeclaration(d));
		if (!decl || !compiled.has(decl.getSourceFile().fileName) || !ts.isSourceFile(ts.isVariableDeclaration(decl) ? decl.parent.parent.parent : decl.parent)) continue;
		const own = (decl as ts.FunctionDeclaration | ts.VariableDeclaration).name?.getText() ?? target.name;
		const module = moduleOf(decl.getSourceFile().fileName);
		const code = codeOf(module);
		if (!code) continue;
		if (ts.isVariableDeclaration(decl)) {
			const m = new RegExp(`\\n    (?:@\\S+ )*(lateinit )?(var|val) ${own}: (.+?)(?: = .*)?\\n`).exec(code);
			if (!m) continue;
			lines.push(m[2] === 'var' ? `var ${e.name}: ${m[3]}\n    get() = ${module}.${own}\n    set(value) { ${module}.${own} = value }` : `val ${e.name}: ${m[3]} get() = ${module}.${own}`);
			seen.add(e.name);
			continue;
		}
		const m = new RegExp(`\\n    fun (<[^>]*> )?${own}\\((.*)\\)(?:: (.+?))? \\{\\n`).exec(code);
		if (!m) continue;
		const [, generics = '', list, ret] = m;
		const params = splitTopLevel(list)
			.filter(Boolean)
			.map((p) => {
				const [, vararg, name, type, value] = /^(vararg )?(\S+): (.+?)(?: = (.+))?$/.exec(p)!;
				return { vararg: !!vararg, name, type, value };
			});
		const literal = (v?: string) => !v || /^(null|true|false|-?[\d.]+|Double\.NaN|"[^"\\$]*")$/.test(v);
		let keep = params.length;
		for (;;) {
			const used = params.slice(0, keep);
			const decls = used.map((p) => `${p.vararg ? 'vararg ' : ''}${p.name}: ${p.type}${p.value && literal(p.value) ? ` = ${p.value}` : ''}`);
			const args = used.map((p) => (p.vararg ? `*${p.name}` : p.name));
			lines.push(`fun ${generics}${e.name}(${decls.join(', ')})${ret ? `: ${ret}` : ''} = ${module}.${own}(${args.join(', ')})`);
			if (!keep || !params[keep - 1].value || literal(params[keep - 1].value)) break;
			keep--;
		}
		seen.add(e.name);
	}
	return lines.length ? `// What @nativescript/core's index exports as functions and constants, as an app imports them.\n\n${lines.join('\n\n')}\n` : '';
}

/**
 * Report lines grouped by what did not translate: the construct's description, without the
 * source text it quotes, most frequent first.
 */
export function groupByCause(errors: string[]): { cause: string; count: number; examples: string[] }[] {
	const groups = new Map<string, string[]>();
	for (const e of errors) {
		const m = /^[^:]+:\d+:\d+: (.*?) is not supported in a release build yet/.exec(e) ?? /^[^:]+:\d+: (.*)$/.exec(e);
		const cause = (m?.[1] ?? e)
			.replace(/`[^`]*`/g, '`…`')
			.replace(/'[^']*'/g, "'…'")
			.replace(/"[^"]*"/g, '"…"')
			.replace(/\b(?:[a-z]+\.)+[A-Z]\w*(?:\.[A-Z]\w*)*/g, '<class>')
			.replace(/<class>\.\w+/g, '<class>.<member>')
			.replace(/\(ambiguous between .*$/, '(ambiguous between Java overloads)')
			.replace(/\(no Java overload takes .*$/, '(no Java overload takes these arguments)')
			.replace(/^(the class decorator \w+)\(.*$/, '$1')
			.slice(0, 160);
		(groups.get(cause) ?? groups.set(cause, []).get(cause)!).push(e);
	}
	return [...groups].map(([cause, list]) => ({ cause, count: list.length, examples: list.slice(0, 3) })).sort((a, b) => b.count - a.count);
}

/** A Java package root the SDK's classes are named from. */
const JAVA_NAME = /(?<![\w.$`])(?:android|androidx|java|javax|dalvik|org\.(?:nativescript\.widgets|json|w3c|xml)|com\.google)(?:\.[a-z_]\w*)*\.[A-Z]\w*/g;

/**
 * A file's code with the Java classes it names imported. A class is imported by its simple name unless the file also
 * spells that name for something else (core's `View`, Kotlin's `Double`) or names two classes by it: then under an
 * alias (`android_view_View`), since core's classes have members named `android`, which a qualified name inside
 * them would resolve to, and Kotlin has no root qualifier.
 * `deprecated`: whether an imported class (`android/widget/TabHost`) is a deprecated one core may use.
 */
function withImports(code: string, taken: Set<string>, pkg = KIT_PACKAGE, deprecated: (internal: string) => boolean = () => false): string {
	// Kotlin's `run { … }` by its package: core's classes declare a `run` of their own (`Application.run()`), which would take the block.
	code = code.replace(/(?<=[\s(=,!/])run (?=\{|\w+@ \{)/g, 'kotlin.run ');
	const named = new Set<string>();
	let rest = '';
	outsideLiterals(code, (part) => {
		for (const m of part.matchAll(JAVA_NAME)) named.add(m[0]);
		rest += part.replace(JAVA_NAME, ' ') + '\n';
		return part;
	});
	const simple = (name: string) => name.slice(name.lastIndexOf('.') + 1);
	const bySimple = new Map<string, number>();
	for (const name of named) bySimple.set(simple(name), (bySimple.get(simple(name)) ?? 0) + 1);
	const spelled = new Set(rest.match(/(?<![\w$.])[A-Z]\w*(?![\w$])/g) ?? []);
	// The name each class is written by: its own, or its alias where that one is taken.
	const aliases = new Map<string, string>();
	for (const name of named) aliases.set(name, bySimple.get(simple(name)) === 1 && !spelled.has(simple(name)) && !taken.has(simple(name)) ? '' : name.replace(/\./g, '_'));
	const out = outsideLiterals(code, (part) => part.replace(JAVA_NAME, (name) => aliases.get(name) || simple(name)));
	const annotations = THREAD_ANNOTATIONS.filter((a) => new RegExp(`@${a}\\b`).test(out)).map((a): [string, string] => [`androidx.annotation.${a}`, '']);
	const imports = [...annotations, ...[...aliases].sort()].map(([name, a]) => `import ${name}${a ? ` as ${a}` : ''}\n`).join('');
	// Kotlin reports a deprecated class at its import, which only the file can suppress: the file then suppresses deprecation.
	const old = [...aliases.keys()].filter((name) => deprecated(name.replace(/\./g, '/')));
	if (old.length) {
		const why = `// Uses ${old.join(', ')}, deprecated in Android, on purpose: Kotlin reports a class at its import, which only the file can suppress.\n@file:Suppress("DEPRECATION")\n\n`;
		return header(pkg, why) + (imports ? imports + '\n' : '') + out.replaceAll('@Suppress("DEPRECATION") ', '').replaceAll('@Suppress("DEPRECATION", ', '@Suppress(') + '\n';
	}
	return header(pkg) + (imports ? imports + '\n' : '') + out + '\n';
}

/** `code` with `f` applied to each run of it outside string literals and comments; a string template's `${…}` is code. */
function outsideLiterals(code: string, f: (part: string) => string): string {
	let out = '';
	// A template's braces open inside it count, so its own `}` is the one that closes it.
	const stack: { kind: 'code' | 'string' | 'template'; depth: number }[] = [{ kind: 'code', depth: 0 }];
	for (let i = 0; i < code.length;) {
		const top = stack.at(-1)!;
		if (top.kind === 'string') {
			const c = code[i];
			if (c === '\\') {
				out += code.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (c === '"') {
				stack.pop();
				out += c;
				i++;
				continue;
			}
			if (c === '$' && code[i + 1] === '{') {
				stack.push({ kind: 'template', depth: 0 });
				out += '${';
				i += 2;
				continue;
			}
			out += c;
			i++;
			continue;
		}
		let j = i;
		while (j < code.length && !'"\'/{}'.includes(code[j])) j++;
		out += f(code.slice(i, j));
		if (j >= code.length) break;
		const c = code[j];
		if (c === '"') {
			stack.push({ kind: 'string', depth: 0 });
			out += c;
			i = j + 1;
			continue;
		}
		if (c === "'") {
			const end = code.indexOf("'", j + (code[j + 1] === '\\' ? 3 : 2));
			out += code.slice(j, end + 1);
			i = end + 1;
			continue;
		}
		if (c === '/' && code[j + 1] === '*') {
			const end = code.indexOf('*/', j + 2);
			out += code.slice(j, end < 0 ? code.length : end + 2);
			i = end < 0 ? code.length : end + 2;
			continue;
		}
		if (c === '/' && code[j + 1] === '/') {
			const end = code.indexOf('\n', j);
			out += code.slice(j, end < 0 ? code.length : end);
			i = end < 0 ? code.length : end;
			continue;
		}
		if (c === '{') {
			top.depth++;
			out += c;
			i = j + 1;
			continue;
		}
		if (c === '}') {
			if (top.kind === 'template' && top.depth === 0) stack.pop();
			else top.depth--;
			out += c;
			i = j + 1;
			continue;
		}
		out += c;
		i = j + 1;
	}
	return out;
}

/** The hand-written Kotlin kit-android compiles beside the generated code (see `handWrittenTypes`). */
function handWrittenFiles(): string[] {
	const android = resolve(import.meta.dirname, '../../kit-android');
	const kit = join(android, 'src/main/kotlin/org/nativescript/kit');
	const fromCore = join(android, 'src/fromcore/kotlin/org/nativescript/kit');
	const dir = (d: string) =>
		existsSync(d)
			? readdirSync(d)
					.sort()
					.filter((f) => f.endsWith('.kt'))
					.map((f) => join(d, f))
			: [];
	return [...dir(kit), ...dir(join(kit, 'runtime')), ...dir(fromCore)];
}

/** The capitalized names Kotlin sources declare at their top level: types, objects, properties and functions. */
function topLevelNames(codes: string[]): Set<string> {
	const decl = /^(?:@[\w:.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|open|abstract|sealed|data|enum|value|annotation|inline|const|lateinit|inner|final)\s+)*(?:class|interface|object|typealias|val|var|fun)\s+(?:<[^>]*>\s*)?([A-Z]\w*)(?![\w.])/gm;
	const names = new Set<string>();
	for (const code of codes) for (const m of code.matchAll(decl)) names.add(m[1]);
	return names;
}

/**
 * The top-level types of the hand-written Kotlin kit-android compiles beside the generated code: src/main (the
 * runtime and the files the generated code calls) and src/fromcore.
 */
function handWrittenTypes(): Set<string> {
	const names = new Set<string>();
	for (const f of handWrittenFiles()) {
		for (const m of readFileSync(f, 'utf8').matchAll(/^(?:(?:public|internal|open|abstract|sealed|data|enum|fun|value|annotation)\s+)*(?:class|interface|object|typealias)\s+(\w+)/gm)) names.add(m[1]);
	}
	return names;
}
