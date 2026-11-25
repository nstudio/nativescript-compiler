// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): parseInt, Number() and parseFloat on odd inputs.
const pi: any = parseInt;
const num: any = Number;
const nul: any = null;
const und: any = undefined;
const both: any = { toString: () => 2, valueOf: () => 1 };
console.log('Number()', num()); // wtfjs: `undefined` and `Number`
console.log('Number(undefined)', num(und)); // wtfjs: `undefined` and `Number`
console.log('Number(null)', num(nul));
console.log('Number("")', num(''), num(' 12 '), num('0x10'), num('1e3'), num('12px'));
console.log('Number([])', num([]), num([5]), num([1, 2]), num({}));
console.log('parseInt("f*ck")', pi('f*ck')); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("f*ck", 16)', pi('f*ck', 16)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 10)', pi('Infinity', 10)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 18)', pi('Infinity', 18)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 19)', pi('Infinity', 19)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 23)', pi('Infinity', 23)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 24)', pi('Infinity', 24)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 29)', pi('Infinity', 29)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 30)', pi('Infinity', 30)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 34)', pi('Infinity', 34)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 35)', pi('Infinity', 35)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 36)', pi('Infinity', 36)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("Infinity", 37)', pi('Infinity', 37)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt(null, 24)', pi(nul, 24)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("06")', pi('06')); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("08")', pi('08')); // wtfjs: `parseInt` is a bad guy
console.log('parseInt({ toString, valueOf })', pi(both)); // wtfjs: `parseInt` is a bad guy
console.log('Number({ toString, valueOf })', num(both)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt(0.000001)', pi(0.000001)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt(0.0000001)', pi(0.0000001)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt(1 / 1999999)', pi(1 / 1999999)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt("0x1f"), parseInt("  -12abc")', pi('0x1f'), pi('  -12abc'), pi(''), pi('1e3'));
console.log('parseFloat', parseFloat('3.14abc'), parseFloat('.5'), parseFloat('-0'), parseFloat('Infinityx'), parseFloat('1e-3z'));

// Statically typed.
const s: string = 'f*ck';
const inf: string = 'Infinity';
console.log('typed parseInt("f*ck")', parseInt(s), parseInt(s, 16)); // wtfjs: `parseInt` is a bad guy
console.log('typed parseInt("Infinity", r)', parseInt(inf, 10), parseInt(inf, 19), parseInt(inf, 24), parseInt(inf, 36), parseInt(inf, 37)); // wtfjs: `parseInt` is a bad guy
console.log('typed parseInt("08")', parseInt('06'), parseInt('08'), parseInt('0x1f'), parseInt('  -12abc'), parseInt('')); // wtfjs: `parseInt` is a bad guy
console.log('typed parseInt(String(0.0000001))', parseInt(String(0.000001)), parseInt(String(0.0000001)), parseInt(`${1 / 1999999}`)); // wtfjs: `parseInt` is a bad guy
console.log('typed Number("")', Number(''), Number(' 12 '), Number('0x10'), Number('0b11'), Number('1e3'), Number('12px'));
console.log('typed Number(true)', Number(true), Number(false), Number(new Date(0)));
console.log('typed parseFloat', parseFloat('3.14abc'), parseFloat('.5'), parseFloat('Infinityx'));
