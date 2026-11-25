// Called through the base, an override's own default applies; null still arrives as null.
class Base {
  pick(d: number | null = 5): string {
    return `base:${d}`;
  }
}
class Derived extends Base {
  override pick(d: number = 0): string {
    return d != null ? `own:${d}` : 'null arrived';
  }
}
const b: Base = new Derived();
console.log(b.pick(null), b.pick(), b.pick(undefined), b.pick(3));
console.log(new Base().pick(null), new Base().pick(), new Base().pick(undefined));
const d = new Derived();
console.log(d.pick(), d.pick(undefined), d.pick(7));
