// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): strings and numbers wrapped with Object() and given a Symbol.toPrimitive that throws.
// @refused Object() is not supported in a release build yet
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, e instanceof TypeError ? `TypeError: ${(e as Error).message}` : 'other');
  }
}
function nonCoercible(val: any): any { // wtfjs: Non-coercible objects
  if (val == null) {
    throw TypeError('nonCoercible should not be called with null or undefined');
  }
  const res = Object(val);
  res[Symbol.toPrimitive] = () => {
    throw TypeError('Trying to coerce non-coercible object');
  };
  return res;
}
const bar = nonCoercible('bar'); // wtfjs: Non-coercible objects
attempt('bar + "1"', () => bar + '1'); // wtfjs: Non-coercible objects
attempt('bar.toString() + 1', () => bar.toString() + 1); // wtfjs: Non-coercible objects
attempt('bar === "bar"', () => bar === 'bar'); // wtfjs: Non-coercible objects
attempt('bar.toString() === "bar"', () => bar.toString() === 'bar'); // wtfjs: Non-coercible objects
attempt('bar == "bar"', () => bar == 'bar'); // wtfjs: Non-coercible objects
const baz = nonCoercible(1); // wtfjs: Non-coercible objects
attempt('baz == 1', () => baz == 1); // wtfjs: Non-coercible objects
attempt('baz === 1', () => baz === 1); // wtfjs: Non-coercible objects
attempt('baz.valueOf() === 1', () => baz.valueOf() === 1); // wtfjs: Non-coercible objects
const s: string = 'str';
console.log('typed Object(s)', typeof Object(s), Object(s) instanceof String, Object(1) instanceof Number);
