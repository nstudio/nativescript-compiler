// @refused a wrapper object (new Number) is not supported in a release build yet
// A wrapper object is an object: typeof is "object", it is truthy even wrapping false, and it is no primitive it equals.
const n = new Number(5);
const b = new Boolean(false);
console.log(typeof n, n === 5, n == 5, b ? 'truthy' : 'falsy');
