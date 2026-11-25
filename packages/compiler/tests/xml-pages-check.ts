#!/usr/bin/env node
// The page factories of xml-ts, apps/automated and apps/toolbox for iOS and Android: which files get one and why the rest
// keep the Builder, each module type-checked against core with the app's sources, and the diff case 1090's helpers being
// the ones the compiler emits.
//   node tests/xml-pages-check.ts [--print <app> <platform>]
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadCoreXml, xmlPlan, type PlanPlatform } from '../src/xml/plan.ts';
import { xmlBindingContexts } from '../src/xml/contexts.ts';
import { bindingsModule, closureNames, compileBindings, expressionParser } from '../src/xml/bindings.ts';
import { PAGE_HELPERS, pagesModule, textsModule, treeDumpModule } from '../src/xml/pages.ts';
import { bindSites, foldSites, textBindingSites } from '../src/xml/fold.ts';

const here = dirname(fileURLToPath(import.meta.url));
const monorepo = resolve(here, '../../..');
const repo = [process.env.NS_CORE_REPO, monorepo, join(monorepo, 'core'), resolve(monorepo, '../../NativeScript/NativeScript')].find((c): c is string => !!c && existsSync(join(c, 'packages/core/package.json'))) ?? monorepo;
// xml-ts: the small XML app in tests/xml-ts, or the one $XML_TS_APP names.
const xmlTs = process.env.XML_TS_APP ?? join(here, 'xml-ts');
const apps = {
  'xml-ts': join(xmlTs, 'app'),
  automated: join(repo, 'apps/automated/src'),
  toolbox: join(repo, 'apps/toolbox/src'),
};
const coreTypes = join(here, 'node_modules/@nativescript/core');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  if (/^(node_modules|App_Resources|platforms|hooks)$/.test(f)) return [];
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const optionsWith = (core: string): ts.CompilerOptions => ({
  noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  paths: { '@nativescript/core': [core], '@nativescript/core/*': [core + '/*'] },
});
// automated depends on the repository's core (`file:../../packages/core`), the others on the published one.
const coreOf: Record<string, string> = { automated: join(repo, 'packages/core') };
const globals = `declare function __nsRegisterPage(file: string, factory: ((exports: any, moduleName: string, xmlModule: string) => any) | undefined, codeModule?: string, codeExports?: any): void;
declare function __nsRegisterCompiledBinding(key: string, binding: any): void;
declare var global: any;\n`;
const core = await loadCoreXml();
const parse = expressionParser(join(repo, 'packages/core/'));
const print = process.argv.indexOf('--print');
const counts: Record<string, string> = {};
const keptKinds: Record<string, Record<string, number>> = {};
const textsSources: Record<string, string> = {};
for (const [name, dir] of Object.entries(apps)) {
  const files = walk(dir);
  const sources = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const options = optionsWith(coreOf[name] ?? coreTypes);
  const program = ts.createProgram(sources, options);
  const xml = files.filter((f) => f.endsWith('.xml')).map((f) => ({ name: relative(dir, f), text: readFileSync(f, 'utf8') }));
  for (const platform of ['ios', 'android'] as PlanPlatform[]) {
    const plan = xmlPlan(core, dir, xml, program, platform);
    const contexts = xmlBindingContexts(plan.pages, program, dir);
    const byKey = new Map(contexts.sites.map((s) => [s.key, s]));
    const binds = bindSites(plan, program, dir);
    const folds = [...textBindingSites(plan), ...binds];
    const compiled = compileBindings(parse, [...contexts.sites.map((s) => ({ key: s.key, binding: s.binding, typed: byKey.get(s.key)?.typed })), ...folds]);
    const bindings = bindingsModule(compiled, new Set(folds.map((f) => f.key)));
    const names = closureNames(compiled).names;
    const pages = pagesModule(plan, names, bindings ? './__xml_bindings' : null);
    const texts = textsModule(plan, names, bindings ? './__xml_bindings' : null);
    const folded = foldSites(plan, program, dir, texts, binds, names, join(dir, '__xml_texts.ts'), bindings ? join(dir, '__xml_bindings.ts') : null);
    counts[`${name} ${platform}`] = `${pages.pages.length} factories, ${pages.runtime.length} Builder; ${folded.folded.length} folded, ${folded.kept.length} kept`;
    console.log(`${name} ${platform}: ${pages.pages.length} files built by factory, ${pages.runtime.length} by the Builder; constant text in app code: ${folded.folded.length} sites folded, ${folded.kept.length} kept`);
    for (const r of pages.runtime) console.log(`  ${r.file}: ${r.reason}`);
    const kinds: Record<string, number> = {};
    for (const k of folded.kept) {
      const d = plan.dynamic[k.site];
      kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
      console.log(`  kept ${d.file}:${d.line} ${d.kind}: ${k.reason}`);
    }
    keptKinds[`${name} ${platform}`] = kinds;
    textsSources[`${name} ${platform}`] = texts.source;
    if (print > 0 && process.argv[print + 1] === name && process.argv[print + 2] === platform) console.log(pages.source, texts.source, [...folded.files.values()].join('\n'));
    // The modules as the compiler adds them, and the app files it rewrites, type-checked with the app's sources.
    const virtual = new Map([[join(dir, '__xml_pages.ts'), pages.source || 'export {};\n'], [join(dir, '__xml_dump.ts'), treeDumpModule(plan, pages)], [join(dir, '__globals.d.ts'), globals]]);
    if (bindings) virtual.set(join(dir, '__xml_bindings.ts'), bindings);
    if (texts.source) virtual.set(join(dir, '__xml_texts.ts'), texts.source);
    for (const [file, text] of folded.files) {
      virtual.set(file, text);
      const before = program.getSourceFile(file)!.text.split('\n');
      const after = text.split('\n');
      assert.equal(after.length, before.length, `${file}: the rewrite keeps every line`);
      // Each line is unchanged, or holds a folded site (or the imports, on the first statement's line).
      for (let i = 0; i < before.length; i++) if (after[i] !== before[i]) assert.match(after[i], /__xml(Parse|Template|Templates)\d+|compiled: __nsbE\d+|^\s*\)?;?$|^\s*\)|^import \{ [\w, ]+ \} from "[./]+\/__xml_(texts|bindings)";/, `${file}:${i + 1}`);
    }
    const host = ts.createCompilerHost(options);
    const read = host.readFile, exists = host.fileExists, source = host.getSourceFile;
    host.readFile = (f) => virtual.get(f) ?? read(f);
    host.fileExists = (f) => virtual.has(f) || exists(f);
    host.getSourceFile = (f, v, ...rest) => (virtual.has(f) ? ts.createSourceFile(f, virtual.get(f)!, v) : source(f, v, ...rest));
    const checked = ts.createProgram([...sources, ...virtual.keys()], options, host);
    const before = new Set(ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`));
    const errors = ts.getPreEmitDiagnostics(checked).filter((d) => d.file && virtual.has(d.file.fileName) && !before.has(`${d.file.fileName}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`));
    for (const d of errors) console.log(`  ${relative(dir, d.file!.fileName)}:${d.file!.getLineAndCharacterOfPosition(d.start!).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    assert.equal(errors.length, 0, `${name} ${platform}: the generated modules type-check`);
  }
}
assert.equal(counts['xml-ts ios'], '4 factories, 0 Builder; 0 folded, 0 kept');
assert.equal(counts['toolbox ios'], '54 factories, 0 Builder; 0 folded, 3 kept');
// automated: every constant text folded (73 Builder.parse, 18 itemTemplate, 5 itemTemplates, 7 bind) but 5 the Builder
// throws on (nested platform blocks, 4 `customControls:` elements with no class); kept, 28 computed at run time.
assert.equal(counts['automated ios'], '53 factories, 9 Builder; 98 folded, 33 kept');
assert.deepEqual(keptKinds['automated ios'], { moduleName: 4, 'Builder.parse': 20, itemTemplates: 8, 'Builder.load': 1 });
// Case 1105 holds the shapes the texts module takes.
const textCase = readFileSync(join(here, 'diff/cases/1105-xml-text-fold.ts'), 'utf8');
for (const shape of [
  /^  let ctx: any = context \? __xmlGetExports\(context\) : undefined;$/m,
  /^export const __xmlTemplate\d+: \(\) => (__xml)?View = \(\) => __xmlParse\d+\(\);$/m,
  /^export function __xmlTemplates\d+\(\): (__xml)?KeyedTemplate\[\] \{$/m,
  /^  return \[\{ key: .*createView: \(\) => __xmlT\d+\(null\) \}/m,
]) {
  assert.match(textCase, shape, `1105 has ${shape}`);
  assert.match(textsSources['automated ios'], shape, `automated's texts module has ${shape}`);
}
const helpers = readFileSync(join(here, 'diff/cases/helpers/xml-page.ts'), 'utf8');
assert.ok(helpers.endsWith(PAGE_HELPERS.replace('const __xml = {', 'export const __xml = {')), 'helpers/xml-page.ts ends with PAGE_HELPERS');
console.log('xml-pages-check: ok');
