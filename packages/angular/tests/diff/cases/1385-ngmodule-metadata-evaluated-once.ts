// @experimental-decorators
// An NgModule's metadata is evaluated once, as its decorator is: a forRoot() in its imports runs once, and what its providers give by value is the same object in every injector made from it, while each injector makes the modules again.
import '@angular/compiler';
import { Injectable, InjectionToken, Injector, ModuleWithProviders, NgModule, importProvidersFrom, inject } from '@angular/core';

const log: string[] = [];
class Config {
  constructor(readonly name: string) {}
}
const CONFIG = new InjectionToken<Config>('CONFIG');
class Counts {
  hits = 0;
}
const COUNTS = new InjectionToken<Counts>('COUNTS');

@Injectable()
class Settings {
  readonly config = inject(CONFIG);
}

@NgModule({})
class FeatureModule {
  constructor() { log.push('feature ' + inject(Settings).config.name); }
  static forRoot(name: string): ModuleWithProviders<FeatureModule> {
    log.push('forRoot ' + name);
    return { ngModule: FeatureModule, providers: [{ provide: CONFIG, useValue: new Config(name) }, Settings] };
  }
}

@NgModule({ imports: [FeatureModule.forRoot('app')], providers: [{ provide: COUNTS, useValue: new Counts() }] })
class AppModule {
  constructor() { inject(COUNTS).hits++; log.push('app'); }
}

const a = Injector.create({ providers: [importProvidersFrom(AppModule) as any] });
const b = Injector.create({ providers: [importProvidersFrom(AppModule) as any] });
console.log(log.join(', '));
console.log(a.get(COUNTS) === b.get(COUNTS), a.get(COUNTS).hits, a.get(CONFIG) === b.get(CONFIG), a.get(AppModule) !== b.get(AppModule), a.get(Settings) !== b.get(Settings));
