// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a named generator function expression that yields itself.
// @refused a named function expression is not supported in a release build yet
const gen: any = function* f(): any { // wtfjs: A generator which yields itself
  yield f;
};
const step = gen().next(); // wtfjs: A generator which yields itself
console.log('generator yields itself', step.done, step.value === gen, typeof step.value); // wtfjs: A generator which yields itself
console.log('and again', step.value().next().value().next().value === gen); // wtfjs: A generator which yields itself
