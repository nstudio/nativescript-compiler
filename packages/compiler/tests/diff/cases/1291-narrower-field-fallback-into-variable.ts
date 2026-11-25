// A variable declaring no type, given a `??`, `&&` or `||` over a class field narrower than its interface's optional
// member: once script writes undefined through the interface, the variable holds what JavaScript gives.
interface Spacing {
  shown?: boolean;
  pad?: number;
}
class Box implements Spacing {
  shown: boolean = true;
  pad: number = 1;
}
const b = new Box();
const s: Spacing = b;
s.shown = undefined;
s.pad = undefined;
const x = b.pad ?? '';
function read(): string {
  const both = b.shown && b.pad > 0;
  let z = b.pad ?? 'n';
  const first = `${both}|${z}|${typeof both}|${typeof z}|${both ? 'y' : 'n'}`;
  z = 3;
  return `${first}|${z}`;
}
console.log(x, typeof x, String(x).length, read());
s.shown = true;
s.pad = 2;
console.log(read());
