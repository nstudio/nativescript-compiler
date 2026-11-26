// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): RegExp.prototype.toString replaced, and the division that follows the assignment.
// @refused RegExp.prototype is not supported in a release build yet
const patch: any = RegExp.prototype; // wtfjs: Addition of RegExps
patch.toString = (function (this: RegExp) { // wtfjs: Addition of RegExps
  return this.source;
} as any) /
  7 /
  -(/5/ as any);
console.log('patched toString', patch.toString); // wtfjs: Addition of RegExps
