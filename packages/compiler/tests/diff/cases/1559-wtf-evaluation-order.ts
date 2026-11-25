// Assignment evaluates its target before its value; destructuring defaults replace only undefined; reads past a string's ends.
interface Node2 { n: number; x?: Node2 }
let foo: Node2 = { n: 1 };
const bar = foo;
foo.x = foo = { n: 2 };
console.log('foo.x = foo = { n: 2 }', foo.x, foo, bar); // wtfjs: Chaining assignments on object
let u: any = { n: 1 };
const v = u;
u.x = u = { n: 2 };
console.log('untyped u.x = u = { n: 2 }', u.x, u, v); // wtfjs: Chaining assignments on object
const log: string[] = [];
const box: { [k: string]: number } = { a: 1 };
const key = (k: string) => { log.push('key ' + k); return k; };
const val = (n: number) => { log.push('value ' + n); return n; };
box[key('a')] = val(5);
box[key('a')] += val(2);
console.log('order', log.join(', '), box.a);
let arr = [1, 2, 3];
const old = arr;
arr[0] = (arr = [9, 9, 9]).length;
console.log('arr[0] = (arr = …)', old, arr);
let c: { v: number } = { v: 1 };
const firstC = c;
c.v += (c = { v: 10 }).v;
console.log('c.v += (c = …).v', firstC, c);
const { m = 5 } = { m: null as number | null };
const { q = 5 } = { q: undefined as number | undefined };
const [d = 7] = [null as number | null];
console.log('defaults', m, q, d); // wtfjs: Destructuring with default values
function f({ z = 3 }: { z?: number | null }) { return z; }
console.log('param default', f({ z: null }), f({}));
const str = 'str';
const anyStr: any = 'str';
console.log('"str"[-1]', (str as any)[-1], anyStr[-1], anyStr[3], anyStr[1]);
const arrFn: any = Array;
console.log('Array(3)', arrFn(3).length, arrFn(3, 4), arrFn('3'));
console.log('[undefined]', ([undefined] as any) == '', ([null] as any) == 0, [undefined].length, [null, undefined]);
