// Arithmetic of two operands held untyped is held untyped where its value is used as any value is: two BigInts give a
// BigInt there, two numbers a number; where the code uses the value as a number, it is one.
const a: any = 6n;
const b: any = 7n;
console.log(a * b, typeof (a * b), a - b, b % a, a ** 3n, a / b, a & b, a | b, a ^ b, a << 2n, b >> 1n);
console.log(`${a * b * a}`, 'big ' + (a - b) * b, (a + b) * (a - b), a * b + a);
let held: any = a * b;
held = held * held;
console.log(held, typeof held);
const x: any = 6;
const y: any = 7;
console.log(x * y, typeof (x * y), x - y, (x * y).toFixed(1), Math.max(x * y, 1), [1, 2, 3][x - 5]);
let c: any = 2n;
c **= 70n;
c -= 1n;
console.log(c, typeof c);
function scale(u: any, v: any): any {
	return u * v;
}
console.log(scale(3, 4), typeof scale(2n, 5n), scale(2n, 5n));
try { console.log(a * x); } catch (e) { console.log('mix', (e as Error).name, (e as Error).message); }
try { console.log(a >>> b); } catch (e) { console.log('unsigned', (e as Error).name, (e as Error).message); }
try { console.log(a / (b - b)); } catch (e) { console.log('zero', (e as Error).name, (e as Error).message); }
