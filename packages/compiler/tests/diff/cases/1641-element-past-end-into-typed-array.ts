// An index past an array's end stored into an array typed to hold numbers, by index, `push` and a literal: the element
// holds undefined, not NaN or 0, wherever the array goes.
function attempt(label: string, f: () => unknown) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}
const src: number[] = [1, 2, 3];
const picked: number[] = [];
for (let i = 0; i < 4; i++) picked[i] = src[i * 2];
console.log(picked.length, picked.map((x) => (x === undefined ? 'U' : String(x))).join(','), JSON.stringify(picked));
console.log(picked.filter((x) => x !== undefined).length, picked.includes(3), String(picked), picked.join('|'));
const pushed: number[] = [];
pushed.push(src[0], src[7]);
console.log(pushed.length, typeof pushed[1], pushed[1] === undefined, `${pushed}`, pushed[1] + 1);
attempt('fixed', () => pushed[1].toFixed(1));

const words: string[] = ['a', 'b'];
const pair: string[] = [words[1], words[5]];
console.log(pair.length, pair[1] === undefined, pair.indexOf(words[9]), JSON.stringify(pair));
attempt('upper', () => pair[1].toUpperCase());
function total(xs: number[]): number {
  let n = 0;
  for (const x of xs) if (x) n += x;
  return n;
}
console.log(total(picked), total(pushed), picked.map(() => 1).length);
const tail: number[] = [src[0], src[9]];
console.log(tail.at(1) === undefined, tail.at(-1), tail.findIndex((x) => x === undefined), tail.find((x) => x !== 1), tail.indexOf(src[9]), tail.pop(), tail.length);
const seen = new Set<string>([words[0], words[3]]);
console.log(seen.size, seen.has(words[8]), [...seen].join('|'));
for (const w of seen) console.log('seen', w === undefined ? 'U' : w);
class Item {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
function keep(i: number, j: number): string {
  const items: Item[] = [new Item('x')];
  let p: Item | null = null;
  p = items[j];
  const kept = new Set<Item>();
  kept.add(items[i] ?? p);
  const first = [...kept][0];
  return `kept ${kept.size} ${first === undefined ? 'U' : first.name}`;
}
console.log(keep(0, 9), keep(9, 9));
