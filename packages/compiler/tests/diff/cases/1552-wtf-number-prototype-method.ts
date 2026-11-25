// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a method added to Number.prototype, called on number literals.
// @refused Number.prototype is not supported in a release build yet
declare global {
  interface Number {
    isOne(): boolean;
  }
}
Number.prototype.isOne = function () { // wtfjs: Patching numbers
  return Number(this) === 1;
};
console.log('(1.0).isOne()', (1.0).isOne()); // wtfjs: Patching numbers
console.log('(1).isOne()', (1).isOne()); // wtfjs: Patching numbers
console.log('(2.0).isOne()', (2.0).isOne()); // wtfjs: Patching numbers
console.log('(7).isOne()', (7).isOne()); // wtfjs: Patching numbers
export {};
