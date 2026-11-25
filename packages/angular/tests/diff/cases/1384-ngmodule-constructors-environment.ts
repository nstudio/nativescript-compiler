// @experimental-decorators
// NgModules given to an injector through importProvidersFrom are constructed when the injector is made: imports first, depth first, each once, with their constructors' parameters injected.
import '@angular/compiler';
import { Inject, Injectable, InjectionToken, Injector, NgModule, importProvidersFrom, inject } from '@angular/core';

const log: string[] = [];
const LABEL = new InjectionToken<string>('LABEL');

@Injectable()
class Loader {
  constructor() { log.push('loader'); }
}

@NgModule({})
class SharedModule {
  constructor() { log.push('shared'); }
}

@NgModule({ imports: [SharedModule] })
class InnerModule {
  constructor(@Inject(Loader) loader: Loader) { log.push('inner ' + (loader instanceof Loader)); }
}

@NgModule({ imports: [InnerModule, SharedModule], providers: [Loader, { provide: LABEL, useValue: 'outer' }] })
class OuterModule {
  constructor() { log.push('outer ' + inject(LABEL)); }
}

const providers = importProvidersFrom(OuterModule, SharedModule);
log.push('imported');
const env = Injector.create({ providers: [providers as any] });
log.push('made env');
console.log(log.join(', '));
console.log(env.get(OuterModule) === env.get(OuterModule), env.get(InnerModule) instanceof InnerModule, log.length);
