// @lenient-both
// Library mode: `x && x.name` of an object a function gives null is that null when x is, typed and printed as null.
class Item {
  size = 0;
  constructor(public name: string) {}
}
function lookup(name: string): Item {
  return name === 'none' ? null : new Item(name);
}
function label(name: string): string {
  const item = lookup(name);
  const text = String(item && item.name);
  return [text, typeof (item && item.name), JSON.stringify({ n: item && item.name }), `${item && item.size}`].join('|');
}
console.log(label('none'));
console.log(label('a'));
const missing = lookup('none');
console.log(missing && missing.name, lookup('none') && lookup('x').name, missing === null);
const found = lookup('found');
console.log(found && found.name, found && found.size, typeof (found && found.size));
