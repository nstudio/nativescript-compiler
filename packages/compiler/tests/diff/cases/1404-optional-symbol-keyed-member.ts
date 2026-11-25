// An optional member keyed by a module's own symbol: absent until set, then present for `in` and among the
// object's symbols, never among its string keys.
const CACHE = Symbol('cache');

interface Node {
  id: number;
  [CACHE]?: string;
}

const nodes: Node[] = [{ id: 1 }, { id: 2, [CACHE]: 'warm' }];
for (const n of nodes) console.log(n.id, n[CACHE], CACHE in n, Object.getOwnPropertySymbols(n).length);
nodes[0][CACHE] = 'filled';
console.log(nodes[0][CACHE], CACHE in nodes[0], Object.keys(nodes[0]).join(','), JSON.stringify(nodes[0]));
const read = (n: Node) => n[CACHE] ?? 'cold';
console.log(nodes.map(read).join(','));
