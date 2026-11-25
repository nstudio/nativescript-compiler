// A Symbol held untyped keeps its identity: as a property key it is the symbol (not its description or its string),
// Object.keys and JSON skip it, and two symbols of one description stay apart.
const a: any = Symbol('k');
const b: any = Symbol('k');
const o: any = {};
o[a] = 1;
o[b] = 2;
o.k = 3;
console.log(typeof a, a === b, a === a, o[a], o[b], o.k);
console.log(Object.keys(o).join(','), JSON.stringify(o), Object.getOwnPropertySymbols(o).length);
console.log(a in o, 'Symbol(k)' in o, delete o[a], a in o, o[a]);

const copy: any = { ...o };
console.log(copy[b], Object.getOwnPropertySymbols(copy).length);

const m = new Map<any, string>();
m.set(a, 'first');
m.set(b, 'second');
console.log(m.size, m.get(a), m.get(b));

const maybe: symbol | undefined = Math.random() > 2 ? undefined : Symbol('m');
const p: any = {};
p[maybe as any] = 'held';
console.log(Object.keys(p).length, Object.getOwnPropertySymbols(p).length, String(Object.getOwnPropertySymbols(p)[0]));

const keys: any[] = [Symbol('x'), 'x'];
const q: any = {};
for (const k of keys) q[k] = typeof k;
console.log(Object.keys(q).join(','), q.x, q[keys[0]]);

// Number() of a value held untyped: a BigInt is its number, an object its valueOf, and what the conversion throws is thrown.
function number(name: string, run: () => number) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, (e as Error).constructor.name, (e as Error).message);
  }
}
const big: any = 5n;
const valued: any = { valueOf: () => 7 };
const poisoned: any = { valueOf() { throw new RangeError('valueOf'); } };
const text: any = ' 12 ';
number('symbol', () => Number(a));
number('bigint', () => Number(big));
number('valueOf', () => Number(valued));
number('poisoned', () => Number(poisoned));
number('text', () => Number(text));
number('missing', () => Number(undefined as any));
