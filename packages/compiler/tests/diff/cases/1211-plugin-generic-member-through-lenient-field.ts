// @plugin-both
// A plugin's generic class member, read through a field of the plugin's own class that its constructor sets (held
// optional in lenient code), into a typed local whose elements are then read by member.
import { FieldReader, HeavyBag, HeavyHolder, HeavyItem } from './helpers/plugin/holder.ts';

const holder = new HeavyHolder();
holder.bag = new HeavyBag([new HeavyItem('a', 1), new HeavyItem('b', 5)]);
console.log(new FieldReader(holder).count());
