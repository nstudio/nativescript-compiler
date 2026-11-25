import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoreApi, FrameworkAdapter } from '@nstudio/nativescript-compiler/adapter-api';
import { useCore, ts } from './core-api.ts';
import { reactComponent, reactScreens, zustandStore } from './react.ts';

export default function adapter(core: CoreApi): FrameworkAdapter {
  useCore(core);
  return {
    apiVersion: 1,
    name: 'react',
    packages: ['react-nativescript', 'react'],
    behaviour: {
      schedule: 'now', eventScope: 'event', propsOrder: 'post', deferBindings: false, insertion: 'built', listenersAfterBindings: false, effectScope: null, checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false,
      // The flexbox react-nativescript-navigation's FrameNavigatorView renders a screen into.
      pageContentAttrs: { flexGrow: '1', flexDirection: 'column', width: '100%', height: '100%' },
    },
    reach: 'project',
    frontEnd(app) {
      const tsx = app.files.filter((f) => f.endsWith('.tsx'));
      const texts = new Map([...app.sources, ...tsx].map((f) => [f, readFileSync(f, 'utf8')]));
      const navigatorFile = tsx.find((f) => /\.Navigator\b/.test(texts.get(f)!));
      const { screens, initial, container } = navigatorFile ? reactScreens(texts.get(navigatorFile)!) : { screens: [], initial: '', container: null };
      const fns: { file: string; fn: ts.FunctionDeclaration }[] = [];
      for (const f of tsx) {
        if (f === navigatorFile) continue;
        const sf = ts.createSourceFile(f, texts.get(f)!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name && /^[A-Z]/.test(st.name.text)) fns.push({ file: f, fn: st });
      }
      const names = new Map(fns.map(({ file, fn }) => [fn.name!.text, file]));
      const components = fns.map(({ file, fn }) => reactComponent(file, texts.get(file)!, fn, screens, texts, names));
      const overrides = new Map<string, string>();
      for (const f of app.sources) { const store = zustandStore(texts.get(f)!); if (store) overrides.set(f, store); }
      // The navigator is the app's frame, starting at the initial screen.
      const start = screens.find((s) => s.name === initial)!;
      const frameName = container ?? 'Navigator';
      components.push({ name: frameName, file: join(dirname(navigatorFile!), frameName + '.react.ts'), source: `import ${start.component} from './${start.component}.react';\nexport default class ${frameName} {}\n`, props: [], template: [{ kind: 'element', tag: 'Frame', attrs: [], events: [], children: [{ kind: 'component', name: start.component, props: [], events: [] }] }] });
      return { components, modules: app.sources, overrides, root: frameName };
    },
  };
}
