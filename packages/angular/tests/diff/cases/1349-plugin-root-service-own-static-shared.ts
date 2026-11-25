// @plugin-both
// A plugin's providedIn-root service with its own static `shared`: it is its member, apart from
// the instance the injector makes.
import '@angular/compiler';
import { Injector, inject, runInInjectionContext } from '@angular/core';
import { Settings } from './helpers/plugin/root-services.ts';

const injector = Injector.create({ providers: [{ provide: Settings, useClass: Settings }] });
runInInjectionContext(injector, () => {
  const s = inject(Settings);
  s.theme = 'dark';
  console.log(s === Settings.shared, inject(Settings) === s, s.theme, Settings.shared.theme);
  Settings.shared = new Settings();
  console.log(Settings.shared.theme, inject(Settings).theme);
});
