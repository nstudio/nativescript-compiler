// A callback declaring the type of what an untyped promise settles with, and of an untyped callback slot.
class Item {
  constructor(public name: string) {}
}
function load(name: string): Promise<any> {
  return Promise.resolve(new Item(name));
}
function each(list: any[], fn: (x: any, i: number) => void) {
  list.forEach((x, i) => fn(x, i));
}
async function main() {
  await load('a').then((r: Item) => console.log(r.name, r instanceof Item));
  const n = await load('b').then((r: Item) => r.name.length);
  console.log(n);
  each([new Item('c'), new Item('d')], (it: Item, i) => console.log(i, it.name));
}
main();
