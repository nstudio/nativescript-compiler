// A promise of an array of object literals where a promise of an interface's array is declared.
interface Item { name: string; size: number }

async function load(names: string[]): Promise<Item[]> {
  return names.map((name, k) => ({ name, size: name.length * (k + 1), loaded: true }));
}

const later = async (names: string[]): Promise<Item[]> => names.map((name) => ({ name, size: 0, late: 1 }));

load(['ab', 'cde']).then((items) => {
  console.log(items.length, items[1].size, JSON.stringify(items));
  return later(['x']);
}).then((items) => console.log(items[0].name, JSON.stringify(items)));
