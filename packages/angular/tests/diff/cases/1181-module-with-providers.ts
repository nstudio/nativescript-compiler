// A module's `forRoot()` typed as Angular's ModuleWithProviders, its fields read back by the code that made it.
import '@angular/compiler';
import { InjectionToken, ModuleWithProviders, NgModule } from '@angular/core';

const LABEL = new InjectionToken<string>('LABEL');

@NgModule({})
class FeatureModule {
  static forRoot(label: string): ModuleWithProviders<FeatureModule> {
    return { ngModule: FeatureModule, providers: [{ provide: LABEL, useValue: label }] };
  }
}

function providersOf(m: ModuleWithProviders<unknown>): number {
  return m.providers?.length ?? 0;
}

const root = FeatureModule.forRoot('main');
console.log(root.ngModule === FeatureModule, providersOf(root), (root.providers?.[0] as { useValue: string }).useValue);
