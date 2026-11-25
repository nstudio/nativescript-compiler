// A number method's argument that converts by its own code (held untyped, or an object): what the conversion throws,
// and a BigInt's or Symbol's TypeError, reach the catch; undefined held untyped is the argument left out.
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, (e as Error).constructor.name, (e as Error).message);
  }
}
const poisoned: any = {
  valueOf() {
    throw new RangeError('valueOf');
  },
};
const two = { valueOf: () => 2 };
const big: any = 5n;
const sym: any = Symbol('s');
const missing: any = undefined;
const radix: any = '16';
attempt('toString(poisoned)', () => (255).toString(poisoned));
attempt('toFixed(big)', () => (1.5).toFixed(big));
attempt('toExponential(missing)', () => (1234.5).toExponential(missing));
attempt('toString(radix)', () => (255).toString(radix));
attempt('toFixed(two)', () => (1.25).toFixed(two as any));
attempt('toPrecision(sym)', () => (1.5).toPrecision(sym));
