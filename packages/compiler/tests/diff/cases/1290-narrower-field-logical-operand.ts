// A class field narrower than its interface's optional member, as an operand of `&&` or `||`: once script writes
// undefined through the interface, the whole gives that undefined (`&&`'s left, `||`'s right), not false.
interface Flags {
  shown?: boolean;
  open?: boolean;
}
class Panel implements Flags {
  shown: boolean = true;
  open: boolean = false;
  both() {
    return this.shown && this.open;
  }
  either() {
    return this.open || this.shown;
  }
  text(): string {
    return `${this.shown && this.open}|${this.open || this.shown}|${this.shown && !this.open}`;
  }
}
const p = new Panel();
console.log(p.both(), p.either(), p.text(), p.shown && 1);
const f: Flags = p;
f.shown = undefined;
console.log(p.both(), p.either(), p.text(), String(p.both()), `${p.both()}`);
const v = p.shown && p.open;
console.log(v, v === undefined, typeof v);
f.shown = true;
console.log(p.both(), p.either(), p.text());
