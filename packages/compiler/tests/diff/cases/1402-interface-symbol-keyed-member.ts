// An interface with a member keyed by a module's own symbol, its objects made as literals and read, written and
// enumerated by that key, as a reactive library tags its nodes.
const NODE = Symbol('NODE');

interface Tagged {
  [NODE]: string;
  version: number;
  label?: string;
}

interface Counted extends Tagged {
  count: number;
}

function make(v: number): Tagged {
  return { [NODE]: 'node', version: v };
}

const t = make(3);
console.log(t[NODE], t.version, t.label);
t[NODE] = 'changed';
t.label = 'x';
console.log(t[NODE], Object.keys(t).join(','), JSON.stringify(t));
console.log(NODE in t, Object.getOwnPropertySymbols(t).length);

const c: Counted = { version: 1, [NODE]: 'counted', count: 2 };
c.count++;
console.log(c[NODE], c.count, Object.keys(c).join(','));
const all: Tagged[] = [t, c];
console.log(all.map((x) => `${x[NODE]}:${x.version}`).join(' '));
