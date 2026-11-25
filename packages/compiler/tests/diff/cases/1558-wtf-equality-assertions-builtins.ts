// A type assertion is erased: an array asserted a string or number compares as the array. `Object` read as a value.
const xs: number[] = [];
const nested: string[] = [''];
const s0: string = '';
const n0: number = 0;
console.log('[] == ""', (xs as unknown as string) == s0, (xs as unknown as string) === s0, (xs as unknown as string) != s0); // wtfjs: Array equality is a monster
console.log('[""] == 0', (nested as unknown as number) == n0, (nested as unknown as number) !== n0); // wtfjs: Array equality is a monster
console.log('[1] == 1', ([1] as unknown as number) == 1, (['a'] as unknown as string) == 'a');
const o = { Object };
console.log('{ Object }', `${o}`, typeof Object, typeof o.Object); // wtfjs: `` `${{Object}}` ``
const anyObj: any = Object;
console.log('Object.keys via value', anyObj.keys({ a: 1, b: 2 }));
