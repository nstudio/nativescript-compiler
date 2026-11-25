// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): `==` between an empty string or 0 and arrays nested around undefined.
const zero: any = 0;
const empty: any = '';
console.log('[[[[[[undefined]]]]]] == 0', ([[[[[[undefined]]]]]] as any) == zero); // wtfjs: Array equality is a monster
console.log('[[[[[[undefined]]]]]] == ""', ([[[[[[undefined]]]]]] as any) == empty); // wtfjs: Array equality is a monster
