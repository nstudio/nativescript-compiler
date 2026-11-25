// @lenient-both
// Library mode: a variable declared without a value and given a call that gives only null holds that null once
// assigned (`c && c.name` is null), and undefined before.
class Item {
  constructor(public name: string) {}
}
function find(name: string): Item {
  if (name === 'none') return null;
  return new Item(name);
}
function describe(name: string): string {
  let c: Item;
  const before = String(c && c.name);
  c = find(name);
  return [before, String(c && c.name), typeof (c && c.name), JSON.stringify({ a: c && c.name }), `${c && c.name}`].join('|');
}
function twice(): string {
  let c: Item;
  c = find('x');
  const first = String(c && c.name);
  c = find('none');
  return [first, String(c && c.name), c === null, c === undefined].join('|');
}
console.log(describe('none'));
console.log(describe('a'));
console.log(twice());
let top: Item;
console.log(top === undefined);
top = find('none');
console.log(top && top.name, typeof (top && top.name), top === null);
