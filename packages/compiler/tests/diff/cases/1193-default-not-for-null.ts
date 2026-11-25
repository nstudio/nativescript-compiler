// A parameter's default stands in for undefined only: null given through a base method that takes it arrives as null;
// an element read past an array's end, assigned as a value, is undefined.
class Base {
  pick(d: number | null = 0): string {
    return `base:${d}`;
  }
}
class Derived extends Base {
  override pick(d: number = 0): string {
    return d != null ? `own:${d}` : 'null arrived';
  }
}
const b: Base = new Derived();
console.log(b.pick(null), b.pick(), b.pick(3));

const queue: string[] = ['x', 'y'];
let item: string | undefined;
let n = 0;
while ((item = queue[0]) && n < 5) {
  queue.shift();
  n++;
  console.log('item', item);
}
console.log('end', item, n);
