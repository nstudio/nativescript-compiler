// The iOS target: the app's components and modules as Swift against NativeScriptKit, in an Xcode project (generated with
// XcodeGen, integrated with CocoaPods where the app has pods) whose resources are the app's own App_Resources/iOS.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { ComponentIR } from '../../api/ir.ts';
import type { FrameworkAdapter, FrontEndResult, TemplateBehaviour } from '../../api/adapter-api.ts';
import type { BuildContext } from '../../program/build-context.ts';
import type { Reach } from '../../program/reach.ts';
import type { Properties } from '../../program/properties.ts';
import type { XmlMemberKeys } from '../../semantics/states/value-states.ts';
import type { XmlApp } from '../../xml/app.ts';
import type { Stylesheet } from '../../css/css.ts';
import { kitAst } from '../../css/css.ts';
import { corePatchRefusal as corePatchRefused } from '../../program/core-patches.ts';
import { nodeModules } from '../../program/program.ts';
import { SourceLines } from '../../program/source-lines.ts';
import type { Binding } from '../../plugins/bindings.ts';
import { writtenStrict, type PluginSources } from '../../plugins/source.ts';
import { moduleNames, pluginNative, scopedImports, usedImports, xcodegenLines, type ModuleTypes } from '../../plugins/native-ios.ts';
import { NONISOLATED_DEINIT, RT, swiftString, withoutRedundantImplicit } from '../../swift/syntax.ts';
import { Translator, type ComponentInfo } from '../../swift/translator.ts';
import { render } from '../../swift/render.ts';
import { addInterfaces, translateModules } from '../../swift/app-modules.ts';
import { nativeDispatch, untypedMembers } from '../../swift/native/dispatch.ts';
import { nativeTable, type NativeClass, type NativeMethod } from '../../swift/native/sdk.ts';
import { adapterRuntimeFiles, readKitManifest } from '../../kit/manifest.ts';
import { OVERLAY_FILE, XML_FREE_OVERLAY, type KitOverlay } from '../../kit/overlay.ts';
import { appResourcesDir, uncaughtErrorSwitches } from '../resources.ts';
import { iosDeploymentTarget, iosExtensionNames, iosExtensions, iosProjectResources, mergePodsXcconfig } from './resources.ts';
import { generateProject, iosDependencies, packageLines, podfile, productLines, PROJECT_MARKER, removePods, swiftPackages } from './dependencies.ts';
import { coreNativeModules, coreNativeProject, installedCore, loadCoreNativeTables } from './core-native.ts';
import { TRACEABLE_SWIFT_FLAGS } from './retrace.ts';
import { archive, automaticSigningSettings, findProfile, signingSettings, type ExportMethod } from './signing.ts';
import { mirror, writeIfChanged } from '../../driver/mirror.ts';
import { KIT_APPLE, PACKAGE } from '../../driver/paths.ts';
import { compiledEnv } from '../../program/env.ts';
import { programClassName } from '../../semantics/top-names.ts';
import { sharedWorkerState, sharedWorkerStateError } from '../../semantics/worker-state.ts';

export interface IosBuild {
	/** The build's context: its framework adapter, plugin stand-ins and refusals. */
	context: BuildContext;
	app: string;
	/** The app folder (`app/`), whose files the XML pages and stylesheets are named from. */
	appDir: string;
	/** The project's folder. */
	out: string;
	name: string;
	framework: string;
	/** The framework's adapter; null for a plain XML app. */
	adapter: FrameworkAdapter | null;
	behaviour: TemplateBehaviour;
	/** The framework's code in the generated entry. */
	entry?: FrontEndResult['entry'];
	components: ComponentIR[];
	modules: string[];
	program: ts.Program;
	checker: ts.TypeChecker;
	/** The app's files and the components' virtual files, in translation order. */
	files: readonly ts.SourceFile[];
	infos: Map<string, ComponentInfo & { initThrows?: boolean; throwingSetters?: string[]; setters?: string[] }>;
	/** The classes of the tags the app registers (`registerElement`): a component's template names each by its class. */
	elementClasses: ReadonlySet<string>;
	/** The component the app starts with; the app mounts its own roots where `mounted`. */
	root: string;
	mounted: boolean;
	/** A plain XML app: its pages, page stylesheets and the elements its XML names. */
	xml: XmlApp | null;
	/** The page stylesheets, each applied to its page by core's Builder. */
	pageSheets: Stylesheet[];
	/** The app's stylesheets. */
	sheets: Stylesheet[];
	/** Every XML site of the app built at build time: the app compiles the kit's XML-free overlay (kit/overlay.ts). */
	xmlRunTimeFree: boolean;
	xmlMemberKeys: XmlMemberKeys | null;
	lines: SourceLines | null;
	/** The file a translated file names in its header (a component's source and template, as `<package>@<version> <path>` outside the app). */
	shownSource: (file: string) => string;
	plugins: PluginSources;
	bindings: readonly Binding[];
	pluginFiles: string[];
	compiledPlugins: string[];
	reach: Reach;
	properties: Properties;
	resolved: (containing: string, specifier: string) => string | undefined;
	/** Worker scripts (`new Worker(new URL('./x.worker', import.meta.url))`), compiled as modules each worker thread runs. */
	workers?: string[];
	aliased?: (specifier: string, importer?: string) => string | undefined;
	/** The app's own configuration leaves strict checking off. */
	lenient: boolean;
	assignFields: boolean;
	/** `--allow-unimplemented-properties`, and what the property guard found otherwise (`--all-errors` reports them). */
	allowUnapplied: boolean;
	unapplied: string[];
	allErrors: boolean;
	keepGoing: boolean;
	/** `--whole-kit`: every file of the kit compiled, however little of it the app reaches. */
	wholeKit: boolean;
	bundle?: string;
	/** Build it (`xcodebuild`): for the simulator, or with `device` an archive and .ipa. */
	build: boolean;
	device: boolean;
	provision?: string;
	teamId?: string;
	exportMethod?: ExportMethod;
	say: (m: string) => void;
	/** When the build started (`Date.now()`), for the time it reports. */
	started: number;
}

/** The app as an Xcode project in `b.out`, built where `b.build` says. */
export async function writeIos(b: IosBuild): Promise<void> {
	const { context, app, appDir, out, name, framework, adapter, behaviour, components, modules, program, checker, files: sourceFiles, infos, elementClasses, root, mounted, xml, pageSheets, sheets, xmlRunTimeFree, xmlMemberKeys, lines: sourceLines, shownSource, plugins, bindings: pluginBindings, pluginFiles, compiledPlugins, reach, properties, resolved, lenient: lenientApp, assignFields: assignsFields, allowUnapplied, unapplied, say, started } = b;
	const entryCode = b.entry;
	const kit = KIT_APPLE;
	// Before the translator: it reads the plugin modules' symbol tables and which typings declare them.
	const packages = swiftPackages(app, context.stubbedPlugins);
	const deploymentTarget = iosDeploymentTarget(app, context.stubbedPlugins);
	const dependencies = iosDependencies({ app, packages, deploymentTarget, say, stubbed: context.stubbedPlugins });
	const typings = program
		.getSourceFiles()
		.filter((f) => f.isDeclarationFile)
		.map((f) => f.fileName);
	// What may declare the app's own Swift and the packages' modules: the app's declarations, and those of the plugins that add packages.
	const owners = packages.flatMap((p) => (p.pluginDir ? [p.pluginDir + '/'] : []));
	const nativeTypings = typings.filter((f) => !f.startsWith('/__shims__/') && (!f.includes('/node_modules/') || owners.some((d) => f.startsWith(d))));
	// Core's own native code (TNSWidgets, NativeScriptUtils), which app code may call as core's does (`TNSLabel.font`):
	// its tables before anything reads a module of that name, as the first read of a table is the one kept.
	const installed = installedCore(app);
	if (installed) loadCoreNativeTables(installed);
	// The dependencies' scratch build is gigabytes: removed whether or not the plugins' native code assembles.
	let native: ReturnType<typeof pluginNative>;
	try {
		native = pluginNative(plugins.all(), out, {
			deps: dependencies,
			packages,
			declarations: typings,
			say,
			bindings: pluginBindings.flatMap((b) => (b.ios ? [{ package: b.package, ...b.ios }] : [])),
			app: { module: name, src: join(appResourcesDir(app), 'iOS', 'src'), declarations: nativeTypings },
			core: installedCore(app),
		});
	} finally {
		dependencies.dispose();
	}
	// Before the translator analyzes what throws: lenient code's checks throw.
	const lenientFiles = [...pluginFiles].filter((f) => !writtenStrict(f, context.adapter));
	// The app's own Swift classes (`App_Resources/iOS/src`) that TypeScript declares untyped (`declare const X: any`): objects calling them by NativeScript's names.
	const appNative = native.appSwift ? nativeTable(name).classes : {};
	const pluginNativeClasses = new Map<string, string>();
	for (const m of native.modules) for (const [js, c] of Object.entries(nativeTable(m).classes)) if (c.kind === 'class' && !c.extension && c.module === m) pluginNativeClasses.set(js, c.swift);
	const allModuleFiles = [...new Set([...modules, ...components.map((c) => c.file), ...compiledPlugins])];
	if (b.workers?.length) {
		const writes = sharedWorkerState(
			program,
			b.workers.map((f) => f.replace(/\\/g, '/')),
			new Set(allModuleFiles.map((f) => f.replace(/\\/g, '/'))),
			resolved,
		);
		if (writes.length) throw sharedWorkerStateError(writes, app);
	}
	const translator = new Translator(checker, infos, sourceFiles, {
		...context.translation(),
		pluginFiles,
		pluginRoots: plugins.all().map((p) => p.root.replace(/\\/g, '/') + '/'),
		lenientFiles,
		reach,
		properties,
		lenientApp,
		assignFields: assignsFields,
		xmlMemberKeys,
		appSwiftNames: native.appNames,
		nativeModules: native.modules,
		hooks: adapter?.swift,
		compiledFiles: new Set(compiledPlugins),
		lines: sourceLines,
		appModule: name,
		plainFields: !!adapter?.swift?.plainFields,
		appMembersByName: !adapter && !xmlMemberKeys,
		appNativeClasses: Object.keys(appNative).filter((c) => !appNative[c].extension && appNative[c].kind === 'class'),
		pluginNativeClasses,
		pluginModules: native.modules,
		workerScripts: new Map((b.workers ?? []).map((f) => [f.replace(/\\/g, '/'), relative(app, f).replace(/\\/g, '/')])),
		resolveAlias: b.aliased ?? null,
		allowUnapplied,
		errors: b.allErrors ? (allowUnapplied ? [] : [...unapplied]) : null,
	});
	const located = (code: string) => (sourceLines ? sourceLines.swift(withoutRedundantImplicit(code)) : withoutRedundantImplicit(code));

	// Written to a scratch folder and mirrored into the project: Xcode recompiles a file whose mtime changed.
	const sourcesDir = mkdtempSync(join(tmpdir(), 'ns-compiled-sources-'));
	try {
		const header = (from: string) => `// Compiled by ns-compiled from ${shownSource(from)}; edit that file, not this one.\nimport Foundation\nimport UIKit\nimport NativeScriptKit\n${native.modules.map((m) => `import ${m}\n`).join('')}${SDK_IMPORTS}\n`;
		// A component's file declares more than the component (interfaces, constants): it is a module as well.
		// The SDK frameworks beyond UIKit the program's code names (CoreSpotlight, SafariServices), imported by every file once all are known.
		const SDK_IMPORTS = '// @sdk-imports\n';
		const translated = translateModules(translator, program, [...new Set([...modules, ...components.map((c) => c.file), ...compiledPlugins])], resolved);
		const componentClass = (name: string) => {
			const c = components.find((x) => x.name === name);
			const sf = c && program.getSourceFile(c.file);
			return sf?.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name) ?? sf?.statements.find(ts.isClassDeclaration);
		};
		// Every component's members first: whether a constructor throws is known before any template creates the component.
		const members = new Map<string, string>();
		for (const c of components) {
			const cls = componentClass(c.name)!;
			try {
				members.set(c.name, located(translator.componentMembers(cls, c.props).join('\n')));
			} catch (e) {
				if (!translator.errors) throw e;
				translator.errors.push(`${c.name}: ${(e as Error).message}`);
			}
			infos.get(c.name)!.initThrows = translator.initThrows(c.name);
			infos.get(c.name)!.throwingSetters = (c.setters ?? []).filter((p) => translator.memberThrows(cls, '$set_' + p));
		}
		/** Components whose class could not be written (`--keep-going`): a root view of one is left as it is. */
		const unwritten = new Set<string>();
		for (const c of components) {
			const cls = componentClass(c.name)!;
			try {
				const lines = [`final class ${swiftClass(c.name)}${translator.componentSuperclass(cls)} {`, NONISOLATED_DEINIT, members.get(c.name) ?? '', ...translator.componentStatics(cls), '', ...render(c, infos, (m) => translator.memberThrows(cls, m), behaviour, { itemType: (m) => translator.memberElementType(cls, m), propValue: (child, p, m) => translator.propValue(cls, componentClass(child), p, m), swiftClass: (name) => (elementClasses.has(name) || infos.has(name) ? swiftClass(name) : name) }), '}', translator.componentConformance(cls, swiftClass(c.name))];
				writeFileSync(join(sourcesDir, c.name + '.swift'), header(c.file) + lines.join('\n') + '\n');
			} catch (e) {
				unwritten.add(c.name);
				if (!translator.errors) throw e;
				translator.errors.push(`${c.name}: ${(e as Error).message}${compiledEnv('STACKS') ? '\n' + (e as Error).stack?.split('\n').slice(1, 30).join('\n') : ''}`);
			}
		}
		if (translator.errors?.length) {
			console.error([...new Set(translator.errors)].join('\n'));
			context.refusals.noteRefused(translator.errors.join('\n'));
			if (!b.keepGoing) throw new Error(`${new Set(translator.errors).size} constructs the release build cannot translate yet`);
		}
		addInterfaces(translator, translated);
		// File names differ in more than case: a module `app.tsx` beside a component `App` would overwrite it on a case-insensitive disk.
		// A file named main.swift is Swift's top-level code, which the entry's `@main` rules out.
		const taken = new Set([...components.map((c) => c.name.toLowerCase()), 'main']);
		for (const m of translated) {
			if (!m.code.trim()) continue;
			let file = m.name;
			while (taken.has(file.toLowerCase())) file += '_module';
			taken.add(file.toLowerCase());
			writeFileSync(join(sourcesDir, file + '.swift'), header(m.file) + located(m.code));
		}
		const shapes = SourceLines.strip((translator.interfacesOutside(new Set(translated.map((m) => m.file))) + translator.shapesCode()).trim());
		if (shapes) writeFileSync(join(sourcesDir, '__Objects.swift'), `// Compiled by ns-compiled: the app's object literals without a declared type.\nimport Foundation\nimport NativeScriptKit\n${native.modules.length || /\bUI[A-Z]/.test(shapes) ? `import UIKit\n${native.modules.map((m) => `import ${m}\n`).join('')}` : ''}${SDK_IMPORTS}\n${shapes}\n`);
		const isWorker = (file: string) => !!translator.workerScripts?.has(file.replace(/\\/g, '/'));
		const workerRegs = translated
			.filter((m) => isWorker(m.file))
			.map((m) => `        JSWorker.register(${swiftString(translator.workerScripts!.get(m.file.replace(/\\/g, '/'))!)}) { ${m.init ? `${m.initThrows ? 'try ' : ''}${m.init}()` : ''} }\n`)
			.join('');
		const activeInits = translated.filter((m) => m.init && !isWorker(m.file));
		const anyInitThrows = activeInits.some((m) => m.initThrows);
		const inits = workerRegs + (activeInits.length ? (anyInitThrows ? `        ${RT.jsReport} {\n${activeInits.map((m) => `            ${m.initThrows ? 'try ' : ''}${m.init}()\n`).join('')}        }\n` : activeInits.map((m) => `        ${m.init}()\n`).join('')) : '');
		// The app's CSS as its NativeScript build ships it: the AST core applies.
		const css = kitAst(sheets);
		const corePatchRefusal = corePatchRefused(app, nodeModules(app), 'ios');
		if (corePatchRefusal) {
			console.error(corePatchRefusal);
			if (!b.keepGoing) throw new Error(corePatchRefusal);
		}
		// A plain XML app's pages, page stylesheets and the core classes its XML names, registered before its modules run.
		let xmlModules = '';
		if (xml) {
			const kit = new Set(translator.kitElements());
			// An element core has no class for (an XML file of data, not a page; `<template>`) fails where a page names it, as in the app's JavaScript build.
			// Platform blocks (`<ios>`, `<visionos>`) and `<template>` are the builder's own.
			const unknown = xml.elements.filter((e) => !kit.has(e) && !['ios', 'android', 'apple', 'visionos', 'template'].includes(e));
			if (unknown.length) console.warn(`warning: ${unknown.join(', ')}: element${unknown.length > 1 ? 's' : ''} the XML names that NativeScriptKit has no class for`);
			xml.elements = xml.elements.filter((e) => kit.has(e));
			const rel = (f: string) => relative(appDir, f).split('\\').join('/');
			xmlModules = [
				// With the XML-free overlay nothing reads a file's text (each has a factory); its name still resolves.
				...xml.xml.map(
					(x) => `        AppModules.register(file: ${swiftString(x.name)}) { ${swiftString(xmlRunTimeFree && !b.wholeKit ? '' : x.text)} }
`,
				),
				...pageSheets.map(
					(sh) => `        AppModules.register(file: ${swiftString(rel(sh.file).replace(/\.scss$/, '.css'))}) { try ${RT.jsJSONParse}(${swiftString(JSON.stringify(sh.ast))}) }
`,
				),
				`        AppModules.register(["@nativescript/core/ui"]) { JSObject([${xml.elements.map((e) => `(${swiftString(e)}, JSConstructor { _ in try ${e}() } as Any?)`).join(', ')}]) }
`,
			].join('');
		}
		const frameworkEntry = entryCode?.swift?.({ components: infos, rootView, className: swiftClass, string: swiftString }) ?? {};
		// Set before the module initializers run: they may make views.
		const switches = (frameworkEntry.setup ?? '') + uncaughtErrorSwitches(app, 'ios');
		// Core's modules first, as the app's bundle evaluates @nativescript/core before its own code.
		const start =
			switches +
			`        CorePackages.useAppConfig(appPackageJSON)\n        CoreModules.initialize()\n        Reactivity.schedule = .${behaviour.schedule}\n` +
			(mounted
				? // The entry's own statements run the app (`Application.run`), after every module it imports.
					`${xmlModules}        NativeScriptApplication.prepare(cssAST: appCSS)\n${inits}`
				: `${inits}${frameworkEntry.beforeRoot ?? ''}        NativeScriptApplication.run(cssAST: appCSS) { ${rootView(root, `try ${behaviour.kit?.construct ? `${behaviour.kit.construct} { ${infos.get(root)?.initThrows ? 'try ' : ''}${swiftClass(root)}() }` : `${swiftClass(root)}()`}.${infos.get(root)!.members.render}()`)} }\n`);
		const dispatch = nativeDispatch(native.modules, untypedMembers(checker, sourceFiles), deploymentTarget, native.classes, (n) => translator.programDeclares(n) || translator.isKitType(n));
		if (dispatch) writeFileSync(join(sourcesDir, '__NativeDispatch.swift'), `// Compiled by ns-compiled: the plugins' native members untyped TypeScript calls, by name.\nimport Foundation\nimport UIKit\nimport NativeScriptKit\n${native.modules.map((m) => `import ${m}\n`).join('')}\n${dispatch}`);
		if (translator.usedAppNative.size) writeFileSync(join(sourcesDir, '__AppNative.swift'), `// Compiled by ns-compiled: the app's own Swift classes, called by name from untyped TypeScript.\nimport Foundation\nimport NativeScriptKit\n\n${appNativeObjects([...translator.usedAppNative].map((c) => appNative[c]))}`);
		const sdkModules = translator.native.sdkModules().filter((m) => !['Foundation', 'UIKit', ...native.modules].includes(m));
		// A file imports only the plugin and pod modules it names: one module that fails to build stops only the files using it.
		const pluginNames = new Map(native.modules.map((m) => [m, moduleNames(m)]));
		// So does an SDK framework: a file imports those its own code names.
		for (const m of sdkModules) pluginNames.set(m, moduleNames(m));
		// A type name two imported modules declare (the kit's `ImageAsset` and Lottie's) is the one the code means, by a scoped import.
		const moduleTypes = new Map<string, ModuleTypes>();
		for (const m of new Set(['Foundation', 'UIKit', ...native.modules, ...sdkModules])) {
			try {
				const t = nativeTable(m);
				const named = new Set<string>([
					...Object.values(t.classes)
						.filter((c) => !c.extension)
						.map((c) => c.swift),
					...Object.values(t.enums).flatMap((e) => (e.swift ? [e.swift] : [])),
					...Object.values(t.structs).map((x) => x.swift),
					...Object.keys(t.typealiases ?? {}),
				]);
				moduleTypes.set(m, { types: t.swiftTypes ?? {}, named });
			} catch {}
		}
		const kitManifest = readKitManifest(join(kit, 'Sources', 'NativeScriptKit'), context.adapter.kit.apple);
		if (kitManifest) {
			const kinds: Record<string, 'class' | 'struct' | 'enum' | 'protocol' | 'typealias'> = {};
			for (const [n, t] of Object.entries(kitManifest.types)) if (!n.includes('.') && (t.alias || ['class', 'struct', 'enum', 'protocol'].includes(t.kind))) kinds[n] = t.alias ? 'typealias' : (t.kind as 'class');
			moduleTypes.set('NativeScriptKit', { types: kinds, named: new Set(Object.keys(kinds)) });
		}
		for (const f of readdirSync(sourcesDir).sort()) {
			const p = join(sourcesDir, f);
			const text = readFileSync(p, 'utf8');
			const out = scopedImports(usedImports(text.replace(SDK_IMPORTS, sdkModules.map((m) => `import ${m}\n`).join('')), pluginNames), moduleTypes, 'NativeScriptKit', (n) => translator.programDeclares(n));
			if (out !== text) writeFileSync(p, out);
		}
		// A kit type an imported SDK module also declares (`Progress`): the app's module resolves the name to the kit's.
		const clashes = translator.native.kitClashes(translator.kitTypes());
		if (clashes.length) writeFileSync(join(sourcesDir, '__KitNames.swift'), `// Compiled by ns-compiled: the kit's types whose names the SDK also declares.\nimport NativeScriptKit\n\n${clashes.map((n) => `typealias ${n} = NativeScriptKit.${n}\n`).join('')}`);
		// Core's modules the app reaches, listed for the kit to run: nothing else names the others, so the link leaves them out.
		const appSwift = readdirSync(sourcesDir)
			.sort()
			.filter((f) => f.endsWith('.swift') && f !== '__Entry.swift')
			.map((f) => readFileSync(join(sourcesDir, f), 'utf8'))
			.join('\n');
		// The XML-free overlay's files stand in for the shared kit's two in the app's closed world and its kit target.
		const overlayDir = join(kit, 'Overlays', XML_FREE_OVERLAY);
		const overlay: KitOverlay | null = xmlRunTimeFree && !b.wholeKit ? JSON.parse(readFileSync(join(overlayDir, OVERLAY_FILE), 'utf8')) : null;
		const closedWorld = coreClosedWorld(join(kit, 'Sources', 'NativeScriptKit'), context.adapter.kit.apple, appSwift + start, overlay ? { dir: overlayDir, ...overlay } : null);
		say(`core in this app: ${closedWorld.initializers.length} module initializers run, ${b.wholeKit ? 'every file compiled (--whole-kit)' : `${closedWorld.excluded.length} files left out`}`);
		const entryStart = start.replace('        CoreModules.initialize()\n', `        CoreModules.initializers = [\n${closedWorld.initializers.map((i) => `            ${i},\n`).join('')}        ]\n        CoreModules.initialize()\n`);
		writeFileSync(join(sourcesDir, '__Entry.swift'), `// Compiled by ns-compiled: the app's entry and its CSS.\nimport NativeScriptKit\n\n@main\nenum ${name}App {\n    static func main() {\n${dispatch ? '        __NativeDispatch.install()\n' : ''}${native.bindings.map((b) => `        ${b.installer}.install()\n`).join('')}${entryStart}    }\n}\n\nlet appCSS = """\n${css.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""')}"""\n\n// What core reads as \`~/package.json\`.\nlet appPackageJSON = """\n${appPackageJSON(app).replace(/\\/g, '\\\\').replace(/"""/g, '\\"""')}\n"""\n`);
		say(`${components.length} components and ${modules.length} modules from ${framework} compiled to Swift in ${Date.now() - started} ms → ${relative(process.cwd(), join(out, 'Sources'))}`);

		// 4. The Xcode project. The kit is a static library target rather than its
		// Swift package because package targets get none of the project's settings.
		// Virtual function and witness method elimination with internalized public
		// symbols let the link drop the kit's code and vtable entries the app never
		// reaches; every Swift module in the link must be compiled with them and with
		// full LTO. They are `-experimental-hermetic-seal-at-link` without
		// `-conditional-runtime-records`, which keeps a class in the Objective-C class
		// list only if its `CN` symbol is referenced, and code creating instances
		// references the full metadata instead: the runtime then cannot find such a
		// class from its metaclass, and `+[NSBundle bundleForClass:]`, which UIKit
		// calls on the first responder, aborts.
		const bundle = b.bundle ?? `org.nativescript.${name.toLowerCase()}.native`;
		const pluginLines = xcodegenLines(native, out);
		const kitSources = join(kit, 'Sources', 'NativeScriptKit');
		/** The adapter's Swift, compiled into the kit's module: a second source folder of its target. */
		const adapterSwift = context.adapter.kit.apple;
		/** A path of this package as the app reaches it (`node_modules/@nativescript/compiler/…`): the project names no folder of this machine outside the app. */
		const viaApp = (p: string) => {
			const linked = join(app, 'node_modules', '@nativescript', 'compiler');
			const own = resolve(PACKAGE);
			try {
				if (p.startsWith(own + '/') && realpathSync(linked) === realpathSync(own)) return join(linked, relative(own, p));
			} catch {}
			return p;
		};
		const core = installedCore(app);
		const coreModules = core ? coreNativeModules(core).map((m) => m.module) : [];
		// `--whole-kit` compiles every file of the kit, however little of it the app reaches: a check that all of it builds.
		const unreached = b.wholeKit
			? []
			: kitFilesUnreached(
					[kitSources, ...(adapterSwift ? [adapterSwift] : [])],
					readdirSync(sourcesDir)
						.sort()
						.map((f) => readFileSync(join(sourcesDir, f), 'utf8'))
						.join('\n'),
					coreModules,
					new Set(closedWorld.excluded.map((f) => join(kitSources, f))),
				);
		/** Each kit source folder's files left out of the kit's target, by their paths in it. */
		const excludedIn = (dir: string) => unreached.filter((f) => f.startsWith(dir + sep)).map((f) => relative(dir, f));
		const excluded = b.wholeKit ? [] : [...new Set([...excludedIn(kitSources), ...closedWorld.excluded, ...(overlay?.replaces ?? [])])];
		const adapterExcluded = adapterSwift ? excludedIn(adapterSwift) : [];
		if (overlay) say(`XML run time: the kit's XML-free overlay in place of ${overlay.replaces.join(', ')}`);
		mirror(sourcesDir, join(out, 'Sources'));
		// The kit's warnings are core's, checked by the kit's own build (tests/kit-build.sh, --whole-kit); in an app's build they are noise.
		const kitWarnings: Record<string, string> = b.wholeKit ? {} : { SWIFT_SUPPRESS_WARNINGS: 'YES', GCC_WARN_INHIBIT_ALL_WARNINGS: 'YES' };
		const coreNative = coreNativeProject(core ?? '', new Set([...kitImports(kitSources, excluded, coreModules), ...(adapterSwift ? kitImports(adapterSwift, adapterExcluded, coreModules) : []), ...native.appImports]), out);
		const profile = b.provision ? findProfile(b.provision) : null;
		const team = !profile && b.teamId ? { id: b.teamId, method: b.exportMethod ?? 'debugging' } : undefined;
		// Unsigned only for the simulator: a device archive made from the generated project in Xcode signs
		// with the team chosen there, and an archive built here without one passes CODE_SIGNING_ALLOWED=NO.
		const signing: Record<string, string> = profile ? signingSettings(profile) : team ? automaticSigningSettings(team.id) : { '"CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]"': 'NO' };
		const pods = podfile({ app, name, deploymentTarget, nested: native.swift.map((t) => t.name), extensions: iosExtensionNames(app), stubbed: context.stubbedPlugins });
		if (pods) writeIfChanged(join(out, 'Podfile'), pods);
		else removePods(out, name);
		const resources = iosProjectResources({ app, appDir, out, name, pods: !!pods, say, stubbed: context.stubbedPlugins });
		const extensions = iosExtensions({ app, out, bundle, packages, signing, team: resources.team, say });
		// Script is single-threaded unless the app starts workers (each in its own isolated JSRealm on a worker thread).
		// When workers are present, disable dynamic MainActor assertions in Debug too so worker threads can run realm-isolated code.
		const hasWorkers = !!(b.workers && b.workers.length);
		const swiftMode = { SWIFT_VERSION: '"6"', SWIFT_DEFAULT_ACTOR_ISOLATION: 'MainActor', SWIFT_UPCOMING_FEATURE_INFER_ISOLATED_CONFORMANCES: 'YES', ...(hasWorkers ? { OTHER_SWIFT_FLAGS: '"$(inherited) -Xfrontend -disable-dynamic-actor-isolation"' } : {}) };
		// Release only: Debug keeps Swift 6's run-time isolation checks when no workers are present.
		const swiftModeRelease = (...flags: string[]) => `      configs:\n        Release:\n          OTHER_SWIFT_FLAGS: "${['$(inherited)', ...(hasWorkers ? [] : ['-Xfrontend', '-disable-dynamic-actor-isolation']), ...flags].join(' ')}"\n`;
		// The app's own Swift (App_Resources/iOS/src), compiled in the app's target, was written for Swift 5: the target keeps that mode,
		// with the Swift 6 features the generated code relies on (a default argument evaluated in its function's isolation).
		const appMode = native.appSwift ? { ...swiftMode, SWIFT_VERSION: '"5"', SWIFT_UPCOMING_FEATURE_ISOLATED_DEFAULT_VALUES: 'YES', SWIFT_UPCOMING_FEATURE_REGION_BASED_ISOLATION: 'YES', SWIFT_UPCOMING_FEATURE_INFER_SENDABLE_FROM_CAPTURES: 'YES', SWIFT_UPCOMING_FEATURE_GLOBAL_ACTOR_ISOLATED_TYPES_USABILITY: 'YES' } : swiftMode;
		const appSettings = { PRODUCT_BUNDLE_IDENTIFIER: bundle, ...appMode, ...resources.settings, ...coreNative.settings, ...pluginLines.settings, ...signing };
		// Reflection metadata keeps every type's descriptor, and through it the type and all it calls, in the
		// binary; the kit reflects only on tuples (Mirror of a tuple needs none), so a Release build has none.
		// A framework the kit imports for code the app never reaches (WebKit for WebView, Photos for saving
		// images) is left out of the link, and so not loaded at launch, by `-dead_strip_dylibs`.
		// Exclusive access is enforced as it compiles, not again at run time: the translated code's class and
		// static accesses would each call into the runtime (about 2% of launch, and 130 KB of code).
		// Virtual function and witness elimination hold only when every Swift module in the link is compiled
		// for them: code from pods and packages, built without, would call methods they removed or thunks they need.
		const wholeProgram = !pods && !packages.length && !pluginLines.packages;
		writeIfChanged(
			join(out, 'project.yml'),
			`name: ${name}
options:
  bundleIdPrefix: org.nativescript
  deploymentTarget:
    iOS: "17.0"
settings:
  configs:
    Release:
      SWIFT_OPTIMIZATION_LEVEL: -Osize
      SWIFT_LTO: YES
${wholeProgram ? '      OTHER_SWIFT_FLAGS: -Xfrontend -enable-llvm-vfe -Xfrontend -enable-llvm-wme -Xfrontend -internalize-at-link\n' : ''}      DEAD_CODE_STRIPPING: YES
      OTHER_LDFLAGS: "$(inherited) -Wl,-dead_strip_dylibs"
      SWIFT_REFLECTION_METADATA_LEVEL: none
      SWIFT_ENFORCE_EXCLUSIVE_ACCESS: compile-time
${pluginLines.packages || packages.length ? `packages:\n${pluginLines.packages}${packageLines(packages, out)}` : ''}targets:
  NativeScriptKit:
    type: library.static
    platform: iOS
    sources:
      - path: ${relative(out, viaApp(kitSources))}
${excluded.length ? `        excludes: [${excluded.join(', ')}]\n` : ''}${overlay ? `      - path: ${relative(out, viaApp(join(overlayDir, 'Core')))}\n` : ''}${adapterSwift ? `      - path: ${relative(out, viaApp(adapterSwift))}\n${adapterExcluded.length ? `        excludes: [${adapterExcluded.join(', ')}]\n` : ''}` : ''}${coreNative.kitDependencies ? `    dependencies:\n${coreNative.kitDependencies}` : ''}    settings:
      base:
${Object.entries({ ...swiftMode, ...kitWarnings })
	.map(([k, v]) => `        ${k}: ${v}\n`)
	.join('')}${Object.entries(coreNative.settings)
				.map(([k, v]) => `        ${k}: ${v}\n`)
				.join('')}${swiftModeRelease()}${pluginLines.targets}${extensions.targets}  ${name}:
    type: application
    platform: iOS
    sources:
      - path: Sources
${coreNative.appSources}${pluginLines.sources}${resources.sources}    dependencies:
      - target: NativeScriptKit
${coreNative.appDependencies}${pluginLines.dependencies}${productLines(packages)}${extensions.dependencies}${resources.configFiles ? `    configFiles:\n      Debug: ${resources.configFiles.Debug}\n      Release: ${resources.configFiles.Release}\n` : ''}    settings:
      base:
${Object.entries(appSettings)
	.map(([k, v]) => `        ${k}: ${v}\n`)
	.join('')}${swiftModeRelease(...TRACEABLE_SWIFT_FLAGS)}`,
		);

		// The Xcode project is generated here (and integrated with CocoaPods where the app has pods), so a build of it
		// (the NativeScript CLI's) only runs xcodebuild on what the marker names.
		const project = generateProject({ out, name, pods, mergeXcconfig: () => mergePodsXcconfig(out, name), say });
		writeIfChanged(join(out, PROJECT_MARKER), JSON.stringify(pods ? { workspace: `${name}.xcworkspace` } : { project: `${name}.xcodeproj` }) + '\n');
		if (b.build) {
			const { execFileSync } = await import('node:child_process');
			if (b.device) {
				const built = archive({ out, name, project, bundle, profile, extensionProfiles: extensions.profiles, team, say });
				say(`archived ${relative(process.cwd(), built.archive)}, ${relative(process.cwd(), built.ipa)}`);
			} else {
				execFileSync('xcodebuild', [...project, '-scheme', name, '-configuration', 'Release', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', 'build', 'build', '-quiet'], { cwd: out, stdio: 'inherit' });
				say(`built ${relative(process.cwd(), out)}/build`);
			}
		}
		/** A program class's Swift name: the clash rename every generated type takes, components and registered elements included. */
		function swiftClass(name: string): string {
			return programClassName(translator, name);
		}

		/** The code making a component's root view, wrapped as the framework wraps root views. */
		function rootView(name: string, make: string): string {
			const c = adapter?.swift?.wrapsRootViews && !unwritten.has(name) ? components.find((x) => x.name === name) : undefined;
			const sf = c && program.getSourceFile(c.file);
			const cls = sf?.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name) ?? sf?.statements.find(ts.isClassDeclaration);
			return cls ? translator.rootView(cls, swiftClass(name), make) : make;
		}
	} finally {
		rmSync(sourcesDir, { recursive: true, force: true });
	}
}

/**
 * The kit files importing a framework beyond Foundation and UIKit whose types
 * the app's Swift does not name: an app links what the kit imports, and a
 * linked framework is loaded at launch with everything it links (WebKit, some
 * fifty images) whether or not the app reaches the code that uses it.
 * Core's own native modules (`linked`) are part of the kit as Foundation is. `dirs`: the kit's source folders, its own
 * first; files are absolute paths.
 */
function kitFilesUnreached(dirs: string[], appSwift: string, linked: string[], leftOut: ReadonlySet<string>): string[] {
	const names = new Set<string>();
	const read = (text: string) => {
		for (const m of text.matchAll(/\b[A-Za-z_]\w*\b/g)) names.add(m[0]);
	};
	read(appSwift);
	// A file importing only what every app links stays, and what it names is reached; the others stay when something that stays names one of their types.
	const pending: { path: string; text: string; types: string[] }[] = [];
	for (const f of dirs.flatMap((d) => (readdirSync(d, { recursive: true }).sort() as string[]).map((f) => join(d, f)))) {
		if (!f.endsWith('.swift') || leftOut.has(f)) continue;
		const text = readFileSync(f, 'utf8');
		// Core's modules are one program: each one's initializer runs at launch, as core's index imports them all.
		if (f.startsWith(join(dirs[0], 'Core') + sep) || [...text.matchAll(/^import (\w+)/gm)].every((m) => ['Foundation', 'UIKit', 'ObjectiveC', ...linked].includes(m[1]))) {
			read(text);
			continue;
		}
		pending.push({ path: f, text, types: [...text.matchAll(/^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:open|public|final)\s+)*(?:class|struct|enum|protocol)\s+(\w+)/gm)].map((m) => m[1]) });
	}
	for (let more = true; more;) {
		more = false;
		for (let k = pending.length - 1; k >= 0; k--) {
			if (!pending[k].types.some((t) => names.has(t))) continue;
			read(pending[k].text);
			pending.splice(k, 1);
			more = true;
		}
	}
	return pending.map((p) => p.path).sort();
}

/**
 * Core as an app reaches it, from the kit manifest's graph. What runs: the modules declaring
 * what the app's Swift and the kit's own name (or name through a function core's index exports
 * or an object shape), and every module those evaluate first, as importing a module runs its
 * imports' top levels; their initializers, in the order core's index evaluates them. What is
 * compiled: those files and every file declaring a name they mention, which Swift needs whether
 * or not it runs; the others are left out of the kit's target, and with them the frameworks
 * only they use (WebKit with WebView). The adapter's Swift (`adapterSwift`) names core as the kit's own does.
 */
function coreClosedWorld(kitSources: string, adapterSwift: string | undefined, appSwift: string, overlay: (KitOverlay & { dir: string }) | null): { initializers: string[]; excluded: string[] } {
	const coreDir = join(kitSources, 'Core');
	const manifest = join(coreDir, 'manifest.json');
	const graph: Record<string, { init?: string; imports: string[] }> | undefined = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).graph : undefined;
	if (!graph) throw new Error(`${manifest} has no module graph: regenerate the kit from core (tools/kit/generate.mts)`);
	const files = readdirSync(coreDir)
		.sort()
		.filter((f) => f.endsWith('.swift') && f !== '__Modules.swift');
	const replaced = new Set(overlay?.replaces.map((f) => f.replace(/^Core\//, '')) ?? []);
	const text = new Map(files.map((f) => [f, readFileSync(join(replaced.has(f) ? join(overlay!.dir, 'Core') : coreDir, f), 'utf8')]));
	Object.assign(graph, overlay?.graph);
	const words = (code: string) => new Set(code.match(/\b[A-Za-z_]\w*\b/g) ?? []);
	const declaring = new Map<string, string>();
	for (const [f, code] of text) for (const m of code.matchAll(/^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:open|public|final|indirect)\s+)*(?:class|struct|enum|protocol|func|typealias|let|var)\s+(\w+)/gm)) if (!declaring.has(m[1])) declaring.set(m[1], f);
	// What an extension declares (core's index namespaces, `extension Utils { enum layout … }`) is reached by its own names.
	const extending = new Map<string, string[]>();
	for (const [f, code] of text) {
		if (!/^extension \w+/m.test(code)) continue;
		for (const m of code.matchAll(/^ {4}(?:(?:public|static|final)\s+)*(?:class|struct|enum|func|let|var)\s+(\w+)/gm)) extending.set(m[1], [...(extending.get(m[1]) ?? []), f]);
	}
	const named = (code: string) => [...words(code)].flatMap((w) => [...(declaring.has(w) ? [declaring.get(w)!] : []), ...(extending.get(w) ?? [])]);
	let roots = named(appSwift);
	// A kit file importing another framework (SystemConfiguration for connectivity) is core's only where core's code names it (kitFilesUnreached).
	const handWritten = (readdirSync(kitSources, { recursive: true }).sort() as string[]).filter((f) => f.endsWith('.swift') && !f.startsWith('Core/')).map((f) => join(kitSources, f));
	for (const f of [...handWritten, ...adapterRuntimeFiles(adapterSwift)]) {
		const code = readFileSync(f, 'utf8');
		if ([...code.matchAll(/^import (\w+)/gm)].every((m) => ['Foundation', 'UIKit', 'ObjectiveC', 'CoreGraphics'].includes(m[1]))) roots.push(...named(code));
	}
	const running = new Set<string>();
	const seen = new Set<string>();
	const run = (f: string) => {
		if (seen.has(f)) return;
		seen.add(f);
		// A module runs, and so do its imports; an export or a shape runs nothing itself, only what it names. With the
		// overlay, a function type's cell runs nothing: the cells name the XML run time's types, whose modules nothing else runs.
		if (graph[f]) {
			running.add(f);
			graph[f].imports.forEach(run);
		} else if (!(overlay && f.startsWith('FunctionCells.'))) named(text.get(f) ?? '').forEach(run);
	};
	roots.forEach(run);
	const compiled = new Set<string>();
	const compile = (f: string) => {
		if (compiled.has(f) || !text.has(f)) return;
		compiled.add(f);
		named(text.get(f)!).forEach(compile);
		graph[f]?.imports.forEach(compile);
	};
	[...roots, ...running].forEach(compile);
	return {
		initializers: Object.keys(graph)
			.filter((f) => running.has(f) && graph[f].init)
			.map((f) => graph[f].init!),
		excluded: files.filter((f) => !compiled.has(f)).map((f) => `Core/${f}`),
	};
}

/** The app's package.json as its bundle has it, or an empty object. */
function appPackageJSON(app: string): string {
	const file = join(app, 'package.json');
	return existsSync(file) ? readFileSync(file, 'utf8').trim() : '{}';
}

/** The modules among `modules` that the kit's files the app links import (core's own native code). */
function kitImports(dir: string, excluded: string[], modules: string[]): Set<string> {
	const found = new Set<string>();
	for (const f of readdirSync(dir, { recursive: true }).sort() as string[]) {
		if (!f.endsWith('.swift') || excluded.includes(f)) continue;
		for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/^import (\w+)/gm)) if (modules.includes(m[1])) found.add(m[1]);
	}
	return found;
}

/**
 * A JavaScript object for each of the app's Swift classes that untyped code calls (`AppleWidgetUtils.getDataWithKey(key)`):
 * its static methods by NativeScript's names, arguments read as the Swift parameters take them, results boxed.
 */
function appNativeObjects(classes: NativeClass[]): string {
	const read = (type: string, code: string) => {
		const t = type.replace(/\?$/, '');
		const conv = t === 'String' ? `${RT.jsToString}(${code})` : t === 'Bool' ? `${RT.jsTruthy}(${code})` : t === 'Double' ? `${RT.jsToNumber}(${code})` : /^(Int|Int32|Int64|UInt|CGFloat|Float)$/.test(t) ? `${t}(${RT.jsToNumber}(${code}))` : t === 'NSDictionary' || t === '[AnyHashable : Any]' ? `(${RT.jsToNativeDictionary}(${code}) as NSDictionary)` : `(${RT.jsToNative}(${code}) as! ${t})`;
		return type.endsWith('?') ? `(${RT.jsIsNullish}(${code}) ? nil : ${conv})` : conv;
	};
	return classes
		.map((c) => {
			const methods = Object.entries(c.static).filter(([, m]) => m.kind === 'method') as [string, NativeMethod][];
			const cases = methods.map(([js, m]) => {
				const args = m.params.map((p, k) => `${m.labels[k] ? `${m.labels[k]}: ` : ''}${read(p, `${RT.jsArg}(__a, ${k})`)}`).join(', ');
				const call = `${c.swift}.${m.swift}(${args})`;
				return `        case ${JSON.stringify(js)}: return { (__a: [Any?]) throws -> Any? in ${m.returns === 'Void' ? `${call}; return nil` : `return ${call}`} }`;
			});
			return `final class __AppNative_${c.swift}: JSDynamic {
${NONISOLATED_DEINIT}
    static let shared = __AppNative_${c.swift}()
    var jsKeys: [String] { [] }
    var jsClassName: String? { ${JSON.stringify(c.swift)} }
    subscript(jsKey key: String) -> Any? {
        get {
            switch key {
${cases.join('\n')}
            default: return nil
            }
        }
        set {}
    }
}
`;
		})
		.join('\n');
}
