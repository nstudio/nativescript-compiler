// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a number's prototype chain read through `__proto__`.
// @refused `__proto__` is not supported in a release build
const one: any = 1;
console.log('(1).__proto__.__proto__.__proto__', one.__proto__.__proto__.__proto__); // wtfjs: Accessing prototypes with `__proto__`
