// @plugin-both
// A plugin subclass reads its base's `T`-typed members at the type it substitutes for `T`.
import { ListStore, Named } from './helpers/plugin/generic-source.ts';

const s = new ListStore<number>();
console.log(s.push(3), s.push(4), s.last(), s.joined(), s.value.length, s.current[0] + 1);
const n = new Named<number>('x', 5);
console.log(n.label(), n.first.length, n.second * 2);
