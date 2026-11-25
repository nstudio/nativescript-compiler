// @plugin-both
// A typed array given to a plugin's generic function taking `T[]` is the same array: the function's `splice`/`push` land on the caller's.
import { Chain, Link, arrAdd, arrRemove } from './helpers/plugin/teardowns.ts';

const s = new Link('s');
const p1 = new Link('p1'), p2 = new Link('p2'), p3 = new Link('p3');
s.addParent(p1);
s.addParent(p2);
s.addParent(p3);
const before = s.held();
s.removeParent(p2);
console.log(s.parents(), before === s.held());
const f = () => {};
s.add(p1);
s.add(f);
s.remove(p1);
console.log(s.count());

const chain = new Chain();
chain.links.push(p1, p2, p3);
const links = chain.links;
chain.drop(p1);
console.log(links === chain.links, chain.links.length, chain.links.map((l) => l.name).join(','));

const mine: Link[] = [p1];
arrRemove(mine, p1);
const grown = arrAdd(mine, p3);
console.log(grown === mine, mine.length, mine[0] === p3);
const names: string[] = ['a', 'b'];
arrRemove(names, 'a');
console.log(arrAdd(names, 'c') === names, names.join(','));
