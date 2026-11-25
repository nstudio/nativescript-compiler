// Callbacks giving an untyped value where their slot's result is typed: the value is the slot's.
class Box { label: string; constructor(label: string) { this.label = label; } }
type Extract<P> = (point: P) => number;

class Holder {
  ref: { el: any } | undefined = { el: new Box('held') };
  run(make: () => Box | undefined): string { return make()?.label ?? 'none'; }
}

function extractor<P>(key: string): Extract<P> {
  return (point: P) => (point as any)[key];
}

const h = new Holder();
console.log(h.run(() => h.ref?.el));
h.ref = undefined;
console.log(h.run(() => h.ref?.el));
const x = extractor<{ x: number }>('x');
console.log(x({ x: 41 }) + 1);
