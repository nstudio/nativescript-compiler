// A BigInt held from untyped arithmetic, used beside a number, throws as script does: a BigInt beside a number in
// arithmetic is a TypeError, while comparing them compares their values.
const a: any = 6n;
const b: any = 7n;
const p = a * b;
try { console.log(p + 1); } catch (e) { console.log('add', (e as Error).constructor.name); }
try { console.log(p * 2); } catch (e) { console.log('multiply', (e as Error).constructor.name); }
console.log(p > 41, p < 43, p * p, typeof (p * p));
const x: any = 2;
const n = x * 3;
console.log(Math.max(n, 1), n + 1, n.toFixed(2), n > 5);
