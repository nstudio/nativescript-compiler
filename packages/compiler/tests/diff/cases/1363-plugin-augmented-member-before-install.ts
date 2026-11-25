// @plugin-both
// Members an augmentation declares exist only once the plugin's code installs them: before, a read is undefined and a
// call a TypeError; after, every instance has them, a data member as well as a method.
import { Hub } from './helpers/plugin/hub-core.ts';
import { installCount } from './helpers/plugin/hub-store.ts';

const h = new Hub('h');
console.log(typeof h.count, typeof h.version, h.count?.());
try {
  h.count();
} catch (e) {
  console.log(e instanceof TypeError);
}
installCount();
console.log(typeof h.count, h.count(), new Hub('n').count(), h.version + 1);
