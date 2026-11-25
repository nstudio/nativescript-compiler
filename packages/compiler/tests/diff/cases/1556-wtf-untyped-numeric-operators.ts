// Untyped numeric operators never trap: division and remainder by zero, boolean and integer-looking operands, overflow past 2^53 and Int64.
const arr: any = [];
const t: any = true;
const f: any = false;
const zero: any = 0;
const one: any = 1;
const big: any = 9007199254740992;
const huge: any = 9223372036854775807;
console.log('+!![] / +![]', +!!arr / +!arr); // wtfjs: It's a fail
console.log('+![] / +![]', +!arr / +!arr);
console.log('-1 / +![]', -1 / +!arr);
console.log('true / false', t / f); // wtfjs: Math with `true` and `false`
console.log('true % false', t % f);
console.log('1 % 0', one % zero);
console.log('-1 % 1', -one % one);
console.log('1 / 0', one / zero);
console.log('0 / 0', zero / zero);
console.log('5 % -0', (5 as any) % -zero);
console.log('big + 1', big + one);
console.log('big * big', big * big);
console.log('huge + 1', huge + one);
console.log('huge * 2', huge * 2);
console.log('-huge - 2', -huge - 2);
console.log('2 ** 64', (2 as any) ** 64);
console.log('7 / 2', (7 as any) / (2 as any));
console.log('-7 % 2', (-7 as any) % (2 as any));
console.log('true * 3', t * 3); // wtfjs: Math with `true` and `false`
let n: any = 1;
n /= zero;
console.log('n /= 0', n);
let m: any = 1;
m %= zero;
console.log('m %= 0', m);
let k: any = huge;
k += 1;
console.log('k += 1', k);
let i: any = 0;
i--;
console.log('i--', i, 1 / (i + 1));
let p: any = 2;
p **= 0.5;
console.log('p **= 0.5', p);
console.log('-true', -t, -!arr, ~t, ~~huge);
let q: any = '3';
q %= 2;
console.log('"3" %= 2', q);
