// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): null held untyped, tested with instanceof Object.
const nul: any = null;
console.log('null instanceof Object', nul instanceof Object); // wtfjs: `[]` and `null` are objects
