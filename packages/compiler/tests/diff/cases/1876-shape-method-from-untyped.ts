// An interface a class implements, with method signatures, met by an object literal or an untyped object (held in a
// union with another class, or converted to it): its methods are the object's own keys by their names, as are its keys,
// JSON and `in`, and a key set later replaces the method a call reaches.
interface Runner {
  run(): string;
  add(a: number, b: number): number;
  label?: string;
}
interface Prop {
  go: () => string;
}
class Walker implements Runner {
  run(): string {
    return 'walk';
  }
  add(a: number, b: number): number {
    return a + b;
  }
}
class Goer implements Prop {
  go = () => 'goer';
}
class Other {
  run(): string {
    return 'other';
  }
}
function go(x: Other | Runner): string {
  if (x instanceof Other) return 'class ' + x.run();
  return 'shape ' + x.run() + ' ' + x.add(2, 3);
}
console.log(go(new Walker()));
console.log(go(new Other()));
const lit: Runner = { run: () => 'literal', add: (a, b) => a * b, label: 'L' };
console.log(go(lit), Object.keys(lit).join(','), JSON.stringify(lit), 'run' in lit, typeof (lit as any).run);
const raw: any = { add: (a: number, b: number) => a - b, run: () => 'raw', extra: 1 };
console.log(go(raw));
const r: Runner = raw;
console.log(r.run(), r.add(9, 4), Object.keys(r).join(','));
const viaUnion = (x: Other | Runner) => ('add' in x ? x.add(1, 1) : x.run());
console.log(viaUnion(raw), viaUnion(new Other()));
(lit as any).run = () => 'replaced';
console.log(lit.run(), (lit as any)['run']());
const ps: Prop[] = [new Goer(), { go: () => 'plit' }];
const anyProp: any = { go: () => 'pany' };
ps.push(anyProp);
console.log(ps.map((p) => p.go()).join(','));
