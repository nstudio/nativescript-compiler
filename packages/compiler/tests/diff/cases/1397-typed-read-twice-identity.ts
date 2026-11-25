// A member read twice from an untyped holder gives the same object both times, typed or not.
interface Point {
  x: number;
  y: number;
}

class Holder {
  data: any = { p: { x: 1, y: 2 } };
  get point(): Point {
    return this.data.p;
  }
}

const h = new Holder();
const a = h.point;
const b = h.point;
console.log(a === b, a === h.data.p, [a].includes(b));
a.x = 5;
console.log(b.x, h.data.p.x);
const seen = new WeakMap<Point, number>();
seen.set(a, 1);
console.log(seen.get(b), seen.has(h.data.p));
