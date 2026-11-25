// An untyped `[]` whose only stated alias is `T[]` is that array: the alias is the same object, and pushes through either are seen by both.
interface Size {
  width: number;
  height: number;
}

const sizes = [];
for (let i = 0; i < 3; i++) sizes.push({ width: i, height: 2 * i });
const typed: Size[] = sizes;
console.log(typed === sizes, typed.length, typed[2].width, typed[2].height);
typed.push({ width: 7, height: 8 });
typed[0] = { width: 5, height: 6 };
console.log(sizes.length, typed[3].width, sizes.map((s) => s.width).join(','));

function grow(xs: Size[]): void {
  xs.push({ width: 9, height: 9 });
}
const more = [];
more.push({ width: 0, height: 0 });
grow(more);
console.log(more.length, more.map((s) => s.width).join(','));

function make(): Size[] {
  const out = [];
  out.push({ width: 1, height: 1 });
  return out;
}
const m = make();
m.push({ width: 2, height: 2 });
console.log(m.length, m[1].height);

class Box {
  items: Size[] = [];
}
const box = new Box();
let held = [];
held.push({ width: 4, height: 4 });
box.items = held;
held.push({ width: 5, height: 5 });
console.log(box.items === held, box.items.length, box.items[1].width);

const names = [];
names.push('a');
names.push('b');
const named: string[] = names;
named.push('c');
console.log(names === named, names.join(','));

const loose = [];
loose.push({ width: 3, height: 3 });
const anything: unknown = loose;
console.log(anything === loose, loose.length);
