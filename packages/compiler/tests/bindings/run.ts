#!/usr/bin/env node
// The binding API's contract (binding-api.ts), checked with packages that exist only here, written to a scratch folder:
// how the compiler finds a binding or stubs package, applies a binding only to an app depending on the plugin it binds,
// refuses one it cannot use, and stops on a plugin binding the engine that no binding stands in for.
//   node tests/bindings/run.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS_OVERRIDE } from '../../src/adapters/load.ts';
import { appBindings, pluginStubs, unboundEnginePlugins } from '../../src/plugins/bindings.ts';
import { check, finish } from '../release-checks/checks.ts';

const work = mkdtempSync(join(tmpdir(), 'ns-binding-api-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const message = (f: () => unknown) => { try { f(); return ''; } catch (e) { return (e as Error).message; } };
const write = (file: string, text: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const json = (file: string, value: unknown) => write(file, JSON.stringify(value));

const binding = (version = 1) => ({
  name: 'fake-engine-binding',
  version: '1.0.0',
  nativescript: {
    compilerBinding: {
      apiVersion: version,
      package: 'fake-engine-plugin',
      versions: '^2.0.0',
      ios: { sources: 'ios', installer: 'NSBinding_fake_engine_plugin', conditions: 'ios.conditions.json' },
      android: { script: 'android/plugin.ts', kotlin: 'android/kotlin', jni: 'android/jni', installer: 'org.example.NSBinding_fake_engine_plugin', stubs: ['fakev8'], links: [{ lib: 'fake', define: 'FAKE_LIBS' }] },
    },
  },
});
const stubs = { name: 'fake-stubs', version: '1.0.0', nativescript: { compilerStubs: { apiVersion: 1, module: 'stubs.ts', packages: ['fake-binary-plugin'] } } };

/** An app depending on `deps`, each installed with a package.json of `manifests` (a NativeScript plugin by default). */
function app(name: string, deps: Record<string, string>, manifests: Record<string, object> = {}): string {
  const dir = join(work, name);
  json(join(dir, 'package.json'), { name, dependencies: deps });
  for (const [dep, version] of Object.entries(deps)) json(join(dir, 'node_modules', dep, 'package.json'), manifests[dep] ?? { name: dep, version, nativescript: {} });
  return dir;
}
/** A plugin whose iOS code is written against V8's headers. */
const engineBound = (dir: string) => write(join(dir, 'node_modules', 'fake-engine-plugin', 'platforms', 'ios', 'src', 'Module.mm'), '#include "v8.h"\nvoid install(v8::Isolate *isolate) {}\n');

// ---- Discovery ----
const adapters = join(work, 'adapters');
json(join(adapters, 'fake-engine-binding', 'package.json'), binding());
json(join(adapters, 'fake-stubs', 'package.json'), stubs);
json(join(adapters, 'not-a-binding', 'package.json'), { name: 'not-a-binding', version: '1.0.0' });
process.env[ADAPTERS_OVERRIDE] = adapters;
const using = app('using', { 'fake-engine-plugin': '2.1.0' });
const [found] = appBindings(using, 'android');
check(found?.name === 'fake-engine-binding' && found.root === join(adapters, 'fake-engine-binding') && found.package === 'fake-engine-plugin', `a binding in a folder $${ADAPTERS_OVERRIDE} names is found, its package.json read`);
check(found?.ios?.dir === join(found.root, 'ios') && found.ios.conditions === join(found.root, 'ios.conditions.json') && found.android?.script === join(found.root, 'android/plugin.ts') && found.android.package === 'fake-engine-plugin',
  "a binding's paths are its package's, absolute");
check(appBindings(app('other', { 'some-plugin': '1.0.0' }), 'ios').length === 0, 'a binding applies only to an app that depends on the plugin it binds');
check(message(() => appBindings(app('older', { 'fake-engine-plugin': '1.4.0' }), 'ios')).includes('binds fake-engine-plugin ^2.0.0, and the app has fake-engine-plugin 1.4.0'), 'a binding of other versions of the plugin than the app has is refused');
check(pluginStubs(using).get('fake-binary-plugin') === join(adapters, 'fake-stubs', 'stubs.ts'), "a stubs package's stand-ins are found, each with its module");
delete process.env[ADAPTERS_OVERRIDE];

const installed = app('installed', { 'fake-engine-plugin': '2.0.0', 'fake-engine-binding': '1.0.0' }, { 'fake-engine-binding': binding() });
check(appBindings(installed, 'ios')[0]?.root === join(installed, 'node_modules', 'fake-engine-binding'), "a binding installed among the app's dependencies is found");
check(message(() => appBindings(app('api', { 'fake-engine-plugin': '2.0.0', 'fake-engine-binding': '1.0.0' }, { 'fake-engine-binding': binding(2) }), 'ios')).includes('is written for compiler binding API 2, and this @nstudio/nativescript-compiler reads API 1'),
  'a binding written for another binding API is refused');

// ---- A plugin binding the engine ----
const unbound = app('unbound', { 'fake-engine-plugin': '2.0.0' });
engineBound(unbound);
const errors = unboundEnginePlugins(unbound, 'android', appBindings(unbound, 'android'));
check(errors.length === 1 && errors[0].startsWith('fake-engine-plugin installs objects into the JavaScript engine') && errors[0].includes('a binding of fake-engine-plugin for android, a package whose package.json declares nativescript.compilerBinding'),
  'a plugin binding the engine with no binding stops the build, naming the plugin and what it needs');
engineBound(installed);
check(unboundEnginePlugins(installed, 'ios', appBindings(installed, 'ios')).length === 0, 'a plugin binding the engine builds over its binding');

finish('binding API checks');
