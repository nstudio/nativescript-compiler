// Number methods given an out-of-range radix or digit count throw RangeError with V8's message.
const show = (f: () => unknown) => {
  try {
    console.log(f());
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
};
const n = 255;
const radix = [1, 37, 16];
const digits = [101, -1, 2];
for (const r of radix) show(() => n.toString(r));
for (const d of digits) show(() => n.toFixed(d));
for (const d of digits) show(() => n.toExponential(d));
for (const d of [0, 101, 3]) show(() => n.toPrecision(d));
