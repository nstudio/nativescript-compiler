// A class field narrower than its interface's optional member, read with `??` and a fallback of another type: once
// script writes undefined through the interface, the read gives the fallback.
interface Spacing {
  pad?: number;
  shown?: boolean;
}
class Box implements Spacing {
  pad: number = 8;
  shown: boolean = true;
  padText(): string {
    return `${this.pad ?? ''}|${!!this.shown}|${!this.shown}`;
  }
  inferred() {
    return (this.pad) ?? '';
  }
  padOr(): number | string {
    return this.pad ?? 'none';
  }
}
const b = new Box();
console.log(b.padText(), b.padOr(), typeof b.padOr(), b.inferred());
const s: Spacing = b;
s.pad = undefined;
s.shown = undefined;
console.log(b.padText(), b.padOr(), typeof b.padOr(), `${b.inferred()}`, JSON.stringify(b));
