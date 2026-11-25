// A parameter's default stands in for undefined only (a missing argument or `undefined`); null arrives as null.
function label(d: number | null = 5): string {
  return d === null ? 'null' : `n:${d}`;
}
console.log(label(null), label(), label(undefined), label(3));

function unwrap(s: string | null | undefined = 'dflt'): string {
  return s === undefined ? 'undefined' : s === null ? 'null' : s;
}
console.log(unwrap(null), unwrap(), unwrap(undefined), unwrap('x'));

const scaled = (n: number | null = 2, by = 10): string => `${n === null ? 'none' : n * by}`;
console.log(scaled(null), scaled(), scaled(undefined, 3), scaled(4));

class Box {
  size: number | null;
  constructor(size: number | null = 1) {
    this.size = size;
  }
}
console.log(new Box(null).size, new Box().size, new Box(undefined).size, new Box(9).size);
