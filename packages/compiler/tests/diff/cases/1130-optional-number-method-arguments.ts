// A radix or digit count that is undefined is absent; an untyped null is 0 (a RangeError for toString's radix and toPrecision).
const show = (f: () => unknown) => {
  try {
    console.log(f());
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
};
const n = 255;
const values: (number | undefined)[] = [undefined, 16, 2];
for (const r of values) {
  show(() => n.toString(r));
  show(() => n.toFixed(r));
  show(() => n.toExponential(r));
  show(() => n.toPrecision(r));
}
const nothing: number | undefined = (globalThis as any).__nothing;
console.log((255).toString(nothing), (255).toFixed(nothing), (255).toExponential(nothing), (255.5).toPrecision(nothing));
function digits(x: number, d?: number, r?: number): string {
  return `${x.toFixed(d)} ${x.toExponential(d)} ${x.toPrecision(d)} ${x.toString(r)}`;
}
console.log(digits(0.5), digits(1234.5, 3, 8));
const loose: any[] = [undefined, null, 3, '4'];
for (const v of loose) {
  show(() => n.toString(v));
  show(() => n.toFixed(v));
  show(() => n.toExponential(v));
  show(() => n.toPrecision(v));
}
console.log(n.toString(undefined), n.toFixed(undefined), n.toExponential(undefined), n.toPrecision(undefined));
const g = globalThis as any;
for (const v of [g.__nothing, null]) {
  show(() => Number.prototype.toString.call(n, v));
  show(() => Number.prototype.toFixed.call(n, v));
  show(() => Number.prototype.toExponential.call(n, v));
  show(() => Number.prototype.toPrecision.call(n, v));
  show(() => n.toString(v as number));
  show(() => n.toExponential(v as number));
}
