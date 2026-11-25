// Containers holding an undefined the program stores (`m.get(k)!`) given to callbacks of every kind: declared function
// values, built-in conversions, a function typed by an annotation, a library function; loop variables of object
// elements read for a member; a Map an arrow returns from `set`; an evolving array and its typed alias; and containers
// filled from one untyped function, which share nothing through it.
const counts = new Map<string, number>([['a', 1]]);
const xs: number[] = [];
xs.push(counts.get('a')!);
xs.push(counts.get('b')!);
const show = (v: number) => console.log('show', v);
const show3 = (v: number, i: number, a: number[]) => console.log('show3', v, i, a.length);
xs.forEach(show);
xs.forEach(show3);
const angle = (v: number) => `<${v}>`;
console.log(xs.map(String).join(','), xs.map(Number).join(','), xs.filter(Boolean).length, xs.map(angle).join(','));
console.log(xs.map((v, i, a) => `${v}/${i}/${a.length}`).join(' '), xs.reduce((s, v) => s + (v ?? 0), 0));
const add = (s: number, v: number) => s + v;
console.log(xs.reduce(add, 0));

class Item {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}
const known = new Map<string, Item>([['a', new Item('A')]]);
const items: Item[] = [];
items.push(known.get('a')!);
const label = (i: Item) => i.text;
console.log(items.map(label).join(' '));
items.push(known.get('z')!);
try {
  console.log(items.map(label).join(' '));
} catch (e) {
  console.log('map threw', (e as Error).constructor.name);
}
try {
  for (const item of items) console.log('item', item.text);
} catch (e) {
  console.log('loop threw', (e as Error).constructor.name);
}
for (const item of [new Item('B')]) console.log(items.some((i) => i !== undefined && i.text === item.text));

const typedFormat: (v: number) => string = (v) => `[${v}]`;
const stated: number[] = [];
stated.push(counts.get('a') as number);
console.log(stated.map(typedFormat).join(','));
function each(list: number[], f: (v: number, i: number, a: number[]) => void) {
  list.forEach(f);
}
each(stated, (v, i, a) => console.log('each', v, i, a.length));
const handles: number[] = [];
handles.push(counts.get('a') as number);
handles.forEach(clearTimeout);
console.log('cleared', handles.length);

const table = new Map<string, number>();
const put = (k: string, v: number) => table.set(k, v);
put('a', 1);
table.set('b', counts.get('b')!);
console.log(table.size, table.get('a'), table.get('b'), table.has('b'));

interface Size {
  width: number;
}
const sizes = [];
sizes.push({ width: 1 });
const alias: Size[] = sizes;
const lookup = new Map<string, Size>();
alias.push(lookup.get('none')!);
console.log(alias === sizes, sizes.length, alias.length, alias.filter((s) => s !== undefined).length);

function untyped(k: number): any {
  return k > 0 ? [k, k + 1] : undefined;
}
const words: string[] = [];
words.push(untyped(0) as string);
const rows: number[][] = [untyped(2)];
const first = (row: number[]) => row[0];
console.log(rows.map(first).join(','), words.length);
