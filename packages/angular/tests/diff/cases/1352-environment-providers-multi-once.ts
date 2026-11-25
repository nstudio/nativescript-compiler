// Providers made by makeEnvironmentProviders are registered by the injector given them, once: a multi
// provider among them gives one value, beside the injector's own.
import '@angular/compiler';
import { InjectionToken, Injector, makeEnvironmentProviders } from '@angular/core';

const PLUGINS = new InjectionToken<string[]>('plugins');
const provided = makeEnvironmentProviders([{ provide: PLUGINS, useValue: 'auth', multi: true }]);
const injector = Injector.create({ providers: [provided as any, { provide: PLUGINS, useValue: 'cache', multi: true }] });
const plugins = injector.get(PLUGINS);
console.log(plugins.length, plugins.join(','));
// Providers never given to an injector are in none.
makeEnvironmentProviders([{ provide: PLUGINS, useValue: 'unused', multi: true }]);
const other = Injector.create({ providers: [] });
console.log(other.get(PLUGINS, null));
