// A value asserted `as Iterable<T>` whose class declares [Symbol.iterator](): iterated through it, as GetIterator does;
// one without it throws V8's TypeError naming the JavaScript expression.
class Range {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
  [Symbol.iterator](): Iterator<number> {
    let i = 0;
    const n = this.n;
    return { next: () => (i < n ? { value: i++, done: false } : { value: undefined, done: true }) };
  }
}
const v: unknown = new Range(3);
const out: number[] = [];
for (const x of v as Iterable<number>) out.push(x);
console.log(out.join(','), [...(v as Iterable<number>)].join(','), Array.from(v as Iterable<number>).join(','));
const a: any = new Range(2);
const r = new Range(2);
function total(xs: Iterable<number>): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum;
}
console.log([...(a as Iterable<number>)].join(','), [...(r as Iterable<number>)].join(','), total(v as Iterable<number>), total(a));
const items: Iterable<number>[] = [new Range(2), [7, 8], new Set([9])];
for (const it of items) console.log([...it].join(','));
const w: unknown = { a: 1 };
try {
  for (const x of w as Iterable<number>) console.log(x);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
try {
  console.log([...(w as Iterable<number>)].length);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
const u: any = { b: 2 };
try {
  for (const x of u as Iterable<number>) console.log(x);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
