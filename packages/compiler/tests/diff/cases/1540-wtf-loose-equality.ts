// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): `==` coercion between arrays, booleans, strings, numbers and null.
const arr: any = [];
const t: any = true;
const f: any = false;
const zero: any = 0;
const empty: any = '';
const nul: any = null;
const und: any = undefined;
const sFalse: any = 'false';
const sTrue: any = 'true';
console.log('[] == ![]', arr == !arr); // wtfjs: `[]` is equal `![]`
console.log('true == []', t == arr); // wtfjs: `true` is not equal `![]`, but not equal `[]` too
console.log('true == ![]', t == !arr); // wtfjs: `true` is not equal `![]`, but not equal `[]` too
console.log('false == []', f == arr); // wtfjs: `true` is not equal `![]`, but not equal `[]` too
console.log('false == ![]', f == !arr); // wtfjs: `true` is not equal `![]`, but not equal `[]` too
console.log('!!"false" == !!"true"', !!sFalse == !!sTrue); // wtfjs: true is false
console.log('!!"false" === !!"true"', !!sFalse === !!sTrue); // wtfjs: true is false
console.log('true == "true"', t == 'true'); // wtfjs: true is false
console.log('false == "false"', f == 'false'); // wtfjs: true is false
console.log('!![]', !!arr); // wtfjs: `[]` is truthy, but not `true`
console.log('[] == true', arr == t); // wtfjs: `[]` is truthy, but not `true`
console.log('!!null', !!nul); // wtfjs: `null` is falsy, but not `false`
console.log('null == false', nul == f); // wtfjs: `null` is falsy, but not `false`
console.log('0 == false', zero == f); // wtfjs: `null` is falsy, but not `false`
console.log('"" == false', empty == f); // wtfjs: `null` is falsy, but not `false`
console.log('[] == ""', arr == empty); // wtfjs: Array equality is a monster
console.log('[] == 0', arr == zero); // wtfjs: Array equality is a monster
console.log('[""] == ""', ([''] as any) == empty); // wtfjs: Array equality is a monster
console.log('[0] == 0', ([0] as any) == zero); // wtfjs: Array equality is a monster
console.log('[0] == ""', ([0] as any) == empty); // wtfjs: Array equality is a monster
console.log('[""] == 0', ([''] as any) == zero); // wtfjs: Array equality is a monster
console.log('[null] == ""', ([null] as any) == empty); // wtfjs: Array equality is a monster
console.log('[null] == 0', ([null] as any) == zero); // wtfjs: Array equality is a monster
console.log('[undefined] == ""', ([undefined] as any) == empty); // wtfjs: Array equality is a monster
console.log('[undefined] == 0', ([undefined] as any) == zero); // wtfjs: Array equality is a monster
console.log('[[]] == 0', ([[]] as any) == zero); // wtfjs: Array equality is a monster
console.log('[[]] == ""', ([[]] as any) == empty); // wtfjs: Array equality is a monster
console.log('[[[[[[]]]]]] == ""', ([[[[[[]]]]]] as any) == empty); // wtfjs: Array equality is a monster
console.log('[[[[[[]]]]]] == 0', ([[[[[[]]]]]] as any) == zero); // wtfjs: Array equality is a monster
console.log('[[[[[[null]]]]]] == 0', ([[[[[[null]]]]]] as any) == zero); // wtfjs: Array equality is a monster
console.log('[[[[[[null]]]]]] == ""', ([[[[[[null]]]]]] as any) == empty); // wtfjs: Array equality is a monster
console.log('null == 0', nul == zero); // wtfjs: Comparing `null` to `0`
console.log('null > 0', nul > zero); // wtfjs: Comparing `null` to `0`
console.log('null >= 0', nul >= zero); // wtfjs: Comparing `null` to `0`
console.log('null == undefined', nul == und);
console.log('1 == true', (1 as any) == t); // wtfjs: Non-strict comparison of a number to `true`
console.log('Boolean(1.1)', Boolean(1.1)); // wtfjs: Non-strict comparison of a number to `true`
console.log('1.1 == true', (1.1 as any) == t); // wtfjs: Non-strict comparison of a number to `true`
console.log('1 < 2 < 3', (1 < 2) < (3 as any)); // wtfjs: Comparison of three numbers
console.log('3 > 2 > 1', (3 > 2) > (1 as any)); // wtfjs: Comparison of three numbers
console.log('3 > 2 >= 1', (3 > 2) >= (1 as any)); // wtfjs: Comparison of three numbers

// Statically typed where TypeScript accepts the comparison.
const strFalse: string = 'false';
const strTrue: string = 'true';
const b1: boolean = !!strFalse;
const b2: boolean = !!strTrue;
const n0: number = 0;
const s0: string = '';
const xs: number[] = [];
const nested: string[] = [''];
console.log('typed !!"false" == !!"true"', b1 == b2); // wtfjs: true is false
console.log('typed !![]', !!xs); // wtfjs: `[]` is truthy, but not `true`
console.log('typed 0 == ""', (n0 as number | string) == s0);
console.log('typed [] == ""', (xs as unknown as string) == s0); // wtfjs: Array equality is a monster
console.log('typed [""] == 0', (nested as unknown as number) == n0); // wtfjs: Array equality is a monster
console.log('typed 1.1 == 1', 1.1 == Number(true)); // wtfjs: Non-strict comparison of a number to `true`
