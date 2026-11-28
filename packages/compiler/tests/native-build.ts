// What the host-run tests share: TypeScript translated to Swift or Kotlin as an app's
// modules are, the kit's JavaScript runtimes built for the host (Swift as a static
// library linking Foundation only, Kotlin as classes on the plain JVM), and the compilers.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PluginSources, writtenStrict } from '../src/plugins/source.ts';
import { closedWorld } from '../src/driver/compile.ts';
import { createProgram } from '../src/program/program.ts';
import { checkSharing } from '../src/semantics/sharing.ts';
import { Translator } from '../src/swift/translator.ts';
import { Translator as KotlinTranslator } from '../src/kotlin/translator.ts';
import { SourceLines } from '../src/program/source-lines.ts';
import { collectProperties } from '../src/program/properties.ts';
import { addInterfaces, translateModules, type TranslatedModule } from '../src/swift/app-modules.ts';
import { evaluationOrder } from '../src/program/module-order.ts';
import { addKotlinInterfaces, translateKotlinModules, type KotlinModule } from '../src/kotlin/app-modules.ts';
import { kotlinToolchain } from './kotlin-toolchain.ts';
import { CoreKotlin } from '../src/kotlin/core-api.ts';
import { scriptKeys } from '../src/xml/keys.ts';
import type { XmlMemberKeys } from '../src/semantics/states/value-states.ts';
import { hostRuntimeSources, nodePortFile, suiteAdapter, suiteBuild, suiteConfig, suiteDir, suiteModules } from './suite.ts';
import type { Ledger } from '../src/semantics/ledger.ts';

/** The TypeScript the compiler runs: a check reading the syntax trees it makes uses it rather than one of its own. */
export { ts };

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const kit = join(root, 'kit-apple/Sources/NativeScriptKit');
export const kitAndroid = join(root, 'kit-android/src/main/kotlin/org/nativescript/kit');
/** What test programs are typed against: core and the ES library, as an app's node_modules hold them (the suite's package.json). */
export const modulesDir = suiteModules;

/**
 * A node_modules at `dir` holding modulesDir's packages (linked) and copies of the packages in `fixtures`. Copied, not
 * linked: a package's files must sit under a node_modules path, as an app's installed plugins do.
 */
export function mergedModules(dir: string, fixtures: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(modulesDir)) symlinkSync(join(modulesDir, name), join(dir, name));
  if (existsSync(fixtures)) for (const name of readdirSync(fixtures)) cpSync(join(fixtures, name), join(dir, name), { recursive: true });
  return dir;
}

/** The node_modules a harness's runs of the diff cases import from, made under `build`: modulesDir's and the fixture packages. */
export const caseModules = (build: string) => mergedModules(join(build, 'modules', 'node_modules'), join(suiteDir, 'diff/cases/helpers/plugin/packages'));

/**
 * `dir` set up for Node to run cases' JavaScript below it (case-options.ts nodeImports) importing what the translator
 * compiles them against: `modules` (caseModules) and the suite's ports (`nodePorts`), each as `__<tag>.js`.
 */
export function nodeImportRoot(dir: string, modules: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  rmSync(join(dir, 'node_modules'), { force: true });
  symlinkSync(modules, join(dir, 'node_modules'), 'dir');
  for (const [tag, { file }] of Object.entries(suiteConfig.nodePorts ?? {})) {
    const port = ts.transpileModule(readFileSync(nodePortFile(file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    writeFileSync(join(dir, `__${tag}.js`), port);
  }
}

const hostRuntime = hostRuntimeSources();
export const runtimeSources = [...readdirSync(join(kit, 'Runtime')).filter((f) => f.endsWith('.swift')).map((f) => join(kit, 'Runtime', f)), join(kit, 'JS.swift'), join(kit, 'Signals.swift'), join(kit, 'ChangeDetection.swift'), ...hostRuntime.swift];
export const kotlinRuntimeSources = [...readdirSync(join(kitAndroid, 'runtime')).filter((f) => f.endsWith('.kt')).map((f) => join(kitAndroid, 'runtime', f)), join(kitAndroid, 'Signals.kt'), join(kitAndroid, 'ChangeDetection.kt'), ...hostRuntime.kotlin];

export type Optimize = '-Onone' | '-O' | '-Osize';

/** The language mode and isolation the kit and an app's code compile with (the CLI's project settings). */
export const SWIFT_MODE = ['-swift-version', '6', '-default-isolation', 'MainActor', '-enable-upcoming-feature', 'InferIsolatedConformances'];

/**
 * The Swift runtime as a static library and module in `build`, rebuilt when a source is newer or it was built with
 * other flags. `extraFlags` go to swiftc as given (`-wmo`, as release builds compile the kit whole-module).
 */
export function buildSwiftRuntime(build: string, optimize: Optimize, extraFlags: string[] = []) {
  mkdirSync(build, { recursive: true });
  const lib = join(build, 'libNativeScriptKit.a');
  // The sources' paths too: two checkouts' runs may share a build folder, and each must link its own runtime.
  const flags = [optimize, ...SWIFT_MODE, ...extraFlags, ...runtimeSources].join(' ');
  const stamp = join(build, 'libNativeScriptKit.flags');
  const newest = Math.max(...runtimeSources.map((f) => statSync(f).mtimeMs));
  if (existsSync(lib) && statSync(lib).mtimeMs > newest && existsSync(stamp) && readFileSync(stamp, 'utf8') === runtimeStamp(flags, runtimeSources)) return;
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-emit-library', '-static', '-module-name', 'NativeScriptKit', '-emit-module', '-emit-module-path', join(build, 'NativeScriptKit.swiftmodule'),
    optimize, ...SWIFT_MODE, ...extraFlags, '-o', lib, ...runtimeSources], { stdio: 'inherit', cwd: build });
  writeFileSync(stamp, runtimeStamp(flags, runtimeSources));
}

/**
 * What a built runtime was built from: its flags and its source files. The build folder is shared by every suite (a
 * framework suite adds its adapter's host runtime files), so a runtime built for another suite is not reused.
 */
function runtimeStamp(flags: string, sources: readonly string[]): string {
  return [flags, ...sources].join('\n');
}

/** A case's `// @xml-keys`: its keys and those its code names, its `helpers/xml-*.ts` the generated code. */
function xmlMemberKeys(listed: string[] | undefined, files: readonly ts.SourceFile[], checker: ts.TypeChecker): XmlMemberKeys | null {
  if (!listed) return null;
  const generated = new Set(files.map((f) => f.fileName).filter((f) => /[\\/]helpers[\\/]xml-[^\\/]*\.ts$/.test(f)));
  const named = scriptKeys(files, checker, generated);
  return named ? { keys: new Set([...listed, ...named]), generated } : null;
}

export interface SwiftOptions {
  /** Another ledger than the backend's own (tests/checks/decision-parity.ts). */
  ledger?: Ledger;
  /** Checked as core is (no strictNullChecks) and translated as the kit generated from core is: lenient, in library mode. */
  lenient?: boolean;
  /** What the kit's configuration holds weakly (tools/kit/modules.mts). */
  weak?: { fields: string[]; captures: string[] };
  /** Classes' accessors and methods readable by name, as an XML app's are. */
  membersByName?: boolean;
  /** The keys an XML app with no run-time XML site reads its objects by, from its XML (`// @xml-keys`). */
  xmlKeys?: string[];
  /** Translated as the CLI translates an app, with the strictness its own tsconfig.json gives (lenient where that is not strict). */
  appStrictness?: boolean;
  /**
   * A non-strict app whose modules under a `plugin` folder are a plugin's: translated as the CLI translates a plugin
   * compiled from its source (lenient, not in library mode), the rest as the app's code.
   */
  plugin?: boolean;
  /** Translated as a non-strict app's own code is (`strict: false` in its tsconfig.json). */
  lenientApp?: boolean;
  /** With `lenientApp`: translated from the strictly typed program the CLI translates an app from, checked as the app's own build checks it. */
  cliProgram?: boolean;
  /** False skips the copies preflight refuses (src/semantics/sharing.ts). */
  copiesChecked?: boolean;
  /** Class fields assigned in the constructor rather than defined (`useDefineForClassFields` off); else as the roots' tsconfig.json says. */
  assignFields?: boolean;
  /**
   * Each module translated on its own, what one cannot translate given here rather than thrown: the others still translate.
   * Without it, the first module that cannot translate throws.
   */
  refused?: (file: string, error: Error) => void;
  /** Translated as `--keep-going --all-errors`: the errors, each containing this text, are reported; what translated is written. */
  keepGoing?: string;
  /** The node_modules the program is typed against and its packages compiled from (default: modulesDir). */
  modules?: string;
}

/**
 * `roots` and the app modules they import as Swift in `out`: one file per module and the shapes' file.
 * The modules come back in evaluation order, for the entry point to run their inits.
 */
export function translateSwift(roots: string[], out: string, o: SwiftOptions = {}): TranslatedModule[] {
  const loose = !!o.lenient;
  const build = suiteBuild();
  const packages = new PluginSources({ app: suiteDir, platform: 'ios' });
  const { checker, program, files: programFiles, pluginFiles: packageFiles, resolved, lenient: lenientApp, assignsFields } = createProgram(roots, new Map(), 'ios', o.modules ?? modulesDir, packages, [], {}, loose ? { strict: false, useDefineForClassFields: false } : o.plugin || (o.lenientApp && !o.cliProgram) ? { strict: false, useUnknownInCatchVariables: false } : {}, undefined, o.lenientApp && o.cliProgram ? true : undefined, build);
  const rootFiles = programFiles.filter((sf) => !packageFiles.includes(sf.fileName));
  const imported = roots.flatMap((r) => importsOf(program, r, 'ios'));
  const appFiles = [...new Set([...roots, ...imported])];
  // The packages' sources the case reaches, compiled as an app's plugins are: only what it reaches, checked against npm's files.
  // A case's own plugin modules are reached as the CLI reaches a plugin's.
  const helperPlugins = o.plugin ? appFiles.filter((f) => /[\\/]plugin[\\/]/.test(f)) : [];
  const world = packageFiles.length || helperPlugins.length ? closedWorld(program, resolved, appFiles.filter((f) => !helperPlugins.includes(f)), [...new Set([...packageFiles, ...helperPlugins])], 'ios', build) : undefined;
  const reach = world?.reach;
  const compiled = world ? world.compiled.filter((f) => packageFiles.includes(f)) : [];
  packages.verify(compiled);
  // The helper modules the roots import are the program's too, as an app's every module is.
  const all = [...rootFiles, ...imported.map((f) => program.getSourceFile(f)!).filter((sf) => sf && !rootFiles.includes(sf)), ...packageFiles.map((f) => program.getSourceFile(f)!)];
  // In library mode, as the kit generated from core is: each module's functions and variables in an enum.
  const library = loose ? { moduleName: (f: string) => (f.endsWith('.d.ts') ? null : 'Module_' + basename(f).replace(/\W/g, '_')) } : null;
  const plugin = [...(o.plugin ? all.map((f) => f.fileName).filter((f) => /[\\/]plugin[\\/]/.test(f)) : []), ...packageFiles];
  const lenientPlugins = [...(o.plugin ? plugin.filter((f) => !packageFiles.includes(f)) : []), ...packageFiles.filter((f) => !writtenStrict(f, build.adapter))];
  // Every module, as an app's are: names its modules share are told apart across them.
  if (!loose && o.copiesChecked !== false) refuseCopies(checker, all, lenientPlugins, (st) => !packageFiles.includes(st.getSourceFile().fileName) || !reach || reach.keeps(st));
  // With source lines, as an app is built: the directives must compile wherever a statement can be.
  const lines = new SourceLines(new Map());
  const translator = new Translator(checker, new Map(), all, {
    ...build.translation(),
    ledger: o.ledger,
    hooks: suiteAdapter?.swift,
    lenient: loose,
    library,
    weak: o.weak,
    xmlMemberKeys: xmlMemberKeys(o.xmlKeys, all, checker),
    assignFields: o.assignFields ?? assignsFields,
    lenientApp: !!(o.plugin || o.lenientApp || (o.appStrictness && lenientApp)),
    ...(loose ? { pluginFiles: all.map((f) => f.fileName), properties: collectProperties(checker, all) } : plugin.length ? { pluginFiles: plugin, lenientFiles: lenientPlugins, properties: collectProperties(checker, all), reach } : {}),
    compiledFiles: reach ? new Set([...compiled, ...helperPlugins.filter((f) => reach.modules.has(f))]) : null,
    errors: process.env.NS_DIFF_ALL_ERRORS || o.keepGoing ? [] : null,
    appModule: 'Main',
    appMembersByName: !!o.membersByName,
    lines,
  });
  const files = [...appFiles, ...compiled];
  const modules = o.refused ? eachModule(program, files, (f) => translateModules(translator, program, [f], resolved), o.refused) : translateModules(translator, program, files, resolved);
  if (o.keepGoing) keptGoing(translator.errors!, o.keepGoing);
  else if (translator.errors?.length) throw Object.assign(new Error([...new Set(translator.errors)].join('\n')), { refusals: build.refusals });
  addInterfaces(translator, modules);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Module names that differ only in case (a package's `observable` and `Observable`) are separate files on a case-insensitive disk.
  const taken = new Set<string>();
  for (const m of modules) {
    let file = m.name;
    while (taken.has(file.toLowerCase())) file += '_module';
    taken.add(file.toLowerCase());
    writeFileSync(join(out, file + '.swift'), SWIFT_HEADER + lines.swift(m.code));
  }
  writeFileSync(join(out, '__Objects.swift'), SWIFT_HEADER + translator.shapesCode() + '\n');
  return modules;
}

export const SWIFT_HEADER = 'import Foundation\nimport NativeScriptKit\n\n';

/**
 * Node's handling of an error nothing catches, where script sets no handler (`globalThis.__onUncaughtError`): the
 * error on standard error and exit status 1. The kit's own default reports it and goes on, as an app's runtime does.
 */
const NODE_UNCAUGHT_SWIFT = `let __reported = jsUncaughtHandler
jsUncaughtHandler = { value in
    if jsIsNullish(jsField(jsGlobalThis, "__onUncaughtError")) { jsError("Uncaught", value); exit(1) }
    __reported(value)
}
let __rejected = Microtasks.onUnhandledRejection
Microtasks.onUnhandledRejection = { reason in
    if jsIsNullish(jsField(jsGlobalThis, "__onUncaughtError")) { jsError("Uncaught (in promise)", reason); exit(1) }
    __rejected(reason)
}
`;
const NODE_UNCAUGHT_KOTLIN = `    val reported = jsUncaughtHandler
    jsUncaughtHandler = { value ->
        if (jsIsNullish(jsField(jsGlobalThis, "__onUncaughtError"))) { jsError("Uncaught", value); System.out.flush(); kotlin.system.exitProcess(1) }
        reported(value)
    }
    val rejected = Microtasks.onUnhandledRejection
    Microtasks.onUnhandledRejection = { reason ->
        if (jsIsNullish(jsField(jsGlobalThis, "__onUncaughtError"))) { jsError("Uncaught (in promise)", reason); System.out.flush(); kotlin.system.exitProcess(1) }
        rejected(reason)
    }
`;

/** The entry point an app's modules run from: each module's top level in order, then the event loop. */
/** The untyped values an app build refuses to copy (cli.ts's preflight), as its error. */
function refuseCopies(checker: ts.TypeChecker, files: readonly ts.SourceFile[], lenient: string[], keeps: (st: ts.Statement) => boolean): void {
  const found: string[] = [];
  checkSharing(checker, files, (n, what) => {
    const sf = n.getSourceFile();
    found.push(`${basename(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what} is not supported in a compiled release`);
  }, keeps, (f) => lenient.includes(f));
  if (found.length) throw new Error(found.join('\n'));
}

export function swiftMain(modules: TranslatedModule[]): string {
  const active = modules.filter((m) => m.init);
  const anyThrows = active.some((m) => m.initThrows);
  const calls = active.map((m) => `${anyThrows ? '    ' : ''}${m.initThrows ? 'try ' : ''}${m.init}()\n`).join('');
  const inits = active.length ? (anyThrows ? `jsReport {\n${calls}}\n` : calls) : '';
  return `${SWIFT_HEADER}${NODE_UNCAUGHT_SWIFT}${inits}JSEventLoop.runUntilIdle()\n`;
}

/**
 * An executable from Swift sources linking the runtime in `build`; the compiler's error lines when it does not compile.
 * Its warning lines go into `warnings` when given.
 */
export function swiftc(sources: string[], exe: string, build: string, optimize: Optimize, extraFlags: string[] = [], warnings?: string[]): string[] | null {
  const r = spawnSync('xcrun', ['swiftc', optimize, ...SWIFT_MODE, ...extraFlags, '-module-name', 'Main', '-I', build, '-L', build, '-lNativeScriptKit', '-o', exe, ...sources], { encoding: 'utf8', maxBuffer: 256 << 20 });
  warnings?.push(...new Set(r.stderr.split('\n').filter((l) => /^\S.*: warning:/.test(l))));
  if (r.status === 0) return null;
  const errors = r.stderr.split('\n').filter((l) => /error:/.test(l));
  return errors.length ? errors : [r.stderr.slice(0, 2000) || `swiftc exited ${r.status ?? r.signal}`];
}

export interface KotlinOptions {
  /** Another ledger than the backend's own (tests/checks/decision-parity.ts). */
  ledger?: Ledger;
  /** Translated as kotlin/kit-gen.ts generates kit-android: lenient, in library mode. */
  lenient?: boolean;
  /** See SwiftOptions.keepGoing. */
  keepGoing?: string;
  membersByName?: boolean;
  xmlKeys?: string[];
  appStrictness?: boolean;
  lenientApp?: boolean;
  cliProgram?: boolean;
  /** As SwiftOptions' `plugin`. */
  plugin?: boolean;
  /** False skips the copies preflight refuses (src/semantics/sharing.ts). */
  copiesChecked?: boolean;
  assignFields?: boolean;
  refused?: (file: string, error: Error) => void;
  /** Core's classes are kit-android's as generated from core (`nx run compiler:kit-android`). */
  generatedKit?: boolean;
  modules?: string;
  /** The source lines the modules' markers index, for a caller reading their line tables. */
  sourceLines?: SourceLines;
}

/** `roots` and the app modules they import as Kotlin in package `pkg`, in `out`. */
export function translateKotlin(roots: string[], out: string, pkg: string, o: KotlinOptions = {}): KotlinModule[] {
  const loose = !!o.lenient;
  const build = suiteBuild();
  const packages = new PluginSources({ app: suiteDir, platform: 'android' });
  const { checker, program, files: programFiles, pluginFiles: packageFiles, resolved, lenient: lenientApp, assignsFields } = createProgram(roots, new Map(), 'android', o.modules ?? modulesDir, packages, [], {}, loose ? { strict: false, useDefineForClassFields: false } : o.plugin || (o.lenientApp && !o.cliProgram) ? { strict: false, useUnknownInCatchVariables: false } : {}, undefined, o.lenientApp && o.cliProgram ? true : undefined, build);
  const rootFiles = programFiles.filter((sf) => !packageFiles.includes(sf.fileName));
  const imported = roots.flatMap((r) => importsOf(program, r, 'android'));
  const appFiles = [...new Set([...roots, ...imported])];
  // A case's own plugin modules are reached as the CLI reaches a plugin's.
  const helperPlugins = o.plugin ? appFiles.filter((f) => /[\\/]plugin[\\/]/.test(f)) : [];
  const world = packageFiles.length || helperPlugins.length ? closedWorld(program, resolved, appFiles.filter((f) => !helperPlugins.includes(f)), [...new Set([...packageFiles, ...helperPlugins])], 'android', build) : undefined;
  const reach = world?.reach;
  const compiled = world ? world.compiled.filter((f) => packageFiles.includes(f)) : [];
  packages.verify(compiled);
  // Every module, as an app's are: a class another module extends stays open.
  const all = [...rootFiles, ...imported.map((f) => program.getSourceFile(f)!).filter((sf) => sf && !rootFiles.includes(sf)), ...packageFiles.map((f) => program.getSourceFile(f)!)];
  const library = { identities: new Set<string>(), counterpart: () => null, moduleName: (f: string) => (f.endsWith('.d.ts') ? null : 'Module_' + basename(f).replace(/\W/g, '_')) };
  const plugin = [...(o.plugin ? all.map((f) => f.fileName).filter((f) => /[\\/]plugin[\\/]/.test(f)) : []), ...packageFiles];
  const lenientPlugins = [...(o.plugin ? plugin.filter((f) => !packageFiles.includes(f)) : []), ...packageFiles.filter((f) => !writtenStrict(f, build.adapter))];
  if (!loose && o.copiesChecked !== false) refuseCopies(checker, all, lenientPlugins, (st) => !packageFiles.includes(st.getSourceFile().fileName) || !reach || reach.keeps(st));
  const lines = o.sourceLines ?? new SourceLines(new Map());
  const translator = new KotlinTranslator(checker, new Map(), all, {
    ...build.translation(),
    ledger: o.ledger,
    hooks: suiteAdapter?.kotlin,
    xmlMemberKeys: xmlMemberKeys(o.xmlKeys, all, checker),
    assignFields: o.assignFields ?? assignsFields,
    lenientApp: !!(o.plugin || o.lenientApp || (o.appStrictness && lenientApp)),
    ...(loose ? { lenient: true, library, pluginFiles: all.map((f) => f.fileName), properties: collectProperties(checker, all) } : plugin.length ? { pluginFiles: plugin, lenientFiles: lenientPlugins, properties: collectProperties(checker, all), reach } : {}),
    appModule: pkg,
    appMembersByName: !!o.membersByName,
    core: o.generatedKit ? (t) => new CoreKotlin(t) : undefined,
    errors: process.env.NS_DIFF_ALL_ERRORS || o.keepGoing ? [] : null,
    lines,
  });
  const files = [...appFiles, ...compiled];
  const modules = o.refused ? eachModule(program, files, (f) => translateKotlinModules(translator, program, [f], resolved), o.refused) : translateKotlinModules(translator, program, files, resolved);
  if (o.keepGoing) keptGoing(translator.errors!, o.keepGoing);
  else if (translator.errors?.length) throw Object.assign(new Error([...new Set(translator.errors)].join('\n')), { refusals: build.refusals });
  addKotlinInterfaces(translator, modules);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const header = kotlinHeader(pkg);
  for (const m of modules) writeFileSync(join(out, m.name + '.kt'), header + lines.kotlin(m.code).code);
  writeFileSync(join(out, '__Objects.kt'), header + translator.shapesCode() + '\n');
  return modules;
}

export const kotlinHeader = (pkg: string) => `package ${pkg}\n\nimport org.nativescript.kit.*\n\n`;

/** The entry point, in a package of its own (a program may declare a `main` of its own): each module's top level in order, then the event loop. */
export function kotlinMain(modules: KotlinModule[], pkg: string): string {
  const active = modules.filter((m) => m.init);
  const calls = active.map((m) => `        ${m.init}()\n`).join('');
  const inits = active.length ? `    try {\n${calls}    } catch (__e: Throwable) {\n        jsReportThrown(__e)\n    }\n` : '';
  return `package ${pkg}.entry\n\nimport org.nativescript.kit.*\nimport ${pkg}.*\n\nfun main() {\n${NODE_UNCAUGHT_KOTLIN}${inits}    JSEventLoop.runUntilIdle()\n    System.out.flush()\n}\n`;
}

/** Modules in evaluation order, each translated alone so that one that cannot be does not stop the rest. */
function keptGoing(errors: string[], want: string): void {
  if (!errors.length) throw new Error(`translated with no error, where the case declares one containing ${JSON.stringify(want)}`);
  const other = errors.find((e) => !e.includes(want));
  if (other) throw new Error(other);
}

function eachModule<M>(program: ts.Program, files: string[], one: (file: string) => M[], refused: (file: string, error: Error) => void): M[] {
  const out: M[] = [];
  for (const f of evaluationOrder(program, files)) {
    try { out.push(...one(f)); } catch (e) { refused(f, e as Error); }
  }
  return out;
}

/**
 * The app modules a file imports (relative imports, transitively), each as the program loaded it: for `platform`,
 * `./x` is `x.<platform>.ts` where there is one, as the bundler resolves it.
 */
export function importsOf(program: ts.Program, file: string, platform?: 'ios' | 'android'): string[] {
  const out = new Set<string>();
  const visit = (f: string) => {
    const sf = program.getSourceFile(f);
    if (!sf) return;
    for (const st of sf.statements) {
      const spec = (st as any).moduleSpecifier?.text as string | undefined;
      if (!spec?.startsWith('.')) continue;
      const base = resolve(dirname(f), spec);
      // A specifier naming its file (`./x.ts`) is that file.
      const candidates = spec.endsWith('.ts') ? [base] : [...(platform ? [`${base}.${platform}.ts`] : []), `${base}.ts`, ...(platform ? [`${base}/index.${platform}.ts`] : []), `${base}/index.ts`];
      const target = candidates.find((c) => program.getSourceFile(c));
      if (target && !out.has(target)) { out.add(target); visit(target); }
    }
  };
  visit(file);
  return [...out];
}

// ---- Kotlin toolchain -------------------------------------------------------------------------

let toolchain: ReturnType<typeof kotlinToolchain> | null = null;

/** The Kotlin standard library classes run against. */
export function kotlinStdlib(): string {
  toolchain ??= kotlinToolchain();
  return toolchain.stdlib;
}

/** Kotlin sources compiled to classes in `out`; the compiler's error lines when they do not compile. `extraFlags` go to kotlinc as given. */
export function kotlinc(sources: string[], out: string, classpath: string[], extraFlags: string[] = []): string[] | null {
  toolchain ??= kotlinToolchain();
  rmSync(out, { recursive: true, force: true });
  // Many programs' sources at once outgrow the OS's argument size limit, so they go to kotlinc in an argument file.
  const argfile = `${out}.sources`;
  mkdirSync(dirname(argfile), { recursive: true });
  writeFileSync(argfile, sources.map((f) => JSON.stringify(f)).join('\n'));
  const r = toolchain.compile([`@${argfile}`, '-d', out, '-no-stdlib', '-nowarn', '-jvm-target', '17', ...extraFlags, '-cp', [toolchain.stdlib, ...classpath].join(':')]);
  if (r.error) throw r.error;
  if (r.status === 0) return null;
  // An error's own lines after its first (`conflicting declarations:` and what conflicts) belong to it.
  const errors: string[] = [];
  let open = false;
  for (const l of (r.stderr + r.stdout).split('\n')) {
    if (/error:/.test(l)) { errors.push(l); open = true; } else if (open && l.trim() && !/^\S+:\d+:\d+: \w+:/.test(l) && !/^(warning|info):/.test(l)) errors[errors.length - 1] += ' ' + l.trim();
    else open = false;
  }
  return errors.length ? errors : [r.stderr.slice(0, 2000) || `kotlinc exited ${r.status}`];
}

/** kit-android's runtime as classes in `build`, rebuilt when a source is newer or it was built with other flags. */
export function buildKotlinRuntime(build: string, extraFlags: string[] = []): string {
  const out = join(build, 'kotlin-runtime');
  const stamp = join(out, '.built');
  // As buildSwiftRuntime's: the sources' paths too.
  const flags = [...extraFlags, ...kotlinRuntimeSources].join(' ');
  const newest = Math.max(...kotlinRuntimeSources.map((f) => statSync(f).mtimeMs));
  if (existsSync(stamp) && statSync(stamp).mtimeMs > newest && readFileSync(stamp, 'utf8') === runtimeStamp(flags, kotlinRuntimeSources)) return out;
  rmSync(out, { recursive: true, force: true });
  const errors = kotlinc(kotlinRuntimeSources, out, [], extraFlags);
  if (errors) throw new Error(`the Kotlin runtime does not compile:\n${errors.slice(0, 15).join('\n')}`);
  writeFileSync(stamp, runtimeStamp(flags, kotlinRuntimeSources));
  return out;
}
