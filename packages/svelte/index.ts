import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppSources, CoreApi, FrameworkAdapter, FrontEndResult, TemplateBehaviour } from '@nstudio/nativescript-compiler/adapter-api';
import { useCore } from './core-api.ts';
import { kotlinHooks, swiftHooks } from './hooks.ts';
import { modules } from './modules.ts';
import { svelteComponent } from './svelte.ts';
import { svelte5Component, svelteModule } from './svelte5.ts';

/**
 * Svelte 4 sets an element's props after its children's, and mounts a block's views top-down once they are all made;
 * Svelte 5 sets a template's static attributes as it makes its views and the rest in one effect after its blocks and
 * components, adds its listeners after that, and updates in effect-tree order: creation order, nested.
 */
const SVELTE4: TemplateBehaviour = { schedule: 'microtask', eventScope: 'none', propsOrder: 'post', deferBindings: false, insertion: 'mounted', listenersAfterBindings: false, effectScope: 'component', checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false, kit: { scope: { template: 'EffectOrder.component' } } };
const SVELTE5: TemplateBehaviour = { schedule: 'microtask', eventScope: 'none', propsOrder: 'pre', deferBindings: true, insertion: 'built', listenersAfterBindings: true, effectScope: null, checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false };

export default function adapter(core: CoreApi): FrameworkAdapter {
  useCore(core);
  return {
    apiVersion: 1,
    name: 'svelte',
    packages: ['@nativescript-community/svelte-native', 'svelte'],
    behaviour: SVELTE4,
    reach: 'project',
    swift: swiftHooks,
    kotlin: kotlinHooks,
    modules,
    frontEnd: async (app) => (Number(JSON.parse(readFileSync(join(app.nodeModules, 'svelte', 'package.json'), 'utf8')).version.split('.')[0]) >= 5 ? svelte5(app) : svelte4(app)),
  };
}

/** Svelte 5: parsed by the app's own compiler; `.svelte.ts` modules' runes as Svelte compiles them. */
async function svelte5(app: AppSources): Promise<FrontEndResult> {
  const { parse, compile } = createRequire(join(app.root, 'package.json'))('svelte/compiler');
  const styled = (await svelteCss(app.root, 'external')) === 'injected';
  const components = app.files.filter((f) => f.endsWith('.svelte')).map((f) => svelte5Component(f, readFileSync(f, 'utf8'), parse, app.platform, styled ? compile : undefined));
  const overrides = new Map<string, string>();
  for (const f of app.sources) {
    const module = f.endsWith('.svelte.ts') ? svelteModule(f, readFileSync(f, 'utf8')) : null;
    if (module) overrides.set(f, module);
  }
  return { components, modules: app.sources, overrides, root: rootComponent(app), behaviour: SVELTE5 };
}

async function svelte4(app: AppSources): Promise<FrontEndResult> {
  const isStoreFile = (f: string) => /from\s+['"]svelte\/store['"]/.test(readFileSync(f, 'utf8'));
  const styled = (await svelteCss(app.root, 'injected')) === 'injected';
  const components = app.files.filter((f) => f.endsWith('.svelte')).map((f) => svelteComponent(f, readFileSync(f, 'utf8'), (spec) => {
    const target = resolve(dirname(f), spec);
    return [target + '.ts', target + '/index.ts'].some((t) => existsSync(t) && isStoreFile(t));
  }, styled ? createRequire(join(app.root, 'package.json'))('svelte/compiler').compile : undefined));
  return { components, modules: app.sources, root: rootComponent(app) };
}

/** The component the entry starts the app with: `svelteNative(App)`. */
function rootComponent(app: AppSources): string {
  const rootImport = /svelteNative(?:NoFrame)?\(\s*(\w+)/.exec(app.entryText)?.[1];
  const rootFile = rootImport && new RegExp(`import\\s+${rootImport}\\s+from\\s+['"]([^'"]+)['"]`).exec(app.entryText)?.[1];
  if (!rootFile) throw new Error(`${app.entry}: no svelteNative(Component)`);
  return basename(rootFile, '.svelte');
}

/**
 * Where the app's Svelte puts a component's `<style>` (`compilerOptions.css` of svelte.config.js, else the version's
 * default): `injected` styles svelte-native adds when the component mounts; `external` ones svelte-loader drops unless
 * the app emits them itself, as NativeScript's webpack configuration does not.
 */
async function svelteCss(app: string, fallback: 'injected' | 'external'): Promise<string> {
  const file = ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.cjs'].map((f) => join(app, f)).find((f) => existsSync(f));
  if (!file) return fallback;
  const config = await import(pathToFileURL(file).href);
  const css = (config.default ?? config)?.compilerOptions?.css;
  return css === true ? 'injected' : css === false ? 'external' : typeof css === 'string' ? css : fallback;
}
