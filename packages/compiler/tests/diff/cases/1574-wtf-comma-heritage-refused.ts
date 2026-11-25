// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a comma expression as a class's heritage, which extends its last operand.
// @refused extending (bases.push(String), Array) is not supported
const bases: unknown[] = [];
class F extends (bases.push(String), Array) {} // wtfjs: Is this multiple inheritance?
const f = new F(); // wtfjs: Is this multiple inheritance?
console.log('new F()', f, f instanceof Array, bases.length); // wtfjs: Is this multiple inheritance?
