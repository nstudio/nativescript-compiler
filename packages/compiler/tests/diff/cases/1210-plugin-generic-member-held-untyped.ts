// @plugin-both
// A plugin reads its own generic class's members, which the class's type parameters type, into typed slots: a local, an
// argument, an array of the parameter's elements. The checker gives them the instantiation's types.
import { HeavyBag, HeavyHolder, HeavyItem, Reader } from './helpers/plugin/holder.ts';

const holder = new HeavyHolder();
holder.bag = new HeavyBag([new HeavyItem('a', 1), new HeavyItem('b', 5), new HeavyItem('c', 3)]);
const reader = new Reader(holder);
console.log(reader.total());
console.log(reader.heaviest().name);
console.log(reader.firstName());
