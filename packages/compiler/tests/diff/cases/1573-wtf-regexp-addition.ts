// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): RegExp.prototype.toString replaced, and the division that follows the assignment.
const patch: any = RegExp.prototype; // wtfjs: Addition of RegExps
patch.toString = (function (this: RegExp) { // wtfjs: Addition of RegExps
  return this.source;
} as any) /
  7 /
  -(/5/ as any);
console.log('patched toString', patch.toString); // wtfjs: Addition of RegExps
