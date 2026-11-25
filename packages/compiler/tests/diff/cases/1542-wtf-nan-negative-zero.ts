// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): NaN, Object.is, -0 and the edges of the number line.
const nan: any = NaN;
const z: any = 0;
const nz: any = -0;
console.log('NaN === NaN', nan === nan); // wtfjs: `NaN` is not a `NaN`
console.log('NaN == NaN', nan == nan);
console.log('Object.is(NaN, NaN)', Object.is(nan, nan)); // wtfjs: `Object.is()` and `===` weird cases
console.log('Object.is(-0, 0)', Object.is(nz, z)); // wtfjs: `Object.is()` and `===` weird cases
console.log('-0 === 0', nz === z); // wtfjs: `Object.is()` and `===` weird cases
console.log('Object.is(NaN, 0 / 0)', Object.is(nan, z / z)); // wtfjs: `Object.is()` and `===` weird cases
console.log('NaN === 0 / 0', nan === z / z); // wtfjs: `Object.is()` and `===` weird cases
console.log('typeof NaN', typeof nan); // wtfjs: `NaN` is ~~not~~ a number
console.log('-0', nz, String(nz), `${nz}`, JSON.stringify(nz), [nz].join());
console.log('1 / -0', 1 / nz);
console.log('Number.MIN_VALUE > 0', Number.MIN_VALUE > 0); // wtfjs: Minimal value is greater than zero
console.log('Number.MIN_VALUE', Number.MIN_VALUE);
console.log('Math.min() > Math.max()', Math.min() > Math.max()); // wtfjs: `Math.max()` less than `Math.min()`
console.log('Math.min() < Math.max()', Math.min() < Math.max()); // wtfjs: `Math.max()` less than `Math.min()`
console.log('Math.min(), Math.max()', Math.min(), Math.max()); // wtfjs: `Math.max()` less than `Math.min()`
console.log('Infinity > -Infinity', Infinity > -Infinity); // wtfjs: `Math.max()` less than `Math.min()`
console.log('[NaN].includes(NaN)', [nan].includes(nan), [nan].indexOf(nan));
console.log('isNaN("x"), Number.isNaN("x")', isNaN(('x' as any)), Number.isNaN('x'));

// Statically typed.
const n: number = NaN;
const zero: number = 0;
const negZero: number = -0;
console.log('typed NaN === NaN', n === n); // wtfjs: `NaN` is not a `NaN`
console.log('typed NaN !== NaN', n !== n);
console.log('typed Object.is(NaN, NaN)', Object.is(n, n)); // wtfjs: `Object.is()` and `===` weird cases
console.log('typed Object.is(-0, 0)', Object.is(negZero, zero)); // wtfjs: `Object.is()` and `===` weird cases
console.log('typed -0 === 0', negZero === zero); // wtfjs: `Object.is()` and `===` weird cases
console.log('typed 0 / 0', zero / zero, Object.is(n, zero / zero));
console.log('typed -0 prints', negZero, String(negZero), negZero.toString(), negZero.toFixed(1));
console.log('typed 1 / -0', 1 / negZero, -zero, Object.is(-zero, negZero));
console.log('typed Math.min() > Math.max()', Math.min() > Math.max()); // wtfjs: `Math.max()` less than `Math.min()`
console.log('typed [NaN].includes(NaN)', [n].includes(n), [n].indexOf(n));
console.log('typed Math.round(-0.4)', Object.is(Math.round(-0.4), -0), Math.sign(negZero));
