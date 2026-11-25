// @plugin-both
// A plugin installs methods its `declare module` augmentation declares on another module's class by assigning them to
// the class's prototype: every instance has them, made before or after, a subclass's too, each called with `this` the
// object it is called on.
import { Hub, hub } from './helpers/plugin/hub-core.ts';
import './helpers/plugin/hub-store.ts';

class Branch extends Hub {
  constructor() {
    super('branch');
  }
}

const early = hub();
const late = new Hub('late');
console.log(early.store(), late.store('box'), new Branch().store(), new Branch().twice(4));
const asBase: Hub = new Branch();
console.log(asBase.store('p'), [1, 2, 3].map((n) => late.twice(n)).join(','));
console.log(typeof late.store, typeof new Branch().twice);
