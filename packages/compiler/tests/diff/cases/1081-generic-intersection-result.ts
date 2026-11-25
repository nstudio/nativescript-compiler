// A generic function's `T & { … }` result is read as the instantiation the caller names: every key the spread copied
// and the ones the literal adds, held as the caller's shape: a copy, not the argument itself, even a class instance.
// A function giving back its argument gives a class instance itself.
interface Point {
  x: number;
  y: number;
}

function stamp<T>(t: T): T & { at: number } {
  return { ...t, at: 1 };
}
function label<T extends object>(t: T, name: string): T & { name: string } {
  return { ...t, name };
}

class Pos {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

function show(p: Point & { at: number }): string {
  return `${p.x},${p.y}@${p.at}`;
}

const p: Point = { x: 1, y: 2 };
const s: Point & { at: number } = stamp(p);
console.log(s.x, s.y, s.at, JSON.stringify(s));
s.x = 10;
s.at = s.at + 1;
console.log(show(s), p.x, JSON.stringify(s));

const inferred = stamp(p);
inferred.y = inferred.at + 5;
console.log(show(inferred), Object.keys(inferred).join());

const nested = label(stamp(p), 'n');
nested.at = 7;
console.log(nested.x, nested.at, nested.name, JSON.stringify(nested));

const both: Point & { at: number } & { name: string } = label(stamp({ x: 3, y: 4 }), 'b');
console.log(show(both), both.name);

const list = [stamp(p), stamp({ x: 5, y: 6 })];
console.log(list.map(show).join(' '));

const pos = new Pos(8, 9);
const sp = stamp<Point>(pos);
console.log(sp.x, sp.at, (sp as unknown) === pos, sp instanceof Pos, JSON.stringify(sp));
sp.x = 0;
console.log(pos.x, sp.x);
const viaPoint = (q: Point) => stamp(q);
const vp = viaPoint(pos);
vp.y = vp.at;
console.log(show(vp), pos.y, (vp as unknown) === pos);

function restamp<T extends object>(t: T): T & { at: number } & { again: boolean } {
  const once = stamp(t);
  once.at = once.at + 1;
  return { ...once, again: true };
}
const r = restamp(p);
console.log(show(r), r.again, JSON.stringify(r));

class Stamper<T extends object> {
  constructor(private base: T) {}
  stamped(at: number): T & { at: number } {
    return { ...this.base, at };
  }
}
const st = new Stamper<Point>({ x: 7, y: 8 }).stamped(3);
st.x = st.at * 2;
console.log(show(st), JSON.stringify(st));

function mark<T extends object>(t: T): T & { at: number } {
  return Object.assign(t, { at: 1 });
}
const kept = new Pos(1, 1);
const marked = mark(kept);
console.log(marked === kept, marked instanceof Pos, marked.x, JSON.stringify(kept));
