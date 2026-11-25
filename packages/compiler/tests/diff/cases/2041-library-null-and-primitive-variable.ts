// @lenient-both
// Library mode: a variable given `c && c.name`, with c holding a call's only null, holds that null; given a present
// object, the string.
class Item {
  constructor(public name: string, public size: number) {}
}
function find(name: string): Item {
  if (name === 'none') return null;
  return new Item(name, name.length);
}
function plain(name: string): string {
  const c = find(name);
  const u = c && c.name;
  return `${typeof u} ${u} ${String(u)}`;
}
function describe(name: string): string {
  const c = find(name);
  const v = c && c.name;
  const n = c && c.size;
  let w: string;
  w = c && c.name;
  return [v, v === null, typeof v, String(v), `${v}`, JSON.stringify({ v }), n, n === null, typeof n, w, w === null].join('|');
}
console.log(plain('none'), plain('xy'));
console.log(describe('none'));
console.log(describe('abc'));
