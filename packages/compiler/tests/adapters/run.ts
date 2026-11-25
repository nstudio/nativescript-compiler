#!/usr/bin/env node
// The adapter API's contract, checked with the adapter of a framework that exists only here (fake/, an app of it in
// fake-app/): how the compiler finds an adapter, refuses one it cannot load, and builds an app of its framework's Swift
// and Kotlin text asking the adapter only what the API declares (adapter-api.ts).
//   node tests/adapters/run.ts
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FrameworkAdapter } from '../../src/api/adapter-api.ts';
import { ADAPTERS_OVERRIDE, adapterOf, availableAdapters, compilerVersion, loadAdapter } from '../../src/adapters/load.ts';
import { BuildContext } from '../../src/program/build-context.ts';
import { pathAliases } from '../../src/program/app-paths.ts';
import { render } from '../../src/swift/render.ts';
import { render as renderKotlin } from '../../src/kotlin/render.ts';
import { componentMembersOf } from '../../src/template/plan.ts';
import { detectFramework } from '../../src/adapters/framework.ts';
import { translateKotlinModules } from '../../src/kotlin/app-modules.ts';
import { translateModules } from '../../src/swift/app-modules.ts';
import { createProgram } from '../../src/program/program.ts';
import { PluginSources } from '../../src/plugins/source.ts';
import { refusalOf, refusalReport, type RefusalId } from '../../src/semantics/refusals.ts';
import { Translator as SwiftTranslator } from '../../src/swift/translator.ts';
import { Translator as KotlinTranslator } from '../../src/kotlin/translator.ts';
import { check, finish } from '../release-checks/checks.ts';
import { modulesDir, root, ts } from '../native-build.ts';

const here = import.meta.dirname;
const work = mkdtempSync(join(tmpdir(), 'ns-adapter-api-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const message = async (f: () => unknown) => { try { await f(); return ''; } catch (e) { return (e as Error).message; } };
const version = compilerVersion();

/** The fake app in a folder of its own, typed against the tests' node_modules. */
function appCopy(name: string): string {
  const app = join(work, name);
  cpSync(join(here, 'fake-app'), app, { recursive: true });
  symlinkSync(modulesDir, join(app, 'node_modules'), 'dir');
  return app;
}

// ---- Discovery ----
const app = appCopy('app');
const appDir = join(app, 'app');
const entry = join(appDir, 'app.ts');
const files = readdirSync(appDir).map((f) => join(appDir, f)).filter((f) => statSync(f).isFile());
process.env[ADAPTERS_OVERRIDE] = here;
const found = availableAdapters(app);
const fake = found.find((a) => a.framework === 'fake');
check(!!fake && fake.development && fake.name === '@nstudio/nativescript-compiler-fake' && fake.detect.dependencies?.includes('fake-framework') === true, `an adapter in a folder $${ADAPTERS_OVERRIDE} names is found, its package.json read without loading it`);
check(detectFramework(app, found, entry, files, appDir) === 'fake', "an app depending on a package an adapter's `detect` lists is that adapter's framework's");
delete process.env[ADAPTERS_OVERRIDE];
check(availableAdapters(app).length === 0 && (await message(() => adapterOf('fake', []))).includes(`building it needs the compiler's fake adapter, @nstudio/nativescript-compiler-fake, which is not installed: npm i -D @nstudio/nativescript-compiler-fake@${version}`),
  'an app whose framework has no adapter installed is told the command installing it');

// ---- An adapter installed in the app ----
/** The adapter installed in a copy of the app, its package.json changed by `edit`, built to JavaScript as published. */
function installed(name: string, edit: (pkg: any) => void, entryText?: string): string {
  const dir = appCopy(name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, devDependencies: { '@nstudio/nativescript-compiler-fake': '0.0.0' } }));
  rmSync(join(dir, 'node_modules'));
  mkdirSync(join(dir, 'node_modules', '@nstudio'), { recursive: true });
  for (const m of readdirSync(modulesDir)) symlinkSync(join(modulesDir, m), join(dir, 'node_modules', m));
  const adapter = join(dir, 'node_modules', '@nstudio', 'nativescript-compiler-fake');
  cpSync(join(here, 'fake'), adapter, { recursive: true });
  const adapterPkg = JSON.parse(readFileSync(join(adapter, 'package.json'), 'utf8'));
  edit(adapterPkg);
  writeFileSync(join(adapter, 'package.json'), JSON.stringify(adapterPkg));
  if (entryText) writeFileSync(join(adapter, 'index.ts'), entryText);
  const built = spawnSync(process.execPath, [join(root, 'bin', 'ns-compiled-adapter.js'), 'build', adapter], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`ns-compiled-adapter build: ${built.stderr}`);
  return dir;
}
const loaded = (dir: string) => message(() => loadAdapter(adapterOf('fake', availableAdapters(dir))));
check(await loaded(installed('fine', (p) => { p.peerDependencies['@nstudio/nativescript-compiler'] = version; })) === '', "an adapter listed in the app's package.json and installed for it loads, from the JavaScript its build wrote");
check((await loaded(installed('api', (p) => { p.nativescript.compilerAdapter.apiVersion = 99; }))).includes(`is written for compiler adapter API 99, and this @nstudio/nativescript-compiler ${version} reads API 1: install the @nstudio/nativescript-compiler-fake released with this compiler: npm i -D @nstudio/nativescript-compiler-fake@${version}`),
  'an adapter written for another adapter API is refused, naming the one to install');
check((await loaded(installed('peer', (p) => { p.peerDependencies['@nstudio/nativescript-compiler'] = '0.0.1'; }))).includes(`is built for @nstudio/nativescript-compiler 0.0.1, and this is ${version}: install the @nstudio/nativescript-compiler-fake released with this compiler`),
  'an installed adapter built for another compiler version is refused');
const fakeEntry = readFileSync(join(here, 'fake', 'index.ts'), 'utf8');
check((await loaded(installed('named', (p) => { p.peerDependencies['@nstudio/nativescript-compiler'] = version; }, fakeEntry.replace("name: 'fake',", "name: 'other',")))).includes('is the adapter of other, not of fake'),
  "an adapter whose entry gives another framework's adapter is refused");
check((await loaded(installed('entry-api', (p) => { p.peerDependencies['@nstudio/nativescript-compiler'] = version; }, fakeEntry.replace('apiVersion: 1,', 'apiVersion: 2 as 1,')))).includes('is written for adapter API 2; this @nstudio/nativescript-compiler has 1'),
  "an adapter whose entry gives another adapter API is refused");

// ---- An app of the framework, built through the API alone ----
/** What the API declares of each object an adapter gives (adapter-api.ts), by interface, its bases' members included. */
function declared(): Map<string, Set<string>> {
  const sf = ts.createSourceFile('adapter-api.ts', readFileSync(join(root, 'src', 'api', 'adapter-api.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const interfaces = new Map(sf.statements.filter(ts.isInterfaceDeclaration).map((d) => [d.name.text, d]));
  const members = (name: string): string[] => {
    const d = interfaces.get(name)!;
    const bases = (d.heritageClauses ?? []).flatMap((h) => h.types.map((t) => t.expression.getText(sf))).filter((b) => interfaces.has(b));
    return [...d.members.flatMap((m) => (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? [m.name.text] : [])), ...bases.flatMap(members)];
  };
  return new Map(['FrameworkAdapter', 'TemplateBehaviour', 'TranslatorHooks', 'ModuleRules', 'FrontEndResult'].map((n) => [n, new Set(members(n))]));
}
/** What the compiler asks of each object, by its interface. */
const asked = new Map<string, Set<string>>();
function recorded<T extends object>(o: T, api: string, nested: Record<string, string> = {}): T {
  return new Proxy(o, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      // `then`: a promise resolving to the object asks it, not the compiler.
      if (typeof key !== 'string' || key === 'then') return value;
      if (!asked.has(api)) asked.set(api, new Set());
      asked.get(api)!.add(key);
      if (nested[key] && value && typeof value === 'object') return recorded(value, nested[key]);
      if (api === 'FrameworkAdapter' && key === 'frontEnd') return async (...a: unknown[]) => recorded(await (value as Function).apply(target, a), 'FrontEndResult');
      return value;
    },
  });
}

process.env[ADAPTERS_OVERRIDE] = here;
const build = new BuildContext();
const adapter = recorded(await loadAdapter(adapterOf('fake', availableAdapters(app)), build), 'FrameworkAdapter', { behaviour: 'TemplateBehaviour', swift: 'TranslatorHooks', kotlin: 'TranslatorHooks', modules: 'ModuleRules' }) as FrameworkAdapter;
build.useAdapter(adapter);
const built: Record<string, string> = {};
for (const platform of ['ios', 'android'] as const) {
  const plugins = new PluginSources({ app, platform });
  const sources = files.filter((f) => f.endsWith('.ts') && f !== entry);
  const result = await adapter.frontEnd({
    root: app, appDir, entry, files, platform, entryText: readFileSync(entry, 'utf8'), sources, aliased: pathAliases(app), plugins,
    nodeModules: join(app, 'node_modules'), replacedPackages: new Set(),
  });
  const virtual = new Map(result.components.map((c) => [c.file, c.source] as [string, string]));
  const p = createProgram([...result.modules, ...virtual.keys()], virtual, platform, join(app, 'node_modules'), plugins, [], {}, {}, undefined, undefined, build);
  const classOf = (file: string) => p.program.getSourceFile(file)!.statements.find(ts.isClassDeclaration)!;
  const infos = new Map(result.components.map((c) => [c.name, { name: c.name, props: c.props, members: componentMembersOf(classOf(c.file), p.checker) }]));
  const behaviour = result.behaviour ?? adapter.behaviour;
  try {
    if (platform === 'ios') {
      const t = new SwiftTranslator(p.checker, infos, p.files, { hooks: adapter.swift, ...build.translation() });
      const modules = translateModules(t, p.program, result.modules).map((m) => m.code);
      const components = result.components.map((c) => [`final class ${c.name} {`, ...t.componentMembers(classOf(c.file), c.props), ...render(c, infos, () => false, behaviour), '}'].join('\n'));
      built.swift = [...modules, ...components].join('\n');
    } else {
      const t = new KotlinTranslator(p.checker, infos, p.files, { hooks: adapter.kotlin, ...build.translation(), appModule: 'org.nativescript.fakeapp' });
      const modules = translateKotlinModules(t, p.program, result.modules).map((m) => m.code);
      const components = result.components.map((c) => {
        const { params, lines } = t.componentMembers(classOf(c.file), c.props);
        return [`class ${c.name}(${params.join(', ')}) {`, ...lines, ...renderKotlin(c, infos, { behaviour }), '}'].join('\n');
      });
      built.kotlin = [...modules, ...components].join('\n');
    }
  } catch (e) {
    built[platform === 'ios' ? 'swift' : 'kotlin'] = `error: ${(e as Error).message}`;
  }
}
const { swift = '', kotlin = '' } = built;
check(/Double\(1234\.5\)/.test(swift) && /1234\.5/.test(kotlin), `the adapter's translator hooks translate its framework's calls (Swift, Kotlin)${swift.startsWith('error') || kotlin.startsWith('error') ? `: ${swift.slice(0, 300)} ${kotlin.slice(0, 300)}` : ''}`);
check(/final class Home \{/.test(swift) && /func render\(/.test(swift) && /StackLayout/.test(swift) && /Button/.test(swift) && /"Tapped "/.test(swift), "the front end's component renders as Swift: its template's views and bindings");
check(/class Home\(/.test(kotlin) && /fun render\(/.test(kotlin) && /StackLayout/.test(kotlin) && /Button/.test(kotlin) && /"Tapped "/.test(kotlin), "the front end's component renders as Kotlin: its template's views and bindings");
const api = declared();
const undeclared = [...asked].flatMap(([i, keys]) => [...keys].filter((k) => !api.get(i)!.has(k)).map((k) => `${i}.${k}`));
check(!undeclared.length && asked.get('FrameworkAdapter')!.has('frontEnd') && asked.get('TranslatorHooks')!.has('globalCall') && asked.get('ModuleRules')!.has('shims') && asked.has('TemplateBehaviour'),
  `the compiler asks the adapter only what the API declares${undeclared.length ? `: not ${undeclared.join(', ')}` : ''}`);

// ---- A component's field other code increments ----
const counterFile = join(appDir, 'counter.ts');
writeFileSync(counterFile, 'export class Counter {\n  taps = 0;\n}\nexport function tap(c: Counter): void {\n  c.taps++;\n}\n');
const fieldLines: string[] = [];
for (const platform of ['ios', 'android'] as const) {
  const p = createProgram([counterFile], new Map(), platform, join(app, 'node_modules'), undefined, [], {}, {}, undefined, undefined, build);
  const cls = p.program.getSourceFile(counterFile)!.statements.find(ts.isClassDeclaration)!;
  if (platform === 'ios') fieldLines.push(new SwiftTranslator(p.checker, new Map(), p.files, { hooks: adapter.swift, ...build.translation() }).componentMembers(cls, []).join('\n'));
  else fieldLines.push(new KotlinTranslator(p.checker, new Map(), p.files, { hooks: adapter.kotlin, ...build.translation() }).componentMembers(cls, []).lines.join('\n'));
}
check(fieldLines.every((l) => /\bvar taps\b/.test(l)), `a component's field other code increments is a variable on both backends${fieldLines.every((l) => /\bvar taps\b/.test(l)) ? '' : `: ${fieldLines.join(' | ').slice(0, 300)}`}`);

// ---- A refusal the adapter declares ----
const evalFile = join(appDir, 'run.ts');
writeFileSync(evalFile, "import { fakeEval } from 'fake-framework';\nexport const result = fakeEval('1 + 1');\n");
const refused: string[] = [];
for (const platform of ['ios', 'android'] as const) {
  const p = createProgram([evalFile], new Map(), platform, join(app, 'node_modules'), undefined, [], {}, {}, undefined, undefined, build);
  const errors: string[] = [];
  const t = platform === 'ios' ? new SwiftTranslator(p.checker, new Map(), p.files, { hooks: adapter.swift, ...build.translation(), errors }) : new KotlinTranslator(p.checker, new Map(), p.files, { hooks: adapter.kotlin, ...build.translation(), errors });
  if (t instanceof SwiftTranslator) translateModules(t, p.program, [evalFile]);
  else translateKotlinModules(t, p.program, [evalFile]);
  refused.push(errors.join('\n'));
}
check(refused.every((e) => e.includes('fakeEval() runs code given as text')) && refusalOf('fake-eval' as RefusalId, build.adapter).title === "fake-framework's fakeEval()" && refusalReport([{ id: 'fake-eval' as RefusalId, at: 'app/run.ts:2:23', code: "fakeEval('1 + 1')" }], build.adapter).includes("fake-framework's fakeEval() [fake-eval]"),
  `a refusal the adapter declares is reported as the compiler's own are${refused.some((e) => !e.includes('fakeEval')) ? `: ${refused.join(' | ').slice(0, 300)}` : ''}`);

finish('adapter API checks');
