// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): an arrow function taking a rest parameter, held untyped and called.
const rest: any = (...xs: any[]) => xs;
console.log('((...args) => args)("a")', rest('a')); // wtfjs: `arguments` and arrow functions
