// Number() with and without an argument, parseInt of non-strings (converted with ToString first), Number.isNaN of non-numbers, literals past Int64.
const num: any = Number;
const pi: any = parseInt;
const nul: any = null;
const und: any = undefined;
const both: any = { toString: () => '2', valueOf: () => 1 };
console.log('Number()', num(), Number()); // wtfjs: `undefined` and `Number`
console.log('Number(undefined)', num(und), Number(undefined)); // wtfjs: `undefined` and `Number`
console.log('parseInt(null, 24)', pi(nul, 24), parseInt(nul, 24)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt(undefined)', pi(und), pi(und, 36));
console.log('parseInt(0.000001)', pi(0.000001), pi(0.0000001), pi(1 / 1999999)); // wtfjs: `parseInt` is a bad guy
console.log('parseInt(true, 36)', pi(true, 36), pi([12, 3]), pi(both));
console.log('parseInt(15, 2)', pi(15, 2), pi(-0), pi(1e21));
const tiny: any = 0.0000001;
console.log('parseInt(tiny)', parseInt(tiny), parseInt(tiny, 10));
const nx: any = 'x';
console.log('Number.isNaN', Number.isNaN(nx), Number.isNaN(NaN), Number.isNaN(und), Number.isNaN(nul), Number.isNaN('NaN' as any));
console.log('Number.isFinite', Number.isFinite('1' as any), Number.isInteger('1' as any), Number.isSafeInteger('1' as any));
console.log('big literals', 123456789012345680000, -123456789012345680000, 9223372036854775807, 18446744073709551616, String(123456789012345680000));
const b: number = 123456789012345680000;
console.log('big typed', b, b + 1, 2e64);
console.log('1.1 == Number(true)', 1.1 == Number(true), 1 == Number(true), Number(true) === 1); // wtfjs: Non-strict comparison of a number to `true`
const lit = 'abc' as const;
console.log('isNaN("abc")', isNaN(lit as any), isNaN('12' as any));
