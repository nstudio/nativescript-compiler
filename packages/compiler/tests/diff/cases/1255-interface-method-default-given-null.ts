// Through an interface method and a function type, the implementation's default stands in for undefined only.
interface Picker {
  pick(d?: number | null): string;
}
class Fives implements Picker {
  pick(d: number | null = 5): string {
    return d === null ? 'null' : `n:${d}`;
  }
}
const p: Picker = new Fives();
console.log(p.pick(null), p.pick(), p.pick(undefined), p.pick(1), new Fives().pick());

type Fill = (s?: string | null) => string;
const fill: Fill = (s = 'dflt') => (s === null ? 'null' : s);
console.log(fill(null), fill(), fill(undefined), fill('x'));
