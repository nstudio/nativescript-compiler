// Two BigInts held untyped in a numeric operator: a BigInt, which TypeScript types a number.
const a: any = 6n;
const b: any = 7n;
console.log(a * b, a - b, b % a, typeof (a * b));
let c: any = 2n;
c **= 70n;
console.log(c);
