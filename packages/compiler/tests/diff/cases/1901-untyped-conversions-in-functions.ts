// Functions whose only throwing step is an untyped operand's conversion: the error reaches the caller's catch, through
// a callback, a method and a getter.
class Meter {
  reading: any;
  constructor(reading: any) {
    this.reading = reading;
  }
  scaled(by: any): number {
    return this.reading * by;
  }
  get label(): string {
    return `meter ${this.reading}`;
  }
}
function total(values: any[]): any {
  let sum: any = 0;
  for (const v of values) sum = sum + v;
  return sum;
}
for (const [name, run] of [
  ['total numbers', () => total([1, 2, 3])],
  ['total bigints', () => total([1n, 2n])],
  ['total mixed', () => total([1n, 2])],
  ['total strings', () => total(['a', 1n])],
  ['map', () => [1n, 2n].map((x: any) => x * 3)],
  ['map ok', () => [1, 2].map((x: any) => x * 3)],
  ['scaled', () => new Meter(4).scaled(2)],
  ['scaled big', () => new Meter(4n).scaled(2)],
  ['label', () => new Meter({ toString: () => { throw new RangeError('toString'); } }).label],
  ['label ok', () => new Meter(9).label],
] as [string, () => unknown][]) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, 'threw', (e as Error).constructor.name, (e as Error).message);
  }
}
