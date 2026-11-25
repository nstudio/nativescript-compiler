// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a tagged template whose tag is held untyped.
function f(...args: any[]) {
  return args;
}
const tag: any = f;
console.log('f`...`', tag`true is ${true}, false is ${false}, array is ${[1, 2, 3]}`); // wtfjs: Calling functions with backticks
