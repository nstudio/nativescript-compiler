// Untyped values converted into a copy where the program can tell the copy from its source; the other lines are not reported.
interface Point { x: number; y: number }
interface Scene { points: Point[]; origin: Point }

function scale(values: number[], k: number): void {
  for (let i = 0; i < values.length; i++) values[i] *= k;
}
function total(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
function append(values: string[]): void {
  values.push('end');
}
function forward(values: number[]): void {
  scale(values, 2);
}
class Store {
  held: number[] = [];
  keep(values: number[]) { this.held = values; }
  later(values: number[]) { setTimeout(() => console.log(values.length)); }
}
function append2(list: Point[]): void { list.push({ x: 0, y: 0 }); }
function total2(list: Point[]): number { return list.length; }
function moveTo(p: Point): void { p.x = 0; }
function same(a: Point, b: Point): boolean { return a === b; }
function firstOf<T>(list: T[]): T { return list[0]; }
interface Labelled { x: number; y: number; label: string }
function asPoints(list: Labelled[]): Point[] { return list; } // expect: returned as `Point[]`
function freshPoints(list: Labelled[]): Point[] { return list.map((p) => ({ ...p, x: p.x + 1 })); }
function pointsOnly(list: Labelled[]): Point[] { return list.map((p) => ({ x: p.x, y: p.y })); }
class Plot {
  points: Point[] = [];
  take(list: Labelled[]) { this.points = list; } // expect: stored as `Point[]`
  build(list: Labelled[]) { this.points = list.map((p) => ({ ...p, y: 0 })); }
}

export function run(raw: any, rawList: any[], scene: Scene) {
  scale(raw, 2); // expect: given to scale's parameter `values`
  scale(rawList, 2); // expect: given to scale's parameter `values`
  forward(raw); // expect: given to forward's parameter `values`
  append(raw.words); // expect: given to append's parameter `values`
  new Store().keep(raw); // expect: keep keeps it
  new Store().later(raw); // expect: later keeps it
  same(raw, scene.origin);
  console.log(total(raw), total(JSON.parse('[1]')), firstOf(raw));
  const typed: number[] = [1, 2];
  scale(typed, 2);
  scale(Array(3).fill(1), 2);
  moveTo(raw);
  const s: Scene = raw;
  console.log(s.origin === scene.origin);
  const pts: Point[] = raw.points; // expect: writes to it
  pts.push({ x: 1, y: 1 });
  const read: Point[] = raw.points;
  console.log(read.length, read[0].x);
  console.log(scene.points.indexOf(raw));
  const seen = new Set<Point>();
  console.log(seen.has(raw));
  (raw as Point[]).sort((a, b) => a.x - b.x); // expect: writes to it
  const labelled: Labelled[] = [{ x: 1, y: 2, label: 'a' }];
  append2(labelled); // expect: given to append2's parameter `list`
  console.log(total2(labelled), asPoints(labelled), freshPoints(labelled), pointsOnly(labelled));
  const asRead: Point[] = labelled;
  console.log(asRead.length);
  const asWritten: Point[] = labelled; // expect: writes to it
  asWritten.push({ x: 0, y: 0 });
  new Plot().take(labelled);
  new Plot().build(labelled);
}
