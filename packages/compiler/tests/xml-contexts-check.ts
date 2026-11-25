#!/usr/bin/env node
// The binding contexts the compiler proves for xml-ts, apps/automated and apps/toolbox, per kind, with xml-ts site by site;
// the closures with typed reads; and the diff cases 1085-1088 holding the closures and helpers the compiler emits.
//   node tests/xml-contexts-check.ts [--list]
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadCoreXml, xmlPlan } from '../src/xml/plan.ts';
import { xmlBindingContexts } from '../src/xml/contexts.ts';
import { compileBindings, compileExpression, expressionParser, HELPERS } from '../src/xml/bindings.ts';

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
const core = await loadCoreXml();
const results: Record<string, ReturnType<typeof xmlBindingContexts>> = {};
for (const [name, dir] of Object.entries(apps)) {
  const files = walk(dir);
  const program = ts.createProgram(files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')), {
    noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { '@nativescript/core': [coreTypes], '@nativescript/core/*': [coreTypes + '/*'] },
  });
  const xml = files.filter((f) => f.endsWith('.xml')).map((f) => ({ name: relative(dir, f), text: readFileSync(f, 'utf8') }));
  const r = xmlBindingContexts(xmlPlan(core, dir, xml, program, 'ios').pages, program, dir);
  results[name] = r;
  console.log(`${name}: ${r.sites.length} bindings: ${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(', ')}; ${r.sites.filter((s) => s.typed).length} with a typed class; unseen writes ${r.unseen.length}`);
  if (process.argv.includes('--list')) {
    for (const u of r.unseen) console.log(`  unseen write ${u}`);
    const why = new Map<string, number>();
    for (const s of r.sites) if (s.why) why.set(s.why.replace(/ at .*/, ''), (why.get(s.why.replace(/ at .*/, '')) ?? 0) + 1);
    for (const [w, n] of why) console.log(`  unknown ${n}x ${w}`);
  }
}
const x = results['xml-ts'];
for (const s of x.sites) console.log(`  ${s.key} ${s.binding.source}: ${s.kind}${s.typed ? ` ${s.typed.className} (${s.typed.members.join(' ')})` : ''}${s.why ? ` (${s.why})` : ''}`);
assert.deepEqual(x.counts, { typed: 6, record: 3, object: 0, template: 2, inherited: 1, unknown: 0 });

const parse = expressionParser(join(repo, 'packages/core/'));
const compiled = compileBindings(parse, x.sites);
console.log(`xml-ts closures: ${compiled.sites.length}, ${compiled.sites.filter((c) => c.typed).length} with typed reads; imports ${[...compiled.imports].map(([n, i]) => `${i.exportName} from ${i.module} as ${n}`).join(', ')}`);
assert.deepEqual(compiled.sites.filter((c) => c.typed).map((c) => c.key), ['main-page.xml:5:5:text', 'main-page.xml:6:5:text', 'main-page.xml:6:5:class', 'main-page.xml:7:5:text']);
for (const [name, r] of Object.entries(results)) {
  const c = compileBindings(parse, r.sites);
  console.log(`${name}: ${c.sites.length} closures, ${c.sites.filter((s) => s.typed).length} with typed reads`);
}

const cases = join(here, 'diff/cases');
assert.ok(readFileSync(join(cases, 'helpers/xml-nsb.ts'), 'utf8').endsWith(HELPERS.replace('const __nsb = {', 'export const __nsb = {')), 'helpers/xml-nsb.ts is HELPERS');
const expect: [string, string, string?, string?][] = [
  ['1085-xml-context-class', "'Taps: ' + counter", '__nsCtx0', 'counter items message'],
  ['1085-xml-context-class', "counter > 3 ? 'Many taps' : 'Few taps'", '__nsCtx0', 'counter items message'],
  ['1085-xml-context-class', "items.length + ' items'", '__nsCtx0', 'counter items message'],
  ['1085-xml-context-class', "'Taps: ' + counter"],
  ['1085-xml-context-class', "items.length + ' items'"],
  ['1086-xml-context-record', "badge + '!'"],
  ['1086-xml-context-record', "fruits.length + ' kinds'"],
  ['1086-xml-context-record', "picked || 'Nothing picked'"],
  ['1087-xml-context-template', "count + ' left'", '__nsCtx1', 'name count'],
  ['1087-xml-context-template', "count + ' left'"],
  ['1088-xml-context-any', "'Taps: ' + counter"],
];
for (const [file, text, guard, members] of expect) {
  const closure = compileExpression(parse, text, false, guard ? { guard, members: new Set(members!.split(' ')) } : undefined)!;
  assert.ok(readFileSync(join(cases, `${file}.ts`), 'utf8').includes(closure), `${file}: ${closure}`);
}
console.log(`diff cases: ${expect.length} closures as emitted`);
