// A view of an array is the array as a Map, Set and WeakMap key, by Object.is, and for named properties.
class Base {
  constructor(public n: number) {}
}
class Leaf extends Base {}
const leaves: Leaf[] = [new Leaf(1)];
const bases: Base[] = leaves;
const grid: number[][] = [[1]];
const lg: any[][] = grid;
const m = new Map<object, string>([[leaves, 'leaves'], [grid, 'grid']]);
const s = new Set<object>([bases, lg]);
const w = new WeakMap<object, number>([[bases, 1]]);
console.log(m.get(bases), m.get(lg), s.size, s.has(leaves), s.has(grid), w.get(leaves), Object.is(bases, leaves), Object.is(lg, grid));
(bases as any).tag = 'b';
(lg as any).tag = 'g';
console.log((leaves as any).tag, (grid as any).tag, Array.isArray(bases), Array.isArray(lg));
