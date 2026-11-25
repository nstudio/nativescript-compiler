// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a class extending null.
// @refused extending null is not supported in a release build yet
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, e instanceof TypeError ? 'TypeError' : 'other');
  }
}
class Foo extends null {} // wtfjs: function is not a function
console.log('class Foo extends null', typeof Foo); // wtfjs: function is not a function
console.log('Object.getPrototypeOf(Foo.prototype)', Object.getPrototypeOf(Foo.prototype)); // wtfjs: function is not a function
attempt('new Foo()', () => new Foo()); // wtfjs: function is not a function
const nul: any = null;
attempt('x instanceof null', () => ({}) instanceof nul); // wtfjs: function is not a function
