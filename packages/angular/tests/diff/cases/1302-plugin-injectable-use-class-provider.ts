// @plugin-both
// A plugin's @Injectable class with a base works as a `useClass` provider, as its own token and under another.
import '@angular/compiler';
import { Injector, InjectionToken, inject, runInInjectionContext } from '@angular/core';
import { Counter, Source } from './helpers/plugin/generic-source.ts';

const TOKEN = new InjectionToken<Counter<string>>('counter');
const injector = Injector.create({
  providers: [
    { provide: Counter, useClass: Counter },
    { provide: TOKEN, useClass: Counter },
  ],
});
runInInjectionContext(injector, () => {
  const c = inject(Counter<string>);
  console.log(c.count('a'), c.count('b'), inject(Counter) === c, c instanceof Source);
  const t = inject(TOKEN);
  console.log(t.count('z'), t === c, t instanceof Counter);
});

const child = Injector.create({ providers: [Counter], parent: injector });
runInInjectionContext(child, () => {
  const k = inject(Counter<number>);
  console.log(k.count(1), k instanceof Source, k === child.get(Counter));
});
