// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): how numbers print, round and lose precision.
const big: any = 10000000000000000;
const a: any = 0.1;
const b: any = 0.2;
console.log('999999999999999', 999999999999999); // wtfjs: Magically increasing numbers
console.log('9999999999999999', 9999999999999999); // wtfjs: Magically increasing numbers
console.log('10000000000000000', big); // wtfjs: Magically increasing numbers
console.log('10000000000000000 + 1', big + 1); // wtfjs: Magically increasing numbers
console.log('10000000000000000 + 1.1', big + 1.1); // wtfjs: Magically increasing numbers
console.log('0.1 + 0.2', a + b); // wtfjs: Precision of `0.1 + 0.2`
console.log('0.1 + 0.2 === 0.3', a + b === 0.3); // wtfjs: Precision of `0.1 + 0.2`
console.log('(0.7875).toFixed(3)', (0.7875 as any).toFixed(3)); // wtfjs: `Number.toFixed()` display different numbers
console.log('(0.7876).toFixed(3)', (0.7876 as any).toFixed(3)); // wtfjs: `Number.toFixed()` display different numbers
console.log('(0.7875).toFixed(14)', (0.7875 as any).toFixed(14)); // wtfjs: `Number.toFixed()` display different numbers
console.log('(0.7875).toFixed(20)', (0.7875 as any).toFixed(20)); // wtfjs: `Number.toFixed()` display different numbers
console.log('27..toString()', 27..toString(), (27).toString()); // wtfjs: Double dot
console.log('1e21, 1e-7', 1e21, 1e-7, String(123456789012345680000), String(0.000001));
console.log('2**53 + 1', 2 ** 53 + 1, Number.MAX_SAFE_INTEGER + 2);
console.log('(1.005).toFixed(2)', (1.005 as any).toFixed(2), (1.45 as any).toFixed(1), (2.5 as any).toFixed(0));
console.log('0.1 * 3', a * 3, b * 3);

// Statically typed.
const x: number = 0.1;
const y: number = 0.2;
const n: number = 10000000000000000;
const v: number = 0.7875;
console.log('typed 0.1 + 0.2', x + y, x + y === 0.3); // wtfjs: Precision of `0.1 + 0.2`
console.log('typed 10000000000000000 + 1', n + 1, n + 1.1); // wtfjs: Magically increasing numbers
console.log('typed toFixed', v.toFixed(3), (0.7876).toFixed(3), v.toFixed(14), v.toFixed(20)); // wtfjs: `Number.toFixed()` display different numbers
console.log('typed print', `${n}`, String(n * 100000), (n * 100000).toString(), 1 / 3, 2 / 3, 100 / 3);
console.log('typed toString radix', (255).toString(16), (0.5).toString(2), (-7).toString(2));
console.log('typed toPrecision', (123.456).toPrecision(4), (0.00001234).toPrecision(2), (1e21).toPrecision(3));
console.log('typed exponential', (123456).toExponential(2), (0).toExponential());
