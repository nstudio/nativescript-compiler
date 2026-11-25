import { readFileSync } from 'node:fs';
import type { CoreApi, FrameworkAdapter, TemplateBehaviour } from '@nstudio/nativescript-compiler/adapter-api';
import { useCore } from './core-api.ts';
import { kotlinHooks, swiftHooks } from './hooks.ts';
import { octaneApp } from './octane.ts';
import { PACKAGE } from './package.ts';

const behaviour: TemplateBehaviour = { schedule: 'event', eventScope: 'event', propsOrder: 'pre', deferBindings: false, insertion: 'built', listenersAfterBindings: false, effectScope: null, checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false, kit: { attributeValue: 'octaneValue', className: 'octaneClassName', rowItems: 'octaneItems' } };

export default function adapter(core: CoreApi): FrameworkAdapter {
  useCore(core);
  return {
    apiVersion: 1,
    name: 'octane',
    packages: ['@nativescript-community/octane', '@nativescript/octane', 'octane', '@nativescript-community/vite-octane'],
    behaviour,
    reach: 'project',
    swift: swiftHooks,
    kotlin: kotlinHooks,
    package: PACKAGE,
    frontEnd(app) {
      const tsx = app.files.filter((f) => f.endsWith('.tsx'));
      const octane = octaneApp(app.entry, new Map([app.entry, ...app.sources, ...tsx].map((f) => [f, readFileSync(f, 'utf8')])), app.platform);
      const mounted = !!octane.mounted;
      return {
        components: octane.components,
        overrides: new Map(octane.overrides),
        mounted,
        modules: mounted ? [...app.sources, ...tsx, app.entry] : app.sources.filter((f) => !octane.glue.has(f)),
        root: octane.root,
        // An app mounting its own roots renders as Octane's NativeScript driver does.
        behaviour: mounted ? { ...behaviour, slots: true, rowSignals: 'value' } : behaviour,
      };
    },
  };
}
