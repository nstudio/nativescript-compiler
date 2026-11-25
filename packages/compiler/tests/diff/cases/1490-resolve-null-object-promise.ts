// @app-lenient
// A non-strict app's promise of an object resolved with null (`resolve(null)`, `Promise.resolve(null)`): awaiting it
// gives null; resolved with an object, the object.
class Item {
  constructor(public name: string) {}
}

function find(name: string): Promise<Item> {
  return new Promise<Item>((resolve) => {
    if (name === '') setTimeout(() => resolve(null), 0);
    else resolve(new Item(name));
  });
}

function cached(name: string): Promise<Item> {
  if (name === '') return Promise.resolve(null);
  return Promise.resolve(new Item(name));
}

async function main() {
  const a = await find('');
  console.log(a === null, a === undefined);
  const b = await find('x');
  console.log(b.name);
  const c = await cached('');
  console.log(c === null, c === undefined);
  const d = await cached('y');
  console.log(d.name);
}
main();
