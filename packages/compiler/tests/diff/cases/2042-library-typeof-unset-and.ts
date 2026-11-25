// @lenient-both
// Library mode: `typeof (x && x.name)` of a variable declared without a value is "undefined" before it is assigned.
class Item {
  constructor(public name: string) {}
}
function find(name: string): Item {
  if (name === 'none') return null;
  return new Item(name);
}
function probe(name: string): string {
  let x: Item;
  const before = typeof (x && x.name);
  x = find(name);
  return [before, typeof (x && x.name)].join('|');
}
let top: Item;
console.log(typeof (top && top.name));
console.log(probe('none'));
console.log(probe('a'));
