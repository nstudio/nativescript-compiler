// The Android target: the app's components and modules as Kotlin against
// NativeScriptKit for Android (kit-android), in a Gradle
// project whose resources are the app's own App_Resources/Android.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { ComponentIR, TNode } from '../../api/ir.ts';
import { Translator } from '../../kotlin/translator.ts';
import { jsObjectCode, kotlinString, RT } from '../../kotlin/syntax.ts';
import { ndk, prepareBindingArchives, type AndroidBinding } from '../../plugins/bindings-android.ts';
import { render } from '../../kotlin/render.ts';
import type { ComponentMembers, EntryCode, EntryContext, KotlinTranslatorView, TemplateBehaviour, TranslatorHooks } from '../../api/adapter-api.ts';
import { addKotlinInterfaces, sourceName, translateKotlinModules, type KotlinModule } from '../../kotlin/app-modules.ts';
import { evaluatedImports } from '../../program/module-order.ts';
import { sharedWorkerState, sharedWorkerStateError } from '../../semantics/worker-state.ts';
import { CoreKotlin } from '../../kotlin/core-api.ts';
import { AndroidNativeAPI } from '../../kotlin/native/api.ts';
import { androidClassPath } from '../../kotlin/native/classpath.ts';
import { withKitAndroidHidden } from '../../kotlin/native/bridging.ts';
import { pluginNativeAndroid } from '../../plugins/native-android.ts';
import type { PluginSource } from '../../plugins/source.ts';
import type { Reach } from '../../program/reach.ts';
import type { Properties } from '../../program/properties.ts';
import { SourceLines } from '../../program/source-lines.ts';
import { formatKotlin } from '../../kotlin/ktfmt.ts';
import { moduleThreads, THREAD_ANNOTATIONS } from '../../semantics/threading.ts';
import { androidManifest, copyAndroidAppFiles, copyAndroidFonts, pluginManifests } from './resources.ts';
import { appResourcesDir, uncaughtErrorSwitches } from '../resources.ts';
import { KIT_ANDROID, PACKAGE } from '../../driver/paths.ts';
import type { BuildContext } from '../../program/build-context.ts';
import { OVERLAY_FILE, XML_FREE_OVERLAY, type KitOverlay } from '../../kit/overlay.ts';
import { byName } from '../../program/order.ts';
import { programClassName } from '../../semantics/top-names.ts';

export interface AndroidBuild {
	/** The build's context: its framework adapter, plugin stand-ins and refusals. */
	context: BuildContext;
	app: string;
	out: string;
	name: string;
	framework: string;
	behaviour: TemplateBehaviour;
	translatorHooks?: TranslatorHooks<KotlinTranslatorView>;
	/** The framework's code in the generated entry. */
	entry?: (ctx: EntryContext) => EntryCode;
	components: ComponentIR[];
	modules: string[];
	program: ts.Program;
	checker: ts.TypeChecker;
	/** The app's files and the components' virtual files, in translation order. */
	files: readonly ts.SourceFile[];
	infos: Map<string, { name: string; props: string[]; members: ComponentMembers; outputs?: string[]; outputFields?: Record<string, string>; setters?: string[]; propAliases?: Record<string, string>; changes?: boolean; slots?: string[] }>;
	/** The app's classes its templates create as elements (registered elements). */
	elementClasses: ReadonlySet<string>;
	root: string;
	/** Source lines for the Kotlin, written as `source-lines.json` for `retrace.ts`; null leaves them out. */
	lines: SourceLines | null;
	/** The file a component was written in, which its virtual file stands for; null where none is found. */
	componentSource?: (c: ComponentIR) => string | null;
	applicationId?: string;
	widgetsAar?: string;
	/** The app folder: its fonts become assets. */
	appDir: string;
	build: boolean;
	/** Build an app bundle (.aab) beside the APK. */
	bundle?: boolean;
	/** The release keystore (`--key-store-path`, `--key-store-password`, `--key-store-alias`, `--key-store-alias-password`). */
	keyStore?: { path: string; password: string; alias: string; aliasPassword: string };
	/** The plugins the app imports: their Android code is built and linked. */
	plugins?: PluginSource[];
	/** The plugins' source files, what of them the app reaches, and the properties they register. */
	pluginFiles?: string[];
	reach?: Reach;
	properties?: Properties;
	/** The plugin modules translated with the app. */
	compiledPlugins?: string[];
	/** Worker scripts (`new Worker(new URL('./x.worker', import.meta.url))`), compiled as modules each worker thread runs. */
	workers?: string[];
	resolved?: (containing: string, specifier: string) => string | undefined;
	/** The app mounts its own roots (its entry renders them): the entry is a module that runs the app. */
	mounted?: boolean;
	/** A plain XML app's pages, page stylesheets (path and AST) and the element names its XML uses, for core's Builder. */
	xml?: { pages: { name: string; text: string }[]; styles: { name: string; ast: string }[]; elements: string[] };
	/** `--allow-unimplemented-properties`. */
	allowUnapplied?: boolean;
	/** `--all-errors`: every construct the translator cannot handle, instead of the first. */
	allErrors?: boolean;
	/** The app's own configuration leaves strict checking off. */
	lenient?: boolean;
	/** The app's configuration assigns class fields rather than defining them (`useDefineForClassFields` off). */
	assignFields?: boolean;
	/** The bindings of plugins the app uses (bindings.ts). */
	bindings?: AndroidBinding[];
	/** `android.release.narrowKitKeeps`: R8 keeps only what the kit's reflection needs (kitKeepRules). */
	narrowKitKeeps?: boolean;
	/** The app compiles the generated kit's XML-free overlay (kit/overlay.ts) in place of the files it replaces. */
	xmlRunTimeFree?: boolean;
	/** The keys core reads app objects by when nothing parses XML at run time (`xml/keys.ts`). */
	xmlMemberKeys?: import('../../semantics/states/value-states.ts').XmlMemberKeys | null;
	/** The app's stylesheet as css2json-loader's AST, which core loads as `app.css` in the generated kit. */
	cssAST?: string;
}

/** `packaging { … }` from what the plugins' include.gradle files exclude and pick first: native libraries under jniLibs, the rest resources. */
function packagingBlock(p: { excludes: string[]; pickFirsts: string[] }): string {
	const so = (f: string) => f.endsWith('.so');
	const set = (items: string[]) => `setOf(${items.map(kotlinString).join(', ')})`;
	const lines = [...(p.excludes.some(so) ? [`jniLibs.excludes += ${set(p.excludes.filter(so))}`] : []), ...(p.pickFirsts.some(so) ? [`jniLibs.pickFirsts += ${set(p.pickFirsts.filter(so))}`] : []), ...(p.excludes.some((f) => !so(f)) ? [`resources.excludes += ${set(p.excludes.filter((f) => !so(f)))}`] : []), ...(p.pickFirsts.some((f) => !so(f)) ? [`resources.pickFirsts += ${set(p.pickFirsts.filter((f) => !so(f)))}`] : [])];
	return lines.length ? `\n    packaging {\n${lines.map((l) => `        ${l}\n`).join('')}    }\n` : '';
}

const kit = KIT_ANDROID;
/** The kit's projectDir for settings.gradle.kts in `out`. Gradle resolves it from `out`'s physical path, so both ends are real paths. */
export const kitProjectDir = (out: string) => relative(realpathSync(out), realpathSync(kit));
const say = (m: string) => console.log(`[ns-compiled] ${m}`);

export async function writeAndroid(b: AndroidBuild): Promise<void> {
	const overlay: KitOverlay | null = b.xmlRunTimeFree ? JSON.parse(readFileSync(join(KIT_ANDROID, 'overlays', XML_FREE_OVERLAY, OVERLAY_FILE), 'utf8')) : null;
	const started = Date.now();
	const pkg = `org.nativescript.${b.name.toLowerCase()}`;
	const sources = join(b.out, 'src', 'main', 'kotlin', ...pkg.split('.'));
	rmSync(join(b.out, 'src'), { recursive: true, force: true });
	mkdirSync(sources, { recursive: true });

	const widgets = b.widgetsAar ? resolve(b.widgetsAar) : findWidgetsAar(b.app);
	// Before the translator: calls into plugin classes are checked against the plugins' built AARs.
	const native = pluginNativeAndroid(b.plugins ?? [], { app: b.app, say });
	const bindingDefines: string[] = [];
	for (const binding of b.bindings ?? []) {
		const prepared = prepareBindingArchives(binding, native.archives, join(b.out, 'bindings'));
		native.archives = prepared.archives;
		bindingDefines.push(...prepared.defines);
	}
	const classPath = androidClassPath(widgets, native);
	// The app's own typings of Java APIs no package types (`declare module androidx { … }` in a script .d.ts).
	const appDir = resolve(b.app) + '/';
	const appTypings = b.program.getSourceFiles().filter((sf) => sf.isDeclarationFile && sf.fileName.startsWith(appDir) && !sf.fileName.includes('/node_modules/') && !/^(import|export)\b/m.test(sf.text) && /^declare\s+(module|namespace)\s+(android|androidx|java|javax|com|org|kotlin|io)\b/m.test(sf.text));
	if (b.workers?.length) {
		const writes = sharedWorkerState(b.program, b.workers, new Set([...b.modules, ...b.components.map((c) => c.file), ...(b.compiledPlugins ?? [])]), b.resolved);
		if (writes.length) throw sharedWorkerStateError(writes, b.app);
	}
	const moduleFiles = [...new Set([...b.modules, ...b.components.map((c) => c.file), ...(b.compiledPlugins ?? [])])];
	// Which modules run on the main thread only; a worker's script reaching one stops the build with the import chain.
	const threads = moduleThreads({ program: b.program, modules: moduleFiles, workers: b.workers, resolved: b.resolved, coreModuleOf: (f) => /[\\/]@nativescript[\\/]core[\\/](.+)$/.exec(f)?.[1] ?? null });
	// A module only `await import(…)` reaches (and what only it imports) runs when it is imported, as the bundle evaluates
	// it then, not at launch: its top level may read what the app has only once it runs (the start activity).
	const lazy = importedLazily(b.program, moduleFiles, b.resolved);
	const translator = new Translator(b.checker, b.infos, b.files, {
		...b.context.translation(),
		pluginFiles: b.pluginFiles,
		reach: b.reach,
		properties: b.properties,
		lenientApp: !!b.lenient,
		assignFields: !!b.assignFields,
		xmlMemberKeys: b.xmlMemberKeys,
		core: (t) => new CoreKotlin(t),
		native: (t) => {
			const api = new AndroidNativeAPI(t, classPath);
			for (const p of b.plugins ?? []) for (const typing of p.typings) api.pluginTypings.add(typing);
			for (const sf of appTypings) api.pluginTypings.add(sf.fileName);
			return api;
		},
		hooks: b.translatorHooks,
		appModule: pkg,
		allowUnapplied: !!b.allowUnapplied,
		lines: b.lines,
		errors: b.allErrors ? [] : null,
		plainFields: !!b.translatorHooks?.plainFields,
		appMembersByName: !!b.xml && !b.xmlMemberKeys,
		pluginRoots: (b.plugins ?? []).map((p) => p.root + '/'),
		workerScripts: new Map((b.workers ?? []).map((f) => [f, relative(b.app, f)])),
		moduleThread: (file) => threads.get(file),
		moduleKey: lazy.size ? (file) => relative(b.app, file) : undefined,
	});
	// Components whose class could not be written (`--keep-going`): a root view of one is left as it is.
	const unwritten = new Set<string>();
	const kotlinClass = (name: string) => programClassName(translator, name);
	const componentClass = (name: string) => {
		const c = b.components.find((x) => x.name === name);
		const sf = c && b.program.getSourceFile(c.file);
		return sf?.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name) ?? sf?.statements.find(ts.isClassDeclaration);
	};
	const rootView = (name: string, make: string) => {
		const cls = b.translatorHooks?.wrapsRootViews && !unwritten.has(name) ? componentClass(name) : undefined;
		return cls ? translator.rootView(cls, kotlinClass(name), make) : make;
	};
	const table: Record<string, [number, string, number][]> = {};
	/** A Kotlin file as written, its markers turned into ranges of the line table: [first Kotlin line, source file, source line]. */
	// App code names the Java classes of the kit's signatures by aliases (`android_animation_Animator`), as the kit index
	// reads them, whether the kit imports them under that alias or by their simple names.
	let kitAliases: Map<string, string> | null = null;
	const withKitAliases = (code: string): string => {
		if (!/\b(android|androidx|java|javax|com|org|kotlin|io)_\w+/.test(code)) return code;
		if (!kitAliases) {
			kitAliases = new Map();
			const dir = join(KIT_ANDROID, 'generated/kotlin/org/nativescript/kit');
			for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
				if (!f.endsWith('.kt')) continue;
				for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/^import ([\w.]+?\.[A-Z]\w*)(?: as (\w+))?$/gm)) kitAliases.set(m[2] ?? m[1].replace(/\./g, '_'), m[1]);
			}
		}
		const used = [...new Set(code.match(/\b(?:android|androidx|java|javax|com|org|kotlin|io)_\w+/g) ?? [])].filter((a) => kitAliases!.has(a));
		return used.length ? code.replace('import org.nativescript.kit.*\n', `import org.nativescript.kit.*\n${used.map((a) => `import ${kitAliases!.get(a)} as ${a}\n`).join('')}`) : code;
	};
	// Written once formatted, in one ktfmt run where a ktfmt jar is already present (a build never fetches one); the
	// source-line markers stay through formatting.
	const pending: { file: string; code: string }[] = [];
	const write = (file: string, text: string) => {
		const annotations = THREAD_ANNOTATIONS.filter((a) => new RegExp(`@${a}\\b`).test(text))
			.map((a) => `import androidx.annotation.${a}\n`)
			.join('');
		const code = annotations ? text.replace('import org.nativescript.kit.*\n', `import org.nativescript.kit.*\n${annotations}`) : text;
		pending.push({ file, code: withKitAliases(code) });
	};
	const flush = () => {
		const formatted = formatKotlin(pending.map((p) => p.code));
		// ktfmt leaves a file it cannot format, and every file where there is no jar, as written. The kit import goes in
		// after formatting, which drops an import nothing names.
		pending.forEach((p, k) => written(p.file, hideKitAndroid(formatted[k]), formatted[k] !== p.code));
	};
	const written = (file: string, code: string, formatted: boolean) => {
		if (!b.lines) {
			writeFileSync(file, SourceLines.strip(code));
			return;
		}
		const located = b.lines.kotlin(code, formatted);
		writeFileSync(file, located.code);
		const ranges: [number, string, number][] = [];
		located.lines.forEach((at, i) => {
			const last = ranges.at(-1);
			if (at ? !last || last[1] !== sourceName(b.app, at.file, b.context.adapter) || last[2] !== at.line : last && last[2] !== 0) ranges.push([i + 1, at ? sourceName(b.app, at.file, b.context.adapter) : '', at?.line ?? 0]);
		});
		if (ranges.length) table[basename(file)] = ranges;
	};
	const hideKitAndroid = (code: string) => withKitAndroidHidden(code, (translator.native as AndroidNativeAPI).hidesKitAndroid());
	const header = (from: string, template?: string) => `${headerLine(sourceName(b.app, from, b.context.adapter), template && (dirname(template) === dirname(from) ? basename(template) : sourceName(b.app, template, b.context.adapter)))}\npackage ${pkg}\n\nimport org.nativescript.kit.*\n\n`;
	// A component's file is a module too: what it declares beside the component (its constants and helpers).
	const modules = translateKotlinModules(translator, b.program, moduleFiles, b.resolved, b.app);
	for (const c of b.components) {
		const cls = componentClass(c.name)!;
		try {
			const { params, lines, statics } = translator.componentMembers(cls, c.props);
			const conformance = translator.componentConformance(cls);
			const declared = (l: string) => /^ {4}(?:@\S+ )*(?:lateinit )?(?:val|var|fun) `?(\w+)/.exec(l)?.[1];
			const members = lines.map((l) => (conformance.overrides.has(declared(l) ?? '') ? l.replace(/^ {4}((?:@\S+ )*)/, '    $1override ') : l));
			const ctorFields = params.map((x) => (conformance.overrides.has(/^(?:@\S+ )*(?:val|var) `?(\w+)/.exec(x)?.[1] ?? '') ? `override ${x}` : x));
			const supertypes = conformance.supertypes.length ? ` : ${conformance.supertypes.join(', ')}` : '';
			const body = [`${translator.threadAnnotation(cls)}class ${kotlinClass(c.name)}(${ctorFields.join(', ')})${supertypes} {`, ...members, ...conformance.lines, ...(statics.length ? ['    companion object {', ...statics, '    }'] : []), SourceLines.end, ...render(c, b.infos, { behaviour: b.behaviour, propValue: (child, p, m) => translator.propValue(cls, componentClass(child), p, m), kotlinClass: (name) => (b.elementClasses.has(name) || b.infos.has(name) ? kotlinClass(name) : name) }), '}'];
			const source = b.componentSource?.(c) ?? c.file.replace(/\.ts$/, '');
			write(join(sources, c.name + '.kt'), header(source, c.templateLines?.file !== source ? c.templateLines?.file : undefined) + body.join('\n') + '\n');
		} catch (e) {
			unwritten.add(c.name);
			if (!translator.errors) throw e;
			translator.errors.push(`${c.name}: ${(e as Error).message}`);
		}
	}
	if (translator.errors?.length) throw new Error(`${new Set(translator.errors).size} constructs the release build cannot translate yet:\n  ${[...new Set(translator.errors)].join('\n  ')}`);
	addKotlinInterfaces(translator, modules);
	// File names differ in more than case: a module `streamdown.tsx` beside a component `Streamdown` would overwrite it on a case-insensitive disk.
	const taken = new Set(b.components.map((c) => c.name.toLowerCase()));
	for (const m of modules) {
		if (!m.code.trim()) continue;
		let file = m.name;
		while (taken.has(file.toLowerCase())) file += '_module';
		taken.add(file.toLowerCase());
		write(join(sources, file + '.kt'), header(m.file) + m.code);
	}
	flush();
	writeFileSync(join(b.out, 'source-lines.json'), JSON.stringify({ package: pkg, files: table }) + '\n');
	const shapes = SourceLines.strip(translator.shapesCode());
	if (shapes) writeFileSync(join(sources, '__Objects.kt'), hideKitAndroid(`// Compiled by ns-compiled: the app's object literals without a declared type.\npackage ${pkg}\n\nimport org.nativescript.kit.*\n\n${shapes}\n`));
	// A worker script's top level runs on its worker's thread, not with the app's modules.
	const workers = modules
		.filter((m) => translator.workerScripts!.has(m.file))
		.map((m) => `        JSWorker.register(${kotlinString(translator.workerScripts!.get(m.file)!)}) { ${m.init ? `try { ${m.init}() } catch (__e: Throwable) { ${RT.jsReportThrown}(__e) }` : ''} }\n`)
		.join('');
	const lazyFiles = new Set(lazy.keys());
	const loader = (m: KotlinModule) => `__load_${m.name}`;
	const lazyLoaders = modules
		.filter((m) => m.init && lazyFiles.has(m.file))
		.map((m) => `private var ${loader(m)}_done = false\nprivate fun ${loader(m)}() {\n    if (${loader(m)}_done) return\n    ${loader(m)}_done = true\n    ${m.init}()\n}\n`)
		.join('\n');
	const lazyImports = [...lazy]
		.map(
			([file, runs]) =>
				`        AppModules.registerImport(${kotlinString(translator.moduleKey!(file))}) { ${modules
					.filter((m) => m.init && runs.has(m.file))
					.map((m) => `${loader(m)}()`)
					.join('; ')} }\n`,
		)
		.join('');
	const frameworkEntry = b.entry?.({ components: b.infos, rootView, className: kotlinClass, string: kotlinString }) ?? {};
	const eagerInits = modules.filter((m) => m.init && !translator.workerScripts!.has(m.file) && !lazyFiles.has(m.file));
	// Inline try/catch rather than a lambda to satisfy Android lint's WrongThreadInterprocedural check.
	const eagerBlock = eagerInits.length ? `        try {\n${eagerInits.map((m) => `            ${m.init}()\n`).join('')}        } catch (__e: Throwable) {\n            ${RT.jsReportThrown}(__e)\n        }\n` : '';
	const inits = (frameworkEntry.setup ?? '') + workers + lazyImports + eagerBlock;
	const routes = frameworkEntry.beforeRoot ?? '';
	// Set before the module initializers run: they may make views.
	const switches = uncaughtErrorSwitches(b.app, 'android');
	// A binding's objects are in place before any module runs, as the plugin's engine module is installed at startup.
	const installs = (b.bindings ?? []).map((x) => `        ${x.installer}.install()\n`).join('');
	// Core's own activity runs the app, which the app's `android.app.Application` starts, as NativeScript's runtime does,
	// with the stylesheet as its build parses it.
	const extract = copyAndroidAppFiles(b.app, b.appDir, join(b.out, 'src', 'main', 'assets')) ? '        NativeScriptApplication.extractAppFiles(this)\n' : '';
	let xmlModules = '';
	if (b.xml) {
		// An element the kit has no class for (`<template>`, a platform block) is the Builder's own, or fails where a page names it, as in JavaScript.
		const kit = new Set((translator.core as CoreKotlin).kitElements());
		const elements = b.xml.elements.filter((e) => kit.has(e));
		xmlModules = [
			// With the XML-free overlay nothing reads a file's text (each has a factory); its name still resolves.
			...b.xml.pages.map((x) => `        AppModules.register(${kotlinString(x.name)}) { ${kotlinString(b.xmlRunTimeFree ? '' : x.text)} }\n`),
			...b.xml.styles.map((s) => `        AppModules.register(${kotlinString(s.name)}) { ${RT.jsJSONParse}(${kotlinString(s.ast)}) }\n`),
			`        AppModules.register(listOf("@nativescript/core/ui")) { ${jsObjectCode(elements.map((e) => [kotlinString(e), `${e}::class.java`]))} }\n`,
		].join('');
	}
	// XML core's Builder parses at run time in an app of another framework (a ListView's `stickyHeaderTemplate`): the elements it names.
	if (!b.xml) {
		const kit = new Set((translator.core as CoreKotlin).kitElements());
		const named = new Set<string>();
		const visit = (nodes: TNode[]) => {
			for (const n of nodes) {
				if (n.kind === 'template' && n.xml) for (const m of n.xml.matchAll(/<([A-Z][\w.]*)/g)) if (kit.has(m[1])) named.add(m[1]);
				if ('children' in n && Array.isArray(n.children)) visit(n.children as TNode[]);
				if ('body' in n && Array.isArray(n.body)) visit(n.body as TNode[]);
				if ('branches' in n && Array.isArray(n.branches)) for (const br of n.branches as { body: TNode[] }[]) visit(br.body);
				if ('fallback' in n && Array.isArray(n.fallback)) visit(n.fallback as TNode[]);
				if ('slots' in n && n.slots) for (const slotNodes of Object.values(n.slots as Record<string, TNode[]>)) visit(slotNodes);
			}
		};
		for (const c of b.components) visit(c.template);
		if (named.size) xmlModules = `        AppModules.register(listOf("@nativescript/core/ui")) { ${jsObjectCode([...named].sort().map((e) => [kotlinString(e), `${e}::class.java`]))} }\n`;
	}
	const makeRoot = b.behaviour.kit?.construct ? `${b.behaviour.kit.construct} { ${kotlinClass(b.root)}() }` : `${kotlinClass(b.root)}()`;
	const run = `${extract}${installs}${switches}        Reactivity.schedule = Reactivity.Schedule.${b.behaviour.schedule.toUpperCase()}\n` + (b.mounted ? `        NativeScriptApplication.prepare(cssAST = appCSS)\n        CoreModules.initialize()\n${xmlModules}${inits}` : `        NativeScriptApplication.prepare(cssAST = appCSS)\n        CoreModules.initialize()\n${xmlModules}${inits}${routes}        NativeScriptApplication.start { ${rootView(b.root, `${makeRoot}.${b.infos.get(b.root)!.members.render}()`)} }\n`);
	writeFileSync(
		join(sources, '__Entry.kt'),
		hideKitAndroid(`// Compiled by ns-compiled: the app's entry and its CSS.
package ${pkg}

import org.nativescript.kit.*

/** The app, started before core's activity (com.tns.NativeScriptActivity) shows it. */
class MainApplication : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
${run}    }
}

val appCSS = ${kotlinString(b.cssAST ?? '{"type":"stylesheet","stylesheet":{"rules":[]}}')}
${lazyLoaders ? '\n' + lazyLoaders : ''}`),
	);

	say(`${b.components.length} components and ${b.modules.length} modules from ${b.framework} compiled to Kotlin in ${Date.now() - started} ms → ${relative(process.cwd(), sources)}`);

	// The Gradle project: this app module, and the kit as a library module.
	const appResources = join(appResourcesDir(b.app), 'Android');
	const main = join(appResources, 'src', 'main');
	const resources = join(main, 'res');
	if (!widgets) throw new Error('@nativescript/core is not installed in the app (its widgets AAR is the layout the native build links); run npm install, or pass --widgets <aar>');
	const applicationId = b.applicationId ?? `${pkg}.native`;
	// A plugin built into an AAR brings its manifest as a library's; the merger takes it from there.
	const overlays = pluginManifests({ app: b.app, applicationId, dir: join(b.out, 'plugin-manifests'), except: new Set((b.plugins ?? []).map((p) => p.name)), stubbed: b.context.stubbedPlugins });
	const gradleFile = (f: string) => (existsSync(join(appResources, f)) ? `apply(from = ${kotlinString(join(appResources, f))})\n` : '');
	// The app's own resources, which script names at run time (`res://ic_settings`, `getIdentifier`): kept by the resource shrinker.
	const named = existsSync(resources)
		? readdirSync(resources)
				.sort()
				.flatMap((dir) => {
					const type = /^(drawable|mipmap|raw|font|layout|xml)(-|$)/.exec(dir)?.[1];
					return type
						? readdirSync(join(resources, dir))
								.sort()
								.map((f) => `@${type}/${f.replace(/\..*$/, '')}`)
						: [];
				})
		: [];
	const keep = join(b.out, 'src', 'main', 'res', 'raw');
	if (named.length) {
		mkdirSync(keep, { recursive: true });
		writeFileSync(join(keep, 'ns_app_resources_keep.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="${[...new Set(named)].sort().join(',')}" />\n`);
	}
	if (b.bindings?.length) {
		mkdirSync(join(b.out, 'bindings'), { recursive: true });
		writeFileSync(join(b.out, 'bindings', 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.22)\nproject(bindings)\n${b.bindings.map((x, k) => `add_subdirectory(${JSON.stringify(x.jni)} binding${k})\n`).join('')}`);
	}
	// The version the app's manifest declares, as the runtime's build keeps it; app.gradle, applied last, may set it again.
	const manifestText = existsSync(join(main, 'AndroidManifest.xml')) ? readFileSync(join(main, 'AndroidManifest.xml'), 'utf8') : '';
	const version = {
		code: /android:versionCode\s*=\s*"(\d+)"/.exec(manifestText)?.[1] ?? '1',
		name: /android:versionName\s*=\s*"([^"]+)"/.exec(manifestText)?.[1] ?? JSON.parse(readFileSync(join(b.app, 'package.json'), 'utf8')).version ?? '1.0.0',
	};
	writeFileSync(
		join(b.out, 'settings.gradle.kts'),
		`pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
${native.repositories.map((r) => `        maven { url = uri(${kotlinString(r)}) }\n`).join('')}    }
}
rootProject.name = ${kotlinString(b.name)}
include(":kit")
project(":kit").projectDir = file(${kotlinString(kitProjectDir(b.out))})
`,
	);
	// The adapter's Kotlin for this build's kit, compiled into the kit's project.
	const { android: adapterKotlin, androidGenerated } = b.context.adapter.kit;
	const adapterSources = [adapterKotlin, androidGenerated].filter((d): d is string => !!d && existsSync(d));
	writeFileSync(
		join(b.out, 'gradle.properties'),
		`org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8
android.useAndroidX=true
nativescriptWidgetsAar=${widgets}
${overlay ? `kitOverlay=${join(KIT_ANDROID, 'overlays', XML_FREE_OVERLAY)}\nkitOverlayReplaces=${overlay.replaces.join(',')}\n` : ''}${adapterSources.length ? `kitAdapterSources=${adapterSources.join(',')}\n` : ''}`,
	);
	writeFileSync(
		join(b.out, 'build.gradle.kts'),
		`plugins {
    id("com.android.application") version "8.12.1"
    id("com.android.library") version "8.12.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20"
}
${gradleFile('before-plugins.gradle')}
android {
    namespace = ${kotlinString(pkg)}
    compileSdk = 36

    defaultConfig {
        applicationId = ${kotlinString(applicationId)}
        minSdk = ${native.minSdk}
        targetSdk = 36
        versionCode = ${version.code}
        versionName = ${kotlinString(version.name)}
${bindingDefines.length ? `        externalNativeBuild { cmake { arguments += listOf(${bindingDefines.map(kotlinString).join(', ')}) } }\n` : ''}    }
${b.bindings?.length ? `    ndkVersion = ${kotlinString(ndk().version)}\n    externalNativeBuild { cmake { path = file(${kotlinString(join(b.out, 'bindings', 'CMakeLists.txt'))}) } }\n${b.bindings.map((x) => `    sourceSets["main"].java.srcDirs(${kotlinString(x.kotlin)})\n`).join('')}` : ''}
    sourceSets["main"].res.srcDirs(${kotlinString(resources)}, "src/main/res")
${['java', 'assets']
	.filter((d) => existsSync(join(main, d)))
	.map((d) => `    sourceSets["main"].${d}.srcDirs(${kotlinString(join(main, d))})\n`)
	.join('')}
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed with the debug key so the release build installs as is.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
${packagingBlock(native.packaging)}}

// The settings' repositories again: an app.gradle declaring its own would leave the project only those.
repositories {
    google()
    mavenCentral()
${native.repositories.map((r) => `    maven { url = uri(${kotlinString(r)}) }\n`).join('')}}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":kit"))
${native.archives.map((a) => `    implementation(files(${kotlinString(a)}))\n`).join('')}${native.dependencies.map((d) => `    ${d.configuration}(${kotlinString(d.coords)})\n`).join('')}${native.constraints.length ? `    constraints {\n${native.constraints.map((d) => `        ${d.configuration}(${kotlinString(d.coords)})\n`).join('')}    }\n` : ''}}
${native.excludes.length ? `\nconfigurations.all {\n${native.excludes.map((e) => `    exclude(${[e.group !== undefined ? `group = ${kotlinString(e.group)}` : '', e.module !== undefined ? `module = ${kotlinString(e.module)}` : ''].filter(Boolean).join(', ')})\n`).join('')}}\n` : ''}${
			overlays.length
				? `
// The plugins' manifests, merged into the app's as the plugins' own would be.
androidComponents {
    onVariants { variant ->
${overlays.map((m) => `        variant.sources.manifests.addStaticManifestFile(${kotlinString(m)})\n`).join('')}    }
}
`
				: ''
		}${b.lines ? composedMappingBlock(b.out) : ''}${gradleFile('app.gradle')}`,
	);
	// The app's members are reached by name through reflection, as the kit's are.
	writeFileSync(join(b.out, 'proguard-rules.pro'), `-dontwarn org.nativescript.widgets.**\n-keep class ${pkg}.** { *; }\n${kitKeepRules(!!b.narrowKitKeeps, overlay?.unkept ?? [])}${native.keepRules.map((r) => `${r}\n`).join('')}${reflectedMemberRules([join(b.out, 'src'), join(kit, 'src'), join(kit, 'generated'), ...(b.bindings ?? []).map((x) => x.kotlin), ...[adapterKotlin, androidGenerated].filter((d): d is string => !!d)])}`);
	mkdirSync(join(b.out, 'src', 'main', 'res', 'values'), { recursive: true });
	// The runtime template's strings.xml, named after the folder (letters and digits only), unless App_Resources replaces the file.
	const label = basename(resolve(b.app)).replace(/[^a-zA-Z0-9]/g, '');
	if (!existsSync(join(resources, 'values', 'strings.xml')))
		writeFileSync(
			join(b.out, 'src', 'main', 'res', 'values', 'strings.xml'),
			`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${label}</string>
    <string name="title_activity_kimera">${label}</string>
</resources>
`,
		);
	copyAndroidFonts(b.appDir, join(b.out, 'src', 'main', 'assets'));
	// App_Resources' manifest, else the runtime template's activity: the launch theme, then AppTheme once created.
	const activity = 'com.tns.NativeScriptActivity';
	writeFileSync(
		join(b.out, 'src', 'main', 'AndroidManifest.xml'),
		androidManifest({ app: b.app, applicationId, activity, application: `${pkg}.MainApplication` }) ??
			`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:name="${pkg}.MainApplication"
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/AppTheme"
        android:hardwareAccelerated="true">
        <activity
            android:name="${activity}"
            android:label="@string/title_activity_kimera"
            android:configChanges="keyboard|keyboardHidden|orientation|screenSize|smallestScreenSize|screenLayout|locale|uiMode"
            android:theme="@style/LaunchScreenTheme"
            android:hardwareAccelerated="true"
            android:launchMode="singleTask"
            android:exported="true">
            <meta-data android:name="SET_THEME_ON_LAUNCH" android:resource="@style/AppTheme" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,
	);

	if (b.build) {
		const { spawnSync } = await import('node:child_process');
		const { mapKotlinDiagnostics } = await import('../../kotlin/diagnostics.ts');
		// Signed with the keystore when one is given, as Android Studio's signed builds inject it.
		const k = b.keyStore;
		const signing = k ? [`-Pandroid.injected.signing.store.file=${resolve(k.path)}`, `-Pandroid.injected.signing.store.password=${k.password}`, `-Pandroid.injected.signing.key.alias=${k.alias}`, `-Pandroid.injected.signing.key.password=${k.aliasPassword}`] : [];
		// Kotlin's errors point into the generated files: printed with the TypeScript lines they came from.
		const gradle = spawnSync(join(kit, 'gradlew'), ['-p', b.out, ':assembleRelease', ...(b.bundle ? [':bundleRelease'] : []), ...signing, '--quiet'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 30 });
		process.stdout.write(mapKotlinDiagnostics(gradle.stdout ?? '', b.out));
		process.stderr.write(mapKotlinDiagnostics(gradle.stderr ?? '', b.out));
		if (gradle.status !== 0) throw new Error(`the Gradle build failed (exit ${gradle.status ?? gradle.signal})`);
		const apk = join(b.out, 'build', 'outputs', 'apk', 'release', `${b.name}-release.apk`);
		say(`built ${relative(process.cwd(), existsSync(apk) ? apk : join(b.out, 'build', 'outputs', 'apk', 'release'))}`);
		const aab = join(b.out, 'build', 'outputs', 'bundle', 'release', `${b.name}-release.aab`);
		if (b.bundle) say(`built ${relative(process.cwd(), aab)}`);
		if (!k) say('no --key-store-path: signed with the debug key, which installs for testing but no store accepts');
	}
}

/** The widgets AAR @nativescript/core ships, from the app's node_modules (or a parent's). */
function findWidgetsAar(app: string): string | null {
	for (let dir = app; ; dir = dirname(dir)) {
		const candidate = join(dir, 'node_modules', '@nativescript', 'core', 'platforms', 'android', 'widgets-release.aar');
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) return null;
	}
}

/**
 * Keep rules for the members code reaches on Java objects by name (`detector.onTouchEvent(e)` on a value typed
 * `any`, `typeof feature.getOrientation`): R8 would otherwise rename or drop a library's method, and the read
 * finds nothing while the static calls beside it still work. Those lookups see public members and static fields
 * (jsJavaGet, jsJavaHas, jsNativePropertyGet); jsCallDeclared also sees a class's non-public methods.
 */
function reflectedMemberRules(roots: string[]): string {
	const names = new Set<string>();
	const declared = new Set<string>();
	const args = '\\((?:[^()"]|\\((?:[^()"]|\\([^()]*\\))*\\))*?,\\s*"([A-Za-z_$][\\w$]*)"';
	const access = new RegExp(`\\bjs(?:CallMethod|CallMethodIfPresent|Get|GetOptional|Set|Field|JavaGet|JavaSet|HasKey|NativePropertyGet|NativePropertySet)${args}`, 'g');
	const declaredAccess = new RegExp(`\\b${RT.jsCallDeclared}${args}`, 'g');
	const visit = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
			if (entry.isDirectory()) {
				if (entry.name !== 'build') visit(join(dir, entry.name));
			} else if (entry.name.endsWith('.kt')) {
				const text = readFileSync(join(dir, entry.name), 'utf8');
				for (const m of text.matchAll(access)) names.add(m[1]);
				for (const m of text.matchAll(declaredAccess)) declared.add(m[1]);
			}
		}
	};
	roots.forEach(visit);
	if (!names.size && !declared.size) return '';
	return `-keepclassmembers class * {\n${[...names]
		.sort()
		.map((n) => `    public *** ${n}(...);\n    public *** ${n};\n    static *** ${n};\n`)
		.join('')}${[...declared]
		.sort()
		.map((n) => `    *** ${n}(...);\n`)
		.join('')}}\n`;
}

/**
 * The kit's own keeps. By default every class and member of org.nativescript is kept, as script reaches them by
 * name. `narrow` keeps what the runtime's reflection needs and lets R8 drop the rest: class names (getClass,
 * `constructor.name`, the runtime telling its objects by package), the names of the members that remain (jsJavaGet
 * and computed keys), constructors (jsNew of a class held as a value), companions' fromJS (jsConvertTo) and view
 * getters (kitSet's accessor check). A kit member reached only through a computed key and referenced nowhere else
 * is dropped under `narrow`.
 */
function kitKeepRules(narrow: boolean, unkept: string[]): string {
	// `unkept`: the XML run time's classes, which an app with the XML-free overlay keeps only where code still names them.
	if (!narrow) return `-keep class ${[...unkept.flatMap((c) => [`!${c}`, `!${c}$*`]), 'org.nativescript.**'].join(',')} { *; }\n`;
	return ['-keepnames class org.nativescript.**', '-keepclassmembernames class org.nativescript.** { *; }', '-keepclassmembers class org.nativescript.** { <init>(...); }', '-keepclassmembers class org.nativescript.** { public static ** Companion; }', '-keepclassmembers class org.nativescript.**$Companion { public *** fromJS(...); }', '-keepclassmembers class * extends org.nativescript.kit.ViewBase { public *** get*(); }'].join('\n') + '\n';
}

/**
 * The modules only `await import(…)` reaches, each with what running it runs first (itself and the modules only
 * `await import(…)` reaches that it imports). The module registry (`__app_modules`) imports every module to name its
 * exports, as the bundle's does without running them: it is no importer here.
 */
function importedLazily(program: ts.Program, files: string[], resolved?: (containing: string, specifier: string) => string | undefined): Map<string, Set<string>> {
	const all = new Set(files);
	const registry = (f: string) => basename(f) === '__app_modules.ts';
	const statics = new Map(files.map((f) => [f, registry(f) ? [] : evaluatedImports(program, f, all, resolved, false)]));
	const targets = new Set(files.flatMap((f) => evaluatedImports(program, f, all, resolved, true)));
	if (!targets.size) return new Map();
	const imported = new Set([...statics.values()].flat());
	const closure = (roots: string[]) => {
		const seen = new Set<string>();
		const visit = (f: string) => {
			if (seen.has(f)) return;
			seen.add(f);
			for (const g of statics.get(f) ?? []) visit(g);
		};
		roots.forEach(visit);
		return seen;
	};
	const eager = closure(files.filter((f) => !imported.has(f) && !targets.has(f)));
	const lazy = [...closure([...targets])].filter((f) => !eager.has(f));
	return new Map(lazy.map((f) => [f, new Set([...closure([f])].filter((g) => !eager.has(g)))]));
}

/**
 * R8's mapping composed with the line tables as R8 writes it (targets/android/compose-mapping.ts), so the bundle's mapping and what crash
 * reporters' upload tasks read (Crashlytics, Sentry) name source files and lines. It runs in R8's own task: those read the
 * task's output, which no other task can replace. The tables are its inputs, as a moved source line changes no class.
 */
function composedMappingBlock(out: string): string {
	const kit = join(KIT_ANDROID, 'generated', 'source-lines.json');
	const tables = [join(out, 'source-lines.json'), ...(existsSync(kit) ? [kit] : [])];
	const command = [process.execPath, join(PACKAGE, 'bin', 'ns-compiled-retrace.js'), '--compose-mapping', out];
	return `
// R8's mapping.txt in the app's source lines (ns-compiled-retrace --compose-mapping); R8's own is kept as mapping-kotlin.txt.
tasks.matching { it.name == "minifyReleaseWithR8" }.configureEach {
    val command = listOf(${command.map(kotlinString).join(', ')})
    inputs.files(${tables.map(kotlinString).join(', ')})
    outputs.file(layout.buildDirectory.file("outputs/mapping/release/mapping-kotlin.txt"))
    doLast {
        val status = try { ProcessBuilder(command).inheritIO().start().waitFor() } catch (e: java.io.IOException) { -1 }
        if (status != 0) logger.error("warning: mapping.txt is R8's own, in Kotlin lines: composing it with source-lines.json failed (exit \$status)")
    }
}
`;
}

/** The first line of a generated file, which ktfmt keeps on one line only within its 100 columns. */
function headerLine(source: string, template?: string): string {
	const named = template ? `${source} (+ ${template})` : source;
	const lines = [`${named}; edit that file, not this one.`, named, source].map((s) => `// Compiled by ns-compiled from ${s}`);
	return lines.find((l) => l.length <= 100) ?? lines.at(-1)!;
}
