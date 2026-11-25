// A variable declared without a type and initialized by arithmetic of untyped operands holds what the arithmetic gives:
// two BigInts give a BigInt, which it keeps where TypeScript types a number.
const a: any = 6n;
const b: any = 7n;
const p = a * b;
console.log(p, typeof p);
const q = a - b;
console.log(q.toString(), `${q}`, typeof q);
let r = p * a;
r = r * a;
console.log(r, typeof r);
const x: any = 6;
const y: any = 7;
const s = x * y;
console.log(s, typeof s, s + 1, s.toFixed(1), Math.max(s, 1), [1, 2, 3][s - 41]);
function area(w: any, h: any) {
	const v = w * h;
	return `${v} ${typeof v}`;
}
console.log(area(2, 3), area(2n, 3n));
