// The whole build of an app as a function: read the app, check the toolchain, the plugins and the versions, run the
// framework's front end (or plan a plain XML app), type-check the app with core and its plugins as one program, then
// translate and write the platform's project (targets/ios/build.ts, targets/android/build.ts), building it if asked.
// cli.ts is its command line; nothing here reads process.argv.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { ComponentIR } from '../api/ir.ts';
import type { FrontEndResult, TemplateBehaviour } from '../api/adapter-api.ts';
import { adapterOf, availableAdapters, loadAdapter } from '../adapters/load.ts';
import { detectFramework } from '../adapters/framework.ts';
import { BuildContext } from '../program/build-context.ts';
import { clearBuildCaches } from '../program/build-caches.ts';
import { pathAliases } from '../program/app-paths.ts';
import { appImports, reachedFrom, tsconfigIncluded } from '../program/app-modules.ts';
import { loadViteAppPlugins } from '../program/vite-plugins.ts';
import { appDeclarations, createProgram, nodeModules } from '../program/program.ts';
import { corePatchRefusal } from '../program/core-patches.ts';
import { reachability, type Reach } from '../program/reach.ts';
import { collectProperties } from '../program/properties.ts';
import { SourceLines } from '../program/source-lines.ts';
import { appBindings, pluginStubs, unboundEnginePlugins } from '../plugins/bindings.ts';
import { PluginSources, configuredOverrides, writtenStrict } from '../plugins/source.ts';
import { KIT } from '../swift/core-api.ts';
import type { ComponentInfo } from '../swift/translator.ts';
import { kitIndex } from '../kit/kit-index.ts';
import { xmlApp, type XmlApp } from '../xml/app.ts';
import { DEFAULT_BEHAVIOUR, isFragment } from '../template/model.ts';
import { COMPONENT_MEMBERS, componentMembersOf } from '../template/plan.ts';
import { appStylesheets, importedStylesheets, kitAst } from '../css/css.ts';
import { pluginReplacements, releaseOptions, stubbedPlugins } from '../targets/resources.ts';
import type { ExportMethod } from '../targets/ios/signing.ts';
import { writeIos } from '../targets/ios/build.ts';
import { KIT_ANDROID, PACKAGE } from './paths.ts';
import { checkContract } from './contract.ts';
import { checkToolchain } from './toolchain.ts';
import { formatPreflight, preflight } from './preflight.ts';
import { describe, PropertyGuard } from './unimplemented.ts';

/** What `compile` builds and how: the command line's flags (cli.ts), each named as the flag is. */
export interface CompileOptions {
	/** The app's folder: a NativeScript project (package.json, app/). */
	app: string;
	/** `--platform`: iOS unless `android`. */
	platform?: 'ios' | 'android';
	/** `--out`: the project's folder; by default the app's platforms/compiled/ios or platforms/compiled/android. */
	out?: string;
	/** `--name`: the app's name in its project; by default its folder's, in PascalCase. */
	name?: string;
	/** `--bundle`: the iOS bundle identifier or the Android application id. */
	bundle?: string;
	/** `--build`: build the project too (Xcode for the simulator, or Gradle). */
	build?: boolean;
	/** `--device`: an iOS archive and .ipa (signed per `provision`, or `teamId` with `exportMethod`); on Android, as `aab`. */
	device?: boolean;
	/** `--aab`: an Android App Bundle beside the APK. */
	aab?: boolean;
	/** `--provision`: the provisioning profile an iOS device build signs with. */
	provision?: string;
	/** `--team-id`: the team an iOS device build signs with automatically. */
	teamId?: string;
	/** `--export-method`, with `teamId` (default `debugging`). */
	exportMethod?: ExportMethod;
	/** `--key-store-path`, `--key-store-password`, `--key-store-alias`, `--key-store-alias-password`: the Android release key. */
	keyStore?: { path: string; password?: string; alias?: string; aliasPassword?: string };
	/** `--widgets`: the Android widgets .aar. */
	widgets?: string;
	/** `--all-errors`: every construct the translator cannot handle, instead of the first. */
	allErrors?: boolean;
	/** `--keep-going`: the project is written anyway, so the platform compiler's errors show what is incomplete. */
	keepGoing?: boolean;
	/** `--allow-unimplemented-properties` (or release.allowUnimplementedProperties): warn for properties the kit does not apply. */
	allowUnimplementedProperties?: boolean;
	/** `--allow-core-mismatch` (or release.allowCoreMismatch). */
	allowCoreMismatch?: boolean;
	/** `--allow-plugin-mismatch` (or release.allowPluginMismatch): warn when an installed plugin differs from its source. */
	allowPluginMismatch?: boolean;
	/** `--allow-untested-frameworks` (or release.allowUntestedFrameworks). */
	allowUntestedFrameworks?: boolean;
	/** `--skip-toolchain-check`. */
	skipToolchainCheck?: boolean;
	/** False (`--no-source-lines`): generated code names no source lines. */
	sourceLines?: boolean;
	/** `--xml-strict`: an XML app any of whose sites needs core's XML run time stops. */
	xmlStrict?: boolean;
	/** `--whole-kit`: every file of the iOS kit compiled, however little of it the app reaches. */
	wholeKit?: boolean;
	/** Where progress lines go; by default standard output, as `[ns-compiled] …`. */
	say?: (message: string) => void;
}

/**
 * The closed world of a program: what of `pluginFiles` (sources compiled from packages) the app's files reach, and of
 * those the files with code of their own to compile, in `pluginFiles`' order.
 */
export function closedWorld(program: ts.Program, resolved: (containing: string, specifier: string) => string | undefined, appFiles: readonly string[], pluginFiles: readonly string[], platform: 'ios' | 'android', build: BuildContext): { reach: Reach; compiled: string[] } {
	const reach = reachability(program, resolved, appFiles, new Set(pluginFiles), platform, build.adapter.rules);
	const compiled = pluginFiles.filter((f) => reach.modules.has(f) && program.getSourceFile(f)!.statements.some((st) => reach.keeps(st) && !ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)));
	return { reach, compiled };
}

/**
 * The app compiled to its platform's project, as `o` says. `build` is the build's context, by default a fresh one: a
 * caller passes its own to read the refusals the build reported (`build.refusals`).
 */
export async function compile(o: CompileOptions, build: BuildContext = new BuildContext()): Promise<void> {
	clearBuildCaches();
	const app = resolve(o.app);
	const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
	const appDir = join(app, dirname(pkg.main ?? 'app/app.ts'));
	const name = o.name ?? basename(app).replace(/(^|[-_])(\w)/g, (_: string, __: string, c: string) => c.toUpperCase());
	const say = o.say ?? ((m: string) => console.log(`[ns-compiled] ${m}`));
	const platform = o.platform === 'android' ? 'android' : 'ios';
	if (platform === 'android' && !existsSync(join(KIT_ANDROID, 'generated', 'manifest.json'))) throw new Error(`${join(KIT_ANDROID, 'generated')} is missing: this @nstudio/nativescript-compiler has no Android kit (nx run compiler:kit-android generates it from core)`);
	stopOn(o.skipToolchainCheck ? { errors: [], warnings: [] } : checkToolchain(platform), 'toolchain');
	const stubModules = pluginStubs(app);
	const stubs = stubbedPlugins(app, platform, stubModules);
	for (const p of stubs.stubbed) build.stubPlugin(p, stubModules.get(p)!);
	stopOn({ errors: stubs.errors, warnings: stubs.stubbed.length ? [`release.stubPlugins: ${stubs.stubbed.join(', ')} build as no-op stand-ins: their views render empty and their methods do nothing`] : [] }, 'binary-only plugins');
	const pluginBindings = appBindings(app, platform, build.stubbedPlugins);
	build.useBindingRoots(pluginBindings.map((b) => b.root));
	stopOn({ errors: unboundEnginePlugins(app, platform, pluginBindings, build.stubbedPlugins), warnings: [] }, 'engine-bound plugin');
	/** Prints the warnings, then the errors, and stops on any error. */
	function stopOn(r: { errors: string[]; warnings: string[] }, what: string) {
		for (const w of r.warnings) console.warn(`warning: ${w}`);
		if (!r.errors.length) return;
		console.error(r.errors.map((e) => `error: ${e}`).join('\n'));
		throw new Error(`${r.errors.length} ${what} problem${r.errors.length > 1 ? 's' : ''}`);
	}

	const files: string[] = [];
	const walk = (d: string) => {
		for (const f of readdirSync(d).sort()) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) walk(p);
			else files.push(p);
		}
	};
	walk(appDir);
	const entry = join(app, pkg.main ?? 'app/app.ts');
	const adapters = availableAdapters(app);
	const framework = detectFramework(app, adapters, entry, files, appDir);
	if (!framework) throw new Error('no supported framework in package.json');
	const adapterPackage = framework === 'core' ? null : adapterOf(framework, adapters);
	/** The framework's adapter; none for a plain XML app. */
	const adapter = adapterPackage && (await loadAdapter(adapterPackage, build));
	build.useAdapter(adapter);
	stopOn(checkContract({ app, platform, adapter: adapterPackage, adapterApple: build.adapter.kit.apple, allowCoreMismatch: !!o.allowCoreMismatch || releaseOptions(app, platform).allowCoreMismatch === true, allowUntestedFrameworks: !!o.allowUntestedFrameworks || releaseOptions(app, platform).allowUntestedFrameworks === true }), 'version');
	const entryText = readFileSync(entry, 'utf8');
	// `x.ios.ts` and `x.android.ts` are one module, `./x`, for their platform.
	const otherPlatform = platform === 'android' ? /\.ios\.tsx?$/ : /\.android\.tsx?$/;
	// `x.ts` beside `x.ios.ts` is the other platforms' module: the platform's own file is the one `./x` resolves to.
	const thisPlatform = platform === 'android' ? '.android.ts' : '.ios.ts';
	const platformSources = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && f !== entry && !/polyfills\.ts$/.test(f) && !otherPlatform.test(f) && !(!/\.(ios|android)\.ts$/.test(f) && files.includes(f.replace(/\.ts$/, thisPlatform))));
	// The app's own specifiers: relative ones, Vite app-plugin `resolveId` hooks, and its tsconfig's path aliases (`~/app/x`).
	const vitePlugins = await loadViteAppPlugins(app);
	const baseAliased = pathAliases(app);
	const aliased = (spec: string, importer?: string) => vitePlugins.resolveId(spec, importer) ?? baseAliased(spec);
	const appSpecifier = (spec: string) => spec.startsWith('.') || aliased(spec) !== undefined;
	const readTransformed = (f: string) => vitePlugins.transform(readFileSync(f, 'utf8'), f);
	const { importsOf, usedBy, workerScripts, discovered } = appImports(files, aliased, thisPlatform, app, readTransformed);
	if (discovered.length) {
		files.push(...discovered);
		platformSources.push(...discovered.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && f !== entry && !/polyfills\.ts$/.test(f) && !otherPlatform.test(f)));
	}
	// The modules of the build: what the bundler reaches. Some frameworks' bundle is what the entry imports, lazy routes
	// included; another's, every file its tsconfig.json does not exclude (specs, mocks), and what those import.
	const included = adapter?.reach === 'entry' ? null : tsconfigIncluded(app, appDir);
	const reached = reachedFrom(adapter?.reach === 'entry' ? [entry] : files.filter((f) => !included || !/\.tsx?$/.test(f) || included.has(f)), importsOf);
	// A file only the other platform's files use (an Android audio worker) is no module of this build.
	// A worker's script runs in a worker, not as a module of the app; an iOS build refuses `new Worker`, so it starts none.
	// Transitively: a file only such files use is out too (an Android track engine its worker imports).
	// Android compiles worker scripts: the kit runs each on a worker thread.
	const leftOut = new Set<string>([...(platform === 'android' ? [] : [...workerScripts].filter((w) => !usedBy.has(w))), ...platformSources.filter((f) => !reached.has(f))]);
	for (let changed = true; changed;) {
		changed = false;
		for (const f of platformSources) {
			const users = usedBy.get(f);
			if (leftOut.has(f) || !users || ![...users].every((u) => otherPlatform.test(u) || leftOut.has(u))) continue;
			leftOut.add(f);
			changed = true;
		}
	}
	const sources = platformSources.filter((f) => !leftOut.has(f));
	// Virtual replacements for app modules the release build reads differently (a zustand store).
	const overrides = new Map<string, string>();

	// Plugins: compiled from their TypeScript source; on iOS their native code is linked as a local Swift package.
	const plugins = new PluginSources({ app, platform, overrides: configuredOverrides(app, platform), say });

	// 1. Each component through its framework's front end; 2. the component the app starts with.
	const started = Date.now();
	let components: ComponentIR[];
	let modules: string[];
	let root: string;
	/** The app mounts its own roots (its entry renders them): the entry is a module that runs the app. */
	let mounted = false;
	/** A plain XML app: its pages, page stylesheets and the elements its XML names. */
	let xml: XmlApp | null = null;
	// Every XML site of the app built at build time: the app compiles the kit's XML-free overlay (kit/overlay.ts).
	let xmlRunTimeFree = false;
	let xmlMemberKeys: import('../semantics/states/value-states.ts').XmlMemberKeys | null = null;
	let xmlBindings: { core: import('../xml/plan.ts').CoreXml; sites: { key: string; binding: import('../xml/plan.ts').BindingPlan }[]; file: string | null; pages: string; dump: string | null } | null = null;
	/** How the app's templates render and update. An XML app's updates apply at once, as core's own bindings do. */
	let behaviour: TemplateBehaviour = { ...DEFAULT_BEHAVIOUR, schedule: 'now' };
	/** The classes of the tags the app registers (`registerElement`): a component's template names each by its class. */
	let elementClasses: ReadonlySet<string> = new Set<string>();
	/** The framework's code in the generated entry. */
	let entryCode: FrontEndResult['entry'];
	if (adapter) {
		const result = await adapter.frontEnd({
			root: app,
			appDir,
			entry,
			files,
			platform,
			entryText,
			sources,
			aliased,
			plugins,
			get nodeModules() {
				return nodeModules(app);
			},
			get replacedPackages() {
				return new Set(Object.keys(pluginReplacements(app, platform)));
			},
		});
		components = result.components;
		modules = result.modules;
		root = result.root;
		for (const [f, text] of result.overrides ?? []) overrides.set(f, text);
		mounted = !!result.mounted;
		behaviour = result.behaviour ?? adapter.behaviour;
		elementClasses = result.elementClasses ?? elementClasses;
		entryCode = result.entry;
	} else {
		xml = xmlApp(appDir, files, sources, entry);
		components = [];
		overrides.set(xml.registry.file, xml.registry.source);
		// `{{ }}` expressions compiled to closures that core's Builder takes in place of its expression evaluator.
		const { loadCoreXml, xmlBindingSites } = await import('../xml/plan.ts');
		const { expressionParser, compileBindings, bindingsModule } = await import('../xml/bindings.ts');
		const core = await loadCoreXml();
		const sites = xmlBindingSites(core, appDir, xml.xml, platform);
		const bindings = bindingsModule(compileBindings(expressionParser(), sites));
		const bindingsFile = join(appDir, '__xml_bindings.ts');
		if (bindings) overrides.set(bindingsFile, bindings);
		// The page factories need the program's classes and exports; written once the program is made.
		const pagesFile = join(appDir, '__xml_pages.ts');
		overrides.set(pagesFile, 'export {};\n');
		// A check that builds every file both ways once the app runs, printing the two trees (`NS_XML_TREE_DUMP=1`).
		const dumpFile = process.env.NS_XML_TREE_DUMP ? join(appDir, '__xml_dump.ts') : null;
		if (dumpFile) overrides.set(dumpFile, 'export {};\n');
		xmlBindings = { core, sites, file: bindings ? bindingsFile : null, pages: pagesFile, dump: dumpFile };
		// The entry's own `Application.run` starts the app, after the registry and every module it imports. The factories
		// take their code-behinds' objects from the registry when they register.
		mounted = true;
		modules = [...sources, ...(bindings ? [bindingsFile] : []), xml.registry.file, pagesFile, ...(dumpFile ? [dumpFile] : []), entry];
		root = '';
	}

	// The app's CSS through its own build's pipeline, which also gives the bundler's defines the sources are read with.
	const componentStyles = components.flatMap((c) => c.styles ?? []);
	const styled = appStylesheets(app, platform, [...importedStylesheets(entry, appDir, componentStyles, build.adapter.rules.componentExtensions), ...(xml?.pageStyles ?? [])], componentStyles);
	build.useDefines(styled.defines);
	const allSheets = styled.sheets;
	// A page's own stylesheet applies to its page, which core's Builder loads it for: not the app's CSS.
	const pageSheets = allSheets.filter((sh) => xml?.pageStyles.includes(sh.file));
	const sheets = allSheets.filter((sh) => !pageSheets.includes(sh));

	// 3. Type-check everything as one program, then translate.
	// `const { X } = await import('./x')` reads an app module the build links statically: the module evaluates at startup.
	for (const c of components) c.source = staticImports(c.source, appSpecifier);
	for (const f of modules) {
		const text = overrides.get(f) ?? (existsSync(f) ? readFileSync(f, 'utf8') : undefined);
		const rewritten = text === undefined ? undefined : staticImports(text, appSpecifier);
		if (rewritten !== undefined && rewritten !== text) overrides.set(f, rewritten);
	}
	const virtual = new Map([...components.map((c) => [c.file, c.source] as [string, string]), ...overrides]);
	// A plugin binding the engine is its binding's on Android: its script replaced, its native code linked, its typings read.
	const bindings = platform === 'android' ? pluginBindings.flatMap((b) => (b.android ? [b.android] : [])) : [];
	const bindingReplacements: Record<string, string> = {};
	for (const b of bindings) {
		bindingReplacements[b.package] = b.script;
		plugins.get(join(nodeModules(app), b.package));
	}
	const declarations = [
		...appDeclarations(app),
		// The native typings of plugins whose components compile with the app's.
		...plugins.all().flatMap((p) => p.typings),
	];
	const replacements = { ...bindingReplacements, ...pluginReplacements(app, platform) };
	modules.push(...Object.values(replacements).filter((f) => !modules.includes(f)));
	let { checker, program, files: sourceFiles, pluginFiles, resolved, lenient: lenientApp, assignsFields } = createProgram(modules, virtual, platform, undefined, plugins, declarations, replacements, {}, aliased, undefined, build, vitePlugins);
	// The binding contexts the program proves: closures read a proved class's members directly. The page factories build
	// each XML file's tree. The program is made again to type both.
	if (xml && xmlBindings) {
		const { xmlPlan } = await import('../xml/plan.ts');
		const { xmlBindingContexts } = await import('../xml/contexts.ts');
		const { expressionParser, compileBindings, bindingsModule, closureNames } = await import('../xml/bindings.ts');
		const { pagesModule, textsModule, treeDumpModule } = await import('../xml/pages.ts');
		const { bindSites, foldSites, textBindingSites } = await import('../xml/fold.ts');
		const plan = xmlPlan(xmlBindings.core, appDir, xml.xml, program, platform);
		const contexts = xmlBindingContexts(plan.pages, program, appDir);
		const byKey = new Map(contexts.sites.map((s) => [s.key, s]));
		// Constant text in app code: its XML built by factories, its expressions compiled; their closures are not registered by key.
		const binds = bindSites(plan, program, appDir);
		const folds = [...textBindingSites(plan), ...binds];
		const compiled = compileBindings(expressionParser(), [...xmlBindings.sites.map((s) => ({ ...s, typed: byKey.get(s.key)?.typed })), ...folds]);
		say(
			`XML bindings: ${contexts.sites.length} (${Object.entries(contexts.counts)
				.map(([k, n]) => `${n} ${k}`)
				.join(', ')}); ${compiled.sites.length} closures, ${compiled.sites.filter((c) => c.typed).length} with typed reads`,
		);
		const names = closureNames(compiled).names;
		const bindingsFile = join(appDir, '__xml_bindings.ts');
		const hasBindings = compiled.sites.length > 0;
		const pages = pagesModule(plan, names, hasBindings ? './__xml_bindings' : null);
		say(`XML pages: ${pages.pages.length} built by factory, ${pages.runtime.length} by the Builder${pages.runtime.map((r) => `\n  ${r.file}: ${r.reason}`).join('')}`);
		const texts = textsModule(plan, names, hasBindings ? './__xml_bindings' : null);
		const textsFile = join(appDir, '__xml_texts.ts');
		const folded = foldSites(plan, program, appDir, texts, binds, names, textsFile, hasBindings ? bindingsFile : null);
		const at = (site: number) => `${plan.dynamic[site].file}:${plan.dynamic[site].line}`;
		if (plan.dynamic.length) say(`XML text in app code: ${folded.folded.length} constant sites built at build time, ${folded.kept.length} kept for the XML run time${folded.kept.map((k) => `\n  ${at(k.site)}: ${plan.dynamic[k.site].kind}: ${k.reason}`).join('')}`);
		// Core parses XML and evaluates expressions only for what the build left to it: those sites keep the run time linked.
		const closed = new Set(compiled.sites.map((s) => s.key));
		const needs = [...pages.runtime.map((r) => `${r.file}: built by the Builder: ${r.reason}`), ...folded.kept.map((k) => `${at(k.site)}: ${plan.dynamic[k.site].kind}: ${k.reason}`), ...xmlBindings.sites.filter((s) => s.binding.expression !== undefined && !closed.has(s.key)).map((s) => `${s.key}: an expression not compiled`), ...(xmlBindings.dump ? ['NS_XML_TREE_DUMP: the tree dump builds every page with the Builder too'] : [])];
		xmlRunTimeFree = !needs.length;
		say(needs.length ? `XML run time linked: ${needs.length} site${needs.length > 1 ? 's' : ''} need${needs.length > 1 ? '' : 's'} it${needs.map((n) => `\n  ${n}`).join('')}` : 'XML run time left out: no site needs it');
		if (needs.length && o.xmlStrict) throw new Error(`--xml-strict: ${needs.length} XML site${needs.length > 1 ? 's' : ''} need${needs.length > 1 ? '' : 's'} the run time (the Builder or the expression evaluator):${needs.map((n) => `\n  ${n}`).join('')}`);
		if (hasBindings && !xmlBindings.file) {
			xmlBindings.file = bindingsFile;
			modules.splice(modules.indexOf(xmlBindings.pages), 0, bindingsFile);
		}
		if (texts.source) modules.splice(modules.indexOf(xmlBindings.pages), 0, textsFile);
		let changed = false;
		for (const [file, text] of folded.files) {
			overrides.set(file, text);
			virtual.set(file, text);
			changed = true;
		}
		for (const [file, text] of [
			[xmlBindings.file, bindingsModule(compiled, new Set(folds.map((f) => f.key)))],
			[xmlBindings.pages, pages.source || 'export {};\n'],
			[texts.source ? textsFile : null, texts.source],
			[xmlBindings.dump, treeDumpModule(plan, pages)],
		] as const) {
			if (file && text && text !== virtual.get(file)) {
				overrides.set(file, text);
				virtual.set(file, text);
				changed = true;
			}
		}
		if (changed) ({ checker, program, files: sourceFiles, pluginFiles, resolved, lenient: lenientApp, assignsFields } = createProgram(modules, virtual, platform, undefined, plugins, declarations, replacements, {}, aliased, undefined, build, vitePlugins));
		// Nothing parses XML or evaluates an expression at run time: core reads app objects by the keys the XML and app code name.
		if (xmlRunTimeFree) {
			const { planKeys, scriptKeys } = await import('../xml/keys.ts');
			const generated = new Set([xmlBindings.file, xmlBindings.pages, texts.source ? textsFile : null].filter((f): f is string => !!f));
			const fromXml = planKeys(
				plan,
				expressionParser(),
				binds.map((b) => b.binding),
			);
			const fromCode = fromXml && scriptKeys(sourceFiles, checker, generated);
			xmlMemberKeys = fromXml && fromCode ? { keys: new Set([...fromXml, ...fromCode]), generated } : null;
			say(xmlMemberKeys ? `XML keys: app objects read by name only by ${xmlMemberKeys.keys.size} keys: ${[...xmlMemberKeys.keys].sort().join(', ')}` : 'XML keys: app code reads objects by keys it does not spell; every member stays readable by name');
		}
	}
	// The XML page plan, a debug artifact written outside the app's output.
	if (xml && process.env.NS_XML_PLAN) {
		const { loadCoreXml, xmlPlan } = await import('../xml/plan.ts');
		writeFileSync(
			process.env.NS_XML_PLAN,
			JSON.stringify(
				xmlPlan(
					await loadCoreXml(),
					appDir,
					xml.xml,
					program,
					platform,
					xml.pageStyles.map((f) => relative(appDir, f).split('\\').join('/')),
				),
				null,
				1,
			) + '\n',
		);
	}
	const infos = new Map<string, ComponentInfo & { outputs?: string[]; outputFields?: Record<string, string>; optional?: string[]; passed?: boolean; fragment?: boolean; initThrows?: boolean; setters?: string[]; throwingSetters?: string[]; propAliases?: Record<string, string>; changes?: boolean; slots?: string[] }>(
		components.map((c) => {
			const sf = program.getSourceFile(c.file);
			const cls = sf?.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === c.name) ?? sf?.statements.find(ts.isClassDeclaration);
			return [c.name, { name: c.name, props: c.props, members: cls ? componentMembersOf(cls, checker) : COMPONENT_MEMBERS, outputs: c.outputs, outputFields: c.outputFields, optional: c.optional, passed: c.passed, fragment: behaviour.fragments && !c.page && isFragment(c.template), setters: c.setters, propAliases: c.propAliases, changes: c.changes, ...(c.doCheck ? { doCheck: true } : {}), ...(c.afterContentInit ? { afterContentInit: true } : {}), ...(c.afterContentChecked ? { afterContentChecked: true } : {}), ...(c.afterViewChecked ? { afterViewChecked: true } : {}), ...(c.slots?.length ? { slots: c.slots } : {}), onPush: c.onPush }];
		}),
	);
	// A component whose template is one fragment component is a fragment too, however deep the chain.
	if (behaviour.fragments) {
		for (let changed = true; changed;) {
			changed = false;
			for (const c of components) {
				const info = infos.get(c.name)!;
				if (!info.fragment && !c.page && isFragment(c.template, infos)) {
					info.fragment = true;
					changed = true;
				}
			}
		}
	}
	// A closed world: the plugin code the app reaches, checked against what npm installed before it is compiled.
	const appFiles = [...new Set([...modules, ...components.map((c) => c.file)])];
	const { reach, compiled: compiledPlugins } = closedWorld(program, resolved, appFiles, pluginFiles, platform, build);
	const allowPluginMismatch = !!o.allowPluginMismatch || releaseOptions(app, platform).allowPluginMismatch === true;
	plugins.verify(compiledPlugins, allowPluginMismatch ? (msg) => console.warn(`warning: ${msg} (building anyway: release.allowPluginMismatch)`) : undefined);
	const properties = collectProperties(checker, sourceFiles);
	// The files the translated code says it came from: a component's source for its virtual class, a module's own file for a replacement of it.
	const sourceLines = o.sourceLines === false ? null : new SourceLines(new Map([...components.map((c) => [c.file, componentSource(c)] as const), ...[...overrides.keys()].map((f) => [f, f] as const)]));
	for (const c of components) if (c.templateLines) sourceLines?.pin(c.file, c.templateLines.file, c.templateLines.lines);
	if (sourceLines) sourceLines.name = (file) => sourceName(file);
	// Constructs no compiled release runs, all of them with their TypeScript lines, before anything is translated.
	const pluginSet = new Set(pluginFiles);
	const appSourceFiles = sourceFiles.filter((f) => !pluginSet.has(f.fileName));
	const unsupported = preflight(
		checker,
		[...appSourceFiles, ...compiledPlugins.map((f) => program.getSourceFile(f)!)],
		sourceLines ? (n) => sourceLines.locate(n) : undefined,
		(st) => !pluginSet.has(st.getSourceFile().fileName) || reach.keeps(st),
		(f) => pluginSet.has(f) && !writtenStrict(f, build.adapter),
	);
	if (unsupported.length) {
		console.error(formatPreflight(unsupported));
		for (const f of unsupported) build.refusals.noteFinding(f.id, `${f.file}:${f.line}:${f.column}`, f.code);
		if (!o.keepGoing) throw new Error(`${unsupported.length} construct${unsupported.length > 1 ? 's' : ''} a compiled release does not support (docs: Supported subset and known differences)`);
	}
	/**
	 * A source file as generated code names it, never by a path of this machine: the app's by its path in the app, a package's
	 * as `<package>/<path>`, or with `version`, `<package>@<version> <path>`.
	 */
	function sourceName(file: string, version = false): string {
		const own = { name: '@nativescript/compiler', version: JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')).version, root: resolve(PACKAGE) };
		const runtime = build.adapter.runtimePackageOf(file);
		const pkg = [...plugins.all(), own, ...(runtime ? [runtime] : [])].filter((p) => file.startsWith(p.root + '/')).sort((a, b) => b.root.length - a.root.length)[0];
		const [name, path] = pkg ? [version ? `${pkg.name}@${pkg.version}` : pkg.name, relative(packageDir(pkg.root, pkg.name, file), file)] : (/\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/.exec(file)?.slice(1) ?? [null, file]);
		if (name) return version ? `${name} ${path}` : `${name}/${path}`;
		return file.startsWith(app + '/') ? relative(app, file) : basename(file);
	}
	const packageNames = new Map<string, string | null>();
	/** The folder of `root` (a package, or a repository checkout holding it) whose package.json names `name` and holds `file`. */
	function packageDir(root: string, name: string, file: string): string {
		for (let d = dirname(file); d.startsWith(root + '/'); d = dirname(d)) {
			if (!packageNames.has(d)) {
				try {
					packageNames.set(d, JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name ?? null);
				} catch {
					packageNames.set(d, null);
				}
			}
			if (packageNames.get(d) === name) return d;
		}
		return root;
	}
	/** The file a translated file names in its header: a component's source file and its template, not its virtual file. */
	function shownSource(file: string): string {
		const c = components.find((x) => x.file === file);
		const source = (c && componentSource(c)) ?? file;
		const template = c?.templateLines?.file;
		if (!template || template === source) return sourceName(source, true);
		return `${sourceName(source, true)} (+ ${dirname(template) === dirname(source) ? basename(template) : sourceName(template, true)})`;
	}
	/** The file a component was written in: beside its virtual file, or the .tsx declaring its function. */
	function componentSource(c: ComponentIR): string | null {
		for (const candidate of [c.file.replace(/\.release\.ts$/, '.ts'), c.file.replace(/\.ts$/, '')]) if (candidate !== c.file && existsSync(candidate)) return candidate;
		return files.find((f) => /\.[jt]sx$/.test(f) && new RegExp(`function\\s+${c.name}\\b`).test(readFileSync(f, 'utf8'))) ?? null;
	}
	/** `--key-store-path` with its password, alias and alias password, as the NativeScript CLI takes them. */
	function keyStore() {
		const path = o.keyStore?.path;
		if (!path) return undefined;
		const { password, alias, aliasPassword } = o.keyStore!;
		if (password === undefined || alias === undefined || aliasPassword === undefined) throw new Error('--key-store-path needs --key-store-password, --key-store-alias and --key-store-alias-password');
		return { path, password, alias, aliasPassword };
	}
	// Properties the app sets that core declares and the kit does not apply: an error unless the app opts out.
	const allowUnapplied = !!o.allowUnimplementedProperties || releaseOptions(app, platform).allowUnimplementedProperties === true;
	const kitName = platform === 'android' ? 'kit-android' : 'NativeScriptKit';
	const unapplied = await (async () => {
		// A kit generated from core (its Core/ manifest) applies every property core declares, as core is its source.
		if (platform === 'android' || existsSync(join(KIT, 'Core', 'manifest.json'))) return [];
		const kit = { index: kitIndex(KIT, build.adapter.kit.apple), sources: KIT };
		const guard = new PropertyGuard(checker, program, { ...kit, name: kitName, platform });
		const found = [...guard.templates(components, new Map(components.map((c) => [c.name, c.props])), componentSource), ...guard.stylesheets(sheets)];
		return found.map((u) => describe(u, kitName));
	})();
	if (unapplied.length && allowUnapplied) for (const u of unapplied) console.warn(`warning: ${u}`);
	// iOS with --all-errors reports them with the translator's.
	else if (unapplied.length && !(platform === 'ios' && o.allErrors)) {
		console.error(unapplied.join('\n'));
		if (!o.keepGoing) throw new Error(`${unapplied.length} properties core declares that ${kitName} does not apply (--allow-unimplemented-properties or release.allowUnimplementedProperties builds anyway)`);
	}
	if (platform === 'android') {
		const patched = corePatchRefusal(app, nodeModules(app), 'android');
		if (patched) {
			console.error(patched);
			if (!o.keepGoing) throw new Error(patched);
		}
		const { writeAndroid } = await import('../targets/android/build.ts');
		await writeAndroid({
			context: build,
			app,
			out: resolve(o.out ?? join(app, 'platforms', 'compiled', 'android')),
			name,
			framework,
			behaviour,
			translatorHooks: adapter?.kotlin,
			entry: entryCode?.kotlin,
			components,
			modules,
			program,
			checker,
			files: sourceFiles,
			infos,
			elementClasses,
			root,
			lines: sourceLines,
			componentSource,
			applicationId: o.bundle,
			widgetsAar: o.widgets,
			appDir,
			build: !!o.build,
			bundle: !!(o.aab || o.device),
			keyStore: keyStore(),
			plugins: plugins.all(),
			pluginFiles,
			reach,
			properties,
			compiledPlugins,
			resolved,
			mounted,
			workers: [...workerScripts],
			aliased,
			allowUnapplied,
			allErrors: !!o.allErrors,
			lenient: lenientApp,
			assignFields: assignsFields,
			bindings: bindings.filter((b) => replacements[b.package] === b.script),
			narrowKitKeeps: releaseOptions(app, platform).narrowKitKeeps === true,
			xmlRunTimeFree,
			xmlMemberKeys,
			cssAST: kitAst(sheets),
			xml: xml
				? {
						pages: xml.xml,
						styles: pageSheets.map((sh) => ({
							name: relative(appDir, sh.file)
								.split('\\')
								.join('/')
								.replace(/\.scss$/, '.css'),
							ast: JSON.stringify(sh.ast),
						})),
						elements: xml.elements,
					}
				: undefined,
		});
		return;
	}

	await writeIos({
		context: build,
		app,
		appDir,
		out: resolve(o.out ?? join(app, 'platforms', 'compiled', 'ios')),
		name,
		framework,
		adapter,
		behaviour,
		entry: entryCode,
		components,
		modules,
		program,
		checker,
		files: sourceFiles,
		infos,
		elementClasses,
		root,
		mounted,
		xml,
		pageSheets,
		sheets,
		xmlRunTimeFree,
		xmlMemberKeys,
		lines: sourceLines,
		shownSource,
		plugins,
		bindings: pluginBindings,
		pluginFiles,
		compiledPlugins,
		reach,
		properties,
		resolved,
		lenient: lenientApp,
		assignFields: assignsFields,
		allowUnapplied,
		unapplied,
		allErrors: !!o.allErrors,
		keepGoing: !!o.keepGoing,
		wholeKit: !!o.wholeKit,
		bundle: o.bundle,
		build: !!o.build,
		device: !!o.device,
		provision: o.provision,
		teamId: o.teamId,
		exportMethod: o.exportMethod,
		say,
		started,
	});
}

/** `const { A, B } = await import('./x')` or `await import('pkg/sub')` as a destructuring of names imported statically (appended: imports hoist), positions kept where the text fits. */
function staticImports(text: string, _appSpecifier: (spec: string) => boolean): string {
	let n = 0;
	const added: string[] = [];
	const out = text.replace(/\{([\w\s,]+)\}(\s*=\s*)await\s+import\((\s*['"]([^'"]+)['"]\s*)\)/g, (whole, names: string, eq: string, _arg: string, spec: string) => {
		const list = names
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean);
		const prefix = `__import${n++}_`;
		added.push(`import { ${list.map((x) => `${x} as ${prefix}${x}`).join(', ')} } from '${spec}';`);
		const value = `await Promise.resolve({ ${list.map((x) => `${x}: ${prefix}${x}`).join(', ')} })`;
		return `{${names}}${eq}${value}`.padEnd(whole.length, ' ');
	});
	// `const tests = await import('./x')`, read only as `tests.member`: an object of the members read, each imported by name.
	const whole = out.replace(/\b(const|let|var)(\s+)(\w+)(\s*=\s*)await\s+import\((\s*['"]([^'"]+)['"]\s*)\)/g, (match, kw: string, sp: string, name: string, eq: string, _arg: string, spec: string) => {
		const reads = [...out.matchAll(new RegExp(`\\b${name}\\.(\\w+)`, 'g'))].map((m) => m[1]);
		if (!reads.length || new RegExp(`\\b${name}\\b(?!\\s*[.=])`, 'g').exec(out.replace(match, ''))) return match;
		const list = [...new Set(reads)];
		const prefix = `__import${n++}_`;
		added.push(`import { ${list.map((x) => `${x} as ${prefix}${x}`).join(', ')} } from '${spec}';`);
		return `${kw}${sp}${name}${eq}await Promise.resolve({ ${list.map((x) => `${x}: ${prefix}${x}`).join(', ')} })`.padEnd(match.length, ' ');
	});
	return added.length ? whole + '\n' + added.join('\n') + '\n' : text;
}
