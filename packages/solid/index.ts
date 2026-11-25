import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoreApi, FrameworkAdapter } from '@nstudio/nativescript-compiler/adapter-api';
import { useCore, ts } from './core-api.ts';
import { solidComponent, solidRoutes, solidStore } from './solid.ts';

export default function adapter(core: CoreApi): FrameworkAdapter {
  useCore(core);
  return {
    apiVersion: 1,
    name: 'solid',
    packages: ['@nativescript-community/solid-js', 'solid-js'],
    behaviour: { schedule: 'microtask', eventScope: 'none', propsOrder: 'pre', deferBindings: true, insertion: 'built', listenersAfterBindings: false, effectScope: 'depth', checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false, kit: { scope: { template: 'EffectOrder.depth', region: 'EffectOrder.deeper' } } },
    reach: 'project',
    frontEnd(app) {
      const tsx = app.files.filter((f) => f.endsWith('.tsx'));
      const texts = new Map([...app.sources, ...tsx].map((f) => [f, readFileSync(f, 'utf8')]));
      const routerFile = tsx.find((f) => /<StackRouter\b/.test(texts.get(f)!));
      const { routes, initial } = routerFile ? solidRoutes(texts.get(routerFile)!) : { routes: [], initial: '' };
      const fns: { file: string; fn: ts.FunctionDeclaration }[] = [];
      for (const f of tsx) {
        if (f === routerFile) continue;
        const sf = ts.createSourceFile(f, texts.get(f)!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name && /^[A-Z]/.test(st.name.text)) fns.push({ file: f, fn: st });
      }
      const names = new Set(fns.map(({ fn }) => fn.name!.text));
      const components = fns.map(({ file, fn }) => solidComponent(file, fn, routes, names));
      const overrides = new Map<string, string>();
      for (const f of app.sources) { const store = solidStore(texts.get(f)!); if (store) overrides.set(f, store); }
      const start = routes.find((r) => r.name === initial)!;
      components.push({ name: 'StackRouter', file: join(dirname(routerFile!), 'StackRouter.solid.ts'), source: `import ${start.component} from './components/${start.component}.solid';\nexport default class StackRouter {}\n`, props: [], template: [{ kind: 'element', tag: 'Frame', attrs: [], events: [], children: [{ kind: 'component', name: start.component, props: [], events: [] }] }] });
      return { components, modules: app.sources, overrides, root: 'StackRouter' };
    },
  };
}
