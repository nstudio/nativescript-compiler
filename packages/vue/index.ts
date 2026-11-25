import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CoreApi, FrameworkAdapter } from '@nstudio/nativescript-compiler/adapter-api';
import { useCore } from './core-api.ts';
import { kotlinHooks, swiftHooks } from './hooks.ts';
import { modules } from './modules.ts';
import { vueComponent } from './vue.ts';

export default function adapter(core: CoreApi): FrameworkAdapter {
  useCore(core);
  return {
    apiVersion: 1,
    name: 'vue',
    packages: ['nativescript-vue', 'vue'],
    behaviour: { schedule: 'microtask', eventScope: 'none', propsOrder: 'post', deferBindings: false, insertion: 'built', listenersAfterBindings: false, effectScope: 'component', checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false, kit: { scope: { template: 'EffectOrder.component' } } },
    reach: 'project',
    swift: swiftHooks,
    kotlin: kotlinHooks,
    modules,
    frontEnd(app) {
      const components = app.files.filter((f) => f.endsWith('.vue')).map((f) => vueComponent(f, readFileSync(f, 'utf8')));
      const rootImport = /createApp\(\s*(\w+)\s*\)/.exec(app.entryText)?.[1];
      const rootFile = rootImport && new RegExp(`import\\s+${rootImport}\\s+from\\s+['"]([^'"]+)['"]`).exec(app.entryText)?.[1];
      if (!rootFile) throw new Error(`${app.entry}: no createApp(Component)`);
      return { components, modules: app.sources, root: basename(rootFile, '.vue') };
    },
  };
}
