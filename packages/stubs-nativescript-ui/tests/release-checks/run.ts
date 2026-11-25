#!/usr/bin/env node
// The nativescript-ui-* stand-ins' release checks: the compiler finds them through this package (nativescript.compilerStubs),
// refuses a binary-only plugin an app neither stubs nor replaces, and types an app's imports against the stand-ins. They
// run on the compiler's harness with this suite (suite.json), the compiler a checkout linked into the workspace:
//   npm run test:release-checks
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProgram } from '@nstudio/nativescript-compiler/src/program/program.ts';
import { stubbedPlugins } from '@nstudio/nativescript-compiler/src/targets/resources.ts';
import { pluginStubs } from '@nstudio/nativescript-compiler/src/plugins/bindings.ts';
import { BuildContext } from '@nstudio/nativescript-compiler/src/program/build-context.ts';
import { check, finish } from '@nstudio/nativescript-compiler/tests/release-checks/checks.ts';
import { modulesDir } from '@nstudio/nativescript-compiler/tests/native-build.ts';

// ---- Binary-only plugins: refused unless stubbed ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-stubs-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    w('package.json', JSON.stringify({ name: 'stubs', main: 'src/main.ts', dependencies: { 'nativescript-ui-listview': '15.2.3' } }));
    const available = pluginStubs(dir);
    check(available.get('nativescript-ui-listview')?.endsWith('/stubs-nativescript-ui/runtime/binary-plugin-stubs.ts') === true, 'the stand-ins are found through this package');
    const refused = stubbedPlugins(dir, 'ios', available);
    check(refused.stubbed.length === 0 && refused.errors.length === 1 && refused.errors[0].startsWith('nativescript-ui-listview is a binary-only plugin') && refused.errors[0].includes("release.pluginReplacements: { 'nativescript-ui-listview'") && refused.errors[0].includes("release.stubPlugins: ['nativescript-ui-listview']"), 'a binary-only plugin stops the build, naming both remedies');
    w('nativescript.config.ts', "export default { id: 'org.stubs', release: { pluginReplacements: { 'nativescript-ui-listview': './src/list.ts' } } };\n");
    const replaced = stubbedPlugins(dir, 'ios', available);
    check(!replaced.errors.length && !replaced.stubbed.length, 'a binary-only plugin the app replaces builds');
    w('nativescript.config.ts', "export default { id: 'org.stubs', release: { stubPlugins: ['nativescript-ui-listview'] } };\n");
    const stubbed = stubbedPlugins(dir, 'ios', available);
    check(!stubbed.errors.length && stubbed.stubbed.join() === 'nativescript-ui-listview', 'release.stubPlugins builds a binary-only plugin as its stand-in');
    w('nativescript.config.ts', "export default { id: 'org.stubs', release: { stubPlugins: ['nativescript-ui-listview', 'some-plugin'] } };\n");
    let unknown = '';
    try { stubbedPlugins(dir, 'ios', available); } catch (e) { unknown = String(e); }
    check(unknown.includes('some-plugin has no stand-in'), 'release.stubPlugins refuses a package it has no stand-in for');

    const build = new BuildContext();
    build.stubPlugin('nativescript-ui-listview', available.get('nativescript-ui-listview')!);
    const user = w('src/list-user.ts', "import { RadListView, ListViewEventData } from 'nativescript-ui-listview';\nexport const list = new RadListView();\nexport function onTap(e: ListViewEventData): number { list.refresh(); return e.index; }\n");
    let typed = '';
    try { createProgram([user], new Map(), 'ios', modulesDir, undefined, [], {}, {}, undefined, undefined, build); } catch (e) { typed = String(e); }
    check(!typed, `a stubbed plugin's imports type-check against its stand-ins${typed ? `: ${typed.slice(0, 600)}` : ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

finish();
