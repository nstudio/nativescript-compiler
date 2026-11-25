#!/usr/bin/env node
// The XML page plans of xml-ts, apps/automated and apps/toolbox: every file planned, the totals, and hand-checked pages.
//   node tests/xml-plan-check.ts
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadCoreXml, xmlPlan, type ElementPlan, type PlanPlatform, type XmlPlan } from '../src/xml/plan.ts';

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
// Core's published declarations, as the tests' cases are typed: only element classes and their statics are read from them.
const coreTypes = join(here, 'node_modules/@nativescript/core');

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  if (/^(node_modules|App_Resources|platforms|hooks)$/.test(f)) return [];
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const core = await loadCoreXml();
const plans = new Map<string, XmlPlan>();
for (const [name, dir] of Object.entries(apps)) {
  const files = walk(dir);
  const program = ts.createProgram(files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')), {
    noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { '@nativescript/core': [coreTypes], '@nativescript/core/*': [coreTypes + '/*'] },
  });
  const xml = files.filter((f) => f.endsWith('.xml')).map((f) => ({ name: relative(dir, f), text: readFileSync(f, 'utf8') }));
  const styles = files.filter((f) => /\.s?css$/.test(f)).map((f) => relative(dir, f));
  for (const platform of ['ios', 'android'] as PlanPlatform[]) plans.set(`${name}-${platform}`, xmlPlan(core, dir, xml, program, platform, styles));
}
const plan = (key: string) => plans.get(key)!;
const page = (key: string, file: string) => {
  const p = plan(key).pages.find((x) => x.file === file);
  assert.ok(p, `${key}: ${file} planned`);
  return p;
};
const elements = (root: ElementPlan | null | undefined): ElementPlan[] => !root ? [] : [root,
  ...root.children.flatMap(elements),
  ...root.properties.flatMap((p) => [...elements(p.root), ...(p.templates ?? []).flatMap((t) => elements(t.root)), ...(p.children ?? []).flatMap(elements)])];

// Every XML file planned, with no parse or template error; every attribute's offset at its name in the file.
assert.deepEqual(['xml-ts', 'automated', 'toolbox'].map((a) => plan(`${a}-ios`).counts.files), [4, 62, 54]);
for (const [key, p] of plans) {
  const dir = apps[key.replace(/-(ios|android)$/, '') as keyof typeof apps];
  for (const pg of p.pages) {
    assert.deepEqual(pg.errors, [], `${key}: ${pg.file}`);
    const text = readFileSync(join(dir, pg.file), 'utf8');
    for (const el of elements(pg.root)) {
      assert.equal(text[el.offset], '<', `${key}: ${pg.file}:${el.line} element offset`);
      for (const a of el.attributes) assert.ok(text.startsWith(a.name, a.offset), `${key}: ${pg.file}:${el.line} ${a.name} offset`);
    }
  }
}

// The module resolver's fixtures hold only a comment.
assert.deepEqual(plan('automated-ios').pages.filter((p) => !p.root).map((p) => p.file), ['name-resolvers-tests/files/other.xml', 'name-resolvers-tests/files/test.land.xml', 'name-resolvers-tests/files/test.minWH600.xml', 'name-resolvers-tests/files/test.xml']);
assert.ok([...plans.values()].every((p) => p.pages.every((pg) => pg.root || pg.file.startsWith('name-resolvers-tests/'))));

// The totals the plan counts for iOS.
const c = (key: string) => plan(key).counts;
assert.deepEqual([c('xml-ts-ios').lines, c('automated-ios').lines, c('toolbox-ios').lines], [34, 789, 1646]);
assert.deepEqual(c('xml-ts-ios').elements, { core: 23, custom: 2, unknown: 0 });
assert.deepEqual(c('xml-ts-ios').bindings, { total: 12, name: 7, path: 0, expression: 5, long: 0, event: 1, value: 0, parent: 0, converter: 0, inTemplate: 2 });
assert.deepEqual(c('xml-ts-ios').events, { toExport: 5, other: 0 });
assert.deepEqual(c('automated-ios').elements, { core: 405, custom: 18, unknown: 19 });
assert.deepEqual(c('automated-ios').bindings, { total: 53, name: 18, path: 3, expression: 32, long: 0, event: 1, value: 3, parent: 0, converter: 0, inTemplate: 3 });
assert.deepEqual(c('automated-ios').templates, { itemTemplate: 1, itemTemplates: 1, template: 1 });
assert.deepEqual(c('automated-ios').events, { toExport: 75, other: 13 });
assert.deepEqual([c('automated-ios').prefixedAttributes, c('automated-ios').qualifiedFiles, c('automated-ios').dottedAttributes], [2, 2, 1]);
assert.deepEqual(c('toolbox-ios').elements, { core: 863, custom: 0, unknown: 0 });
assert.deepEqual(c('toolbox-android').elements, { core: 853, custom: 0, unknown: 0 });
assert.deepEqual(c('toolbox-ios').bindings, { total: 399, name: 361, path: 4, expression: 34, long: 0, event: 188, value: 2, parent: 0, converter: 0, inTemplate: 27 });
assert.deepEqual(c('toolbox-ios').templates, { itemTemplate: 5, itemTemplates: 3, template: 6 });
assert.deepEqual(c('toolbox-ios').events, { toExport: 66, other: 0 });
assert.equal(c('toolbox-ios').platformBlocks, 7);
assert.deepEqual([c('toolbox-ios').prefixedAttributes, c('toolbox-ios').dottedAttributes], [1, 16]);
assert.deepEqual(c('xml-ts-ios').dynamic, { moduleName: { literal: 2, other: 0 } });
assert.deepEqual(c('automated-ios').dynamic, {
  moduleName: { literal: 22, other: 4 }, bind: { literal: 7, other: 0 }, 'Builder.parse': { literal: 73, other: 15 },
  'Builder.load': { literal: 14, other: 1 }, itemTemplate: { literal: 18, other: 0 }, itemTemplates: { literal: 5, other: 8 },
});
assert.deepEqual(c('toolbox-ios').dynamic, { moduleName: { literal: 3, other: 3 } });

// xml-ts main-page, field by field.
const main = page('xml-ts-ios', 'main-page.xml');
assert.deepEqual({ ...main, root: undefined }, {
  file: 'main-page.xml', module: 'main-page', qualifiers: [], codeBehind: 'main-page.ts', css: null, lines: 14,
  root: undefined, platformBlocks: [], droppedAttributes: [], errors: [],
});
const root = main.root!;
assert.deepEqual([root.tag, root.kind, root.component, root.line, root.column, root.offset, root.exports], ['Page', 'core', { name: 'Page', module: '@nativescript/core/ui' }, 1, 1, 0, 'main-page.ts']);
assert.deepEqual(root.attributes.map((a) => [a.name, a.kind, a.offset]), [['xmlns', 'literal', 6], ['navigatingTo', 'event', 54]]);
assert.deepEqual(root.attributes[1].handler, { name: 'navigatingTo', module: 'main-page.ts', found: true });
assert.deepEqual(root.children.map((e) => e.tag), ['ActionBar', 'StackLayout']);
const stack = root.children[1];
assert.deepEqual(stack.children.map((e) => `${e.tag}@${e.line}:${e.column}`), ['Label@4:5', 'Label@5:5', 'Label@6:5', 'Label@7:5', 'Label@8:5', 'Label@9:5', 'Button@10:5', 'Button@11:5', 'Button@12:5']);
const [message, taps, many, items, inline, , tap, codeBehindTap] = stack.children;
assert.deepEqual(message.attributes[0], {
  name: 'text', target: 'text', kind: 'binding', value: '{{ message }}', offset: 155, key: 'main-page.xml:4:5:text',
  binding: { source: 'message', form: 'name', sourceProperty: 'message', twoWay: true, event: false, usesValue: false, usesParent: false, parents: [], converters: [] },
});
assert.deepEqual(taps.attributes[0].binding, {
  source: "'Taps: ' + counter", form: 'expression', sourceProperty: '$value', expression: "'Taps: ' + counter", twoWay: true, event: false,
  usesValue: false, usesParent: false, parents: [], converters: [],
});
assert.deepEqual(many.attributes.map((a) => [a.name, a.kind, a.binding?.expression]), [
  ['text', 'binding', "counter > 3 ? 'Many taps' : 'Few taps'"], ['class', 'binding', "counter > 3 ? 'line many' : 'line'"],
]);
assert.equal(items.attributes[0].binding?.expression, "items.length + ' items'");
assert.deepEqual(inline.attributes.map((a) => [a.name, a.kind, a.value]), [['text', 'literal', 'Inline style'], ['style', 'literal', 'color: #d32f2f; font-size: 26']]);
assert.deepEqual(tap.attributes[1].binding && [tap.attributes[1].kind, tap.attributes[1].binding.event, tap.attributes[1].binding.sourceProperty], ['binding', true, 'onTap']);
assert.deepEqual(codeBehindTap.attributes[1], { name: 'tap', target: 'tap', kind: 'event', value: 'onCodeBehindTap', offset: 660, key: 'main-page.xml:11:5:tap', handler: { name: 'onCodeBehindTap', module: 'main-page.ts', found: true } });

// xml-ts list-page: a code component, an XML component, a template, `xmlns:` prefixes dropped as the builder drops them.
const list = page('xml-ts-ios', 'list-page.xml');
assert.deepEqual([list.codeBehind, list.css], ['list-page.ts', 'list-page.css']);
assert.deepEqual(list.droppedAttributes.map((d) => d.name), ['xmlns:my', 'xmlns:x']);
const [card, badge, listView] = list.root!.children[1].children;
assert.deepEqual([card.kind, card.component], ['custom-class', { name: 'Card', module: 'components/card', file: 'components/card.ts' }]);
assert.deepEqual([badge.kind, badge.component, badge.exports], ['custom-xml', { name: 'badge', module: 'components/badge', file: 'components/badge.xml', code: null }, 'list-page.ts']);
assert.deepEqual(listView.attributes.map((a) => [a.name, a.kind]), [['items', 'binding'], ['itemTap', 'event'], ['class', 'literal']]);
assert.deepEqual(listView.properties.map((p) => [p.name, p.kind, p.root?.tag, p.root?.inTemplate]), [['itemTemplate', 'template', 'StackLayout', true]]);
assert.deepEqual(listView.properties[0].root!.children.map((e) => e.attributes[0].binding?.source), ['name', "count + ' left'"]);
assert.equal(listView.inTemplate, false);

// toolbox list-page: platform blocks resolved per target, keyed templates.
const blocks = (key: string) => page(key, 'pages/list-page.xml').platformBlocks.map((b) => `${b.platform}:${b.kept}`);
assert.deepEqual(blocks('toolbox-ios'), ['visionos:false', 'ios:true', 'android:false', 'visionos:false', 'ios:true', 'android:false']);
assert.deepEqual(blocks('toolbox-android'), ['visionos:false', 'ios:false', 'android:true', 'visionos:false', 'ios:false', 'android:true']);
const keyed = elements(page('toolbox-ios', 'pages/list-page.xml').root).flatMap((e) => e.properties).find((p) => p.kind === 'templates')!;
assert.ok(keyed.templates!.length > 1 && keyed.templates!.every((t) => t.root && t.root.inTemplate));
const rowLabels = (key: string) => elements(page(key, 'pages/list-page.xml').root).filter((e) => e.attributes.some((a) => a.binding?.source === 'iconText')).length;
assert.ok(rowLabels('toolbox-ios') > 0 && rowLabels('toolbox-ios') === rowLabels('toolbox-android'));

// automated page21: `{{ $value }}` as the whole binding.
const repeater = elements(page('automated-ios', 'ui/page/page21.xml').root).find((e) => e.tag === 'Repeater')!;
assert.deepEqual(repeater.attributes[0].binding, { source: '$value', form: 'name', sourceProperty: '$value', twoWay: true, event: false, usesValue: true, usesParent: false, parents: [], converters: [] });

// Device qualifiers stay run-time alternatives; core's own run-time XML loads are listed.
const resolverTest = plan('automated-ios').modules.find((m) => m.module === 'name-resolvers-tests/files/test')!;
assert.deepEqual(resolverTest.xml, [
  { file: 'name-resolvers-tests/files/test.land.xml', qualifiers: ['land'] },
  { file: 'name-resolvers-tests/files/test.minWH600.xml', qualifiers: ['minWH600'] },
  { file: 'name-resolvers-tests/files/test.xml', qualifiers: [] },
]);
assert.deepEqual(plan('xml-ts-ios').modules.find((m) => m.module === 'list-page'), {
  module: 'list-page', xml: [{ file: 'list-page.xml', qualifiers: [] }], code: [{ file: 'list-page.ts', qualifiers: [] }], css: [{ file: 'list-page.css', qualifiers: [] }],
});
assert.deepEqual(plan('xml-ts-ios').excluded, []);
const sites = plan('xml-ts-ios').coreSites.map((s) => `${s.file} ${s.in} ${s.call} ${s.by}`);
for (const s of [
  'ui/frame/frame-common.ts FrameBase.navigate Builder.createViewFromEntry moduleName',
  'ui/list-view/list-view-common.ts ListViewBase._defaultTemplate Builder.parse text',
  'application/application-common.ts ApplicationCommon.createRootView Builder.createViewFromEntry moduleName',
]) assert.ok(sites.includes(s), s);

const total = ['xml-ts', 'automated', 'toolbox'].reduce((n, a) => n + c(`${a}-ios`).files, 0);
console.log(`xml-plan-check: ${total} XML files planned for iOS and Android; hand-checked pages match`);
