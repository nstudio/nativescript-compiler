// @plugin-both
// A plugin's @Injectable class extending another class keeps its base's constructor and members, and an app's @Injectable
// class extending a plugin's @Injectable class inherits its members, whether made with `new` or by the injector.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';
import { ComponentStore, Source, Store } from './helpers/plugin/injectable-store.ts';

const s = new Store<number>();
console.log(s.push(3), s.push(4), s.add(5), s.pushes, s.describe(), s.items.join('+'), s.name, s instanceof Source);

@Injectable()
class Cart extends ComponentStore<string> {
  add(item: string) {
    this.patch(`${this.state ?? ''}${item};`);
  }
}

const c = new Cart();
c.add('apple');
c.add('pear');
console.log(c.state, c instanceof ComponentStore);

const injector = Injector.create({ providers: [{ provide: Cart, useClass: Cart }] });
runInInjectionContext(injector, () => {
  const cart = inject(Cart);
  cart.add('fig');
  console.log(cart.state, inject(Cart) === cart, cart === c, cart instanceof ComponentStore);
});
