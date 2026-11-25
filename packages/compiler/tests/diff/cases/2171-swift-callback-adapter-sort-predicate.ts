// Untyped arrays with typed-parameter sort (< 2 params), truthy predicates, and throwing parameter conversions.
class Box {
  v: number;
  ok: number;
  constructor(v: number, ok: number) {
    this.v = v;
    this.ok = ok;
  }
}

const loose: any[] = [3, 1, 2];
const sorted = loose.toSorted((a: number) => a - 2);
const mutable: any[] = [3, 1, 2];
mutable.sort((a: number) => 2 - a);
const filtered = loose.filter((x: number) => x - 1);
const found = loose.find((x: number) => x - 2);
const hasSome = loose.some((x: number) => x - 2);
const allOk = loose.every((x: number) => x);

const boxes: any[] = [new Box(1, 0), new Box(2, 1)];
const okBoxes = boxes.filter((b: Box) => b.ok);

console.log(sorted.join(','), mutable.join(','), filtered.join(','), found, hasSome, allOk, okBoxes.length, (okBoxes[0] as Box).v);
