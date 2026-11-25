// A method read off a prototype and called on another object: a built-in's as the object's own, a class's as that class's.
const o: Record<string, number> = { a: 1 };
const has = Object.prototype.hasOwnProperty;
console.log('hasOwn', Object.prototype.hasOwnProperty.call(o, 'a'), Object.prototype.hasOwnProperty.call(o, 'b'), has.call(o, 'a'), has.call([1, 2], 1), has.call([1], 'length'));
console.log('enumerable', Object.prototype.propertyIsEnumerable.call(o, 'a'), Object.prototype.propertyIsEnumerable.call([1], 'length'), Object.prototype.propertyIsEnumerable.call([1], 0));
console.log('toString', Object.prototype.toString.call([]), Object.prototype.toString.call(null), Object.prototype.toString.call(o), Object.prototype.toString.call(new Date(0)));

class Point {
  constructor(public x: number) {}
  describe(prefix: string): string {
    return prefix + this.x;
  }
  scaled(by: number): number {
    return this.x * by;
  }
}
class Point3 extends Point {
  describe(prefix: string): string {
    return 'p3 ' + Point.prototype.describe.call(this, prefix);
  }
}
const p3 = new Point3(3);
const p = new Point(2);
console.log('class', p3.describe('#'), Point3.prototype.describe.call(p3, '@'), Point.prototype.scaled.call(p3, 2), Point.prototype.scaled.apply(p, [5]));

const list = [1, 2, 3];
console.log('array', Array.prototype.slice.call(list, 1).join(','), Array.prototype.join.call(list, '-'), Array.prototype.indexOf.apply(list, [3]));
console.log('string', String.prototype.toUpperCase.call('abc'), String.prototype.slice.call('hello', 1, 3));
function count(...args: unknown[]) {
  return Array.prototype.slice.call(args, 1).length;
}
console.log('rest', count('a', 'b', 'c'));
const rest: [number] = [2];
console.log('apply', Array.prototype.slice.apply(list, rest).join(','), Array.prototype.indexOf.call(list, ...rest), String.prototype.slice.apply('hello', [3]));
const n = 255;
console.log('number', Number.prototype.toFixed.call(1.255, 2), Number.prototype.toString.call(n, 16), Number.prototype.toPrecision.apply(Math.PI, [3]), Number.prototype.valueOf.call(7) + 1, Number.prototype.toExponential.call(n));
console.log('boolean', Boolean.prototype.toString.call(false), Boolean.prototype.valueOf.call(true), Boolean.prototype.toString.apply(n > 1));
const slice = Array.prototype.slice;
const upper = String.prototype.toUpperCase;
const fixed = Number.prototype.toFixed;
const yes = Boolean.prototype.toString;
console.log('held', slice.call(list, 1).join(','), slice.apply(list, rest).join(','), (slice).call(list, ...rest).length, upper.call('abc'), fixed.apply(1.255, [1]), yes.call(n > 1));
function joined(xs: number[], by: string): string {
  const join = Array.prototype.join;
  return join.call(slice.call(xs, 1), by);
}
console.log('held local', joined(list, '+'), joined([], '+'));
