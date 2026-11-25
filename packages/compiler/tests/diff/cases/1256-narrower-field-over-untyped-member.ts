// A subclass field narrower than an untyped (`any`) member its group shares with an optional interface member: the
// group is held untyped, so the subclass still implements the interface.
interface Options {
  size?: any;
  label?: string;
}
class Base implements Options {
  size: any = 250;
  label: string = 'base';
}
class Sized extends Base implements Options {
  size: number = 225;
  grow(): number {
    return this.size + 1;
  }
}
const s = new Sized();
const o: Options = s;
console.log(s.size, s.grow(), o.size, JSON.stringify(s));
o.size = 'wide';
o.label = undefined;
console.log(s.size, s.label, JSON.stringify(s));
