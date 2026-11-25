// Object literals of no declared type with a member keyed by a module's own symbol: read, written, tested and
// enumerated by that key, the symbol never among the string keys.
const ID = Symbol('id');
const TAG = Symbol();

function entry(name: string, n: number) {
  return { name, [ID]: n, [TAG]: `t${n}` };
}

const a = entry('a', 1);
const b = entry('b', 2);
a[ID] += 10;
b[TAG] = 'retagged';
console.log(a[ID], a[TAG], b[ID], b[TAG], a.name);
console.log(Object.keys(a).join(','), JSON.stringify(b), ID in a, TAG in b, 'name' in a);
console.log(Object.getOwnPropertySymbols(a).length, Object.getOwnPropertySymbols(a)[0] === ID);
const list = [a, b].sort((x, y) => y[ID] - x[ID]);
console.log(list.map((x) => `${x.name}=${x[ID]}`).join(' '));
const copy = { ...a };
console.log(copy[ID], Object.keys(copy).join(','));
