// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): typeof, instanceof, null and primitive wrappers.
const arr: any = [];
const nul: any = null;
const str: any = 'str';
const one: any = 1;
console.log('typeof []', typeof arr); // wtfjs: `[]` and `null` are objects
console.log('typeof null', typeof nul); // wtfjs: `[]` and `null` are objects
console.log('typeof null === "object"', typeof nul === 'object'); // wtfjs: `[]` and `null` are objects
console.log('toString.call([])', Object.prototype.toString.call(arr)); // wtfjs: `[]` and `null` are objects
console.log('toString.call(new Date())', Object.prototype.toString.call(new Date())); // wtfjs: `[]` and `null` are objects
console.log('toString.call(null)', Object.prototype.toString.call(nul)); // wtfjs: `[]` and `null` are objects
console.log('toString.call(undefined, 1, "s")', Object.prototype.toString.call(undefined), Object.prototype.toString.call(one), Object.prototype.toString.call(str));
console.log('typeof "str"', typeof str); // wtfjs: Strings aren't instances of `String`
console.log('"str" instanceof String', str instanceof String); // wtfjs: Strings aren't instances of `String`
console.log('typeof function', typeof function () {}, typeof Symbol(), typeof 1n);

// Statically typed.
const xs: number[] = [];
const s: string = 'str';
const maybe: object | null = null;
console.log('typed typeof []', typeof xs, Array.isArray(xs)); // wtfjs: `[]` and `null` are objects
console.log('typed typeof null', typeof maybe, maybe === null); // wtfjs: `[]` and `null` are objects
console.log('typed toString.call', Object.prototype.toString.call(xs), Object.prototype.toString.call(maybe)); // wtfjs: `[]` and `null` are objects
console.log('typed Object.getPrototypeOf(Object.prototype)', Object.getPrototypeOf(Object.prototype));
