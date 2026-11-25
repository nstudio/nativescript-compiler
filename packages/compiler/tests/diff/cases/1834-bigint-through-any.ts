// A BigInt held untyped stays a BigInt: mixed with a number in `+` or `*` it throws a TypeError.
const a: any = 1n;
const b: any = 1;
try {
  console.log(a + b);
} catch (e) {
  console.log('add', (e as Error).constructor.name, (e as Error).message);
}
try {
  console.log(a * 2);
} catch (e) {
  console.log('mul', (e as Error).constructor.name);
}
console.log(a + 2n, a < b, a == b, a === b, String(a + a));
