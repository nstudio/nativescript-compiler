// A class's object placed where an object type it doesn't implement is wanted: a variable, an argument, an array's
// element, an object's property and a function's result read it through that type, the same object.
class Wrap {
  readonly mode: string;
  constructor(mode = 'wrap') {
    this.mode = mode;
  }
  describe(): string {
    return `wrap:${this.mode}`;
  }
}
class Tally {
  count = 0;
  bump(by: number): number {
    this.count += by;
    return this.count;
  }
  get doubled(): number {
    return this.count * 2;
  }
}
class LoudWrap extends Wrap {
  describe(): string {
    return super.describe().toUpperCase();
  }
}
type Describer = { describe(): string };
const o: { describe(): string } = new Wrap();
console.log(o.describe());
function show(d: Describer): string {
  return d.describe();
}
console.log(show(new Wrap('arg')), show(new LoudWrap('loud')));
const list: Describer[] = [new Wrap('a'), new LoudWrap('b')];
console.log(list.map((d) => d.describe()).join());
const holder: { item: { mode: string; describe(): string } } = { item: new Wrap('held') };
console.log(holder.item.mode, holder.item.describe());
const t = new Tally();
const counter: { count: number; bump(by: number): number; readonly doubled: number } = t;
console.log(counter.bump(2), counter.bump(3), counter.doubled, t.count);
counter.count = 10;
console.log(t.count, t.doubled, counter === t);
function make(): { describe(): string } {
  return new LoudWrap('made');
}
console.log(make().describe(), make() instanceof Wrap);
