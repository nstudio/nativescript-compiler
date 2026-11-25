// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): `arguments` in a function expression.
// @refused `arguments` of a function expression is not supported
const args: any = function () { // wtfjs: `arguments` and arrow functions
  return arguments;
};
console.log('(function () { return arguments })("a")', args('a')); // wtfjs: `arguments` and arrow functions
console.log('arguments length', args('a', 'b').length, args().length, typeof args('a'), Array.isArray(args('a')));
