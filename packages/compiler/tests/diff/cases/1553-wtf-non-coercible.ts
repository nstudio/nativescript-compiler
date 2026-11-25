// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): an object whose Symbol.toPrimitive throws, and Symbol.toPrimitive and valueOf on objects.
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, e instanceof TypeError ? `TypeError: ${(e as Error).message}` : 'other');
  }
}
// `Object(val)` as the refusal catalog rewrites it (object-call), which holds for objects; strings and numbers are 1571's.
function nonCoercible(val: any): any {
  if (val == null) {
    throw TypeError('nonCoercible should not be called with null or undefined');
  }
  const res = typeof val === 'object' && val !== null ? val : {};
  res[Symbol.toPrimitive] = () => {
    throw TypeError('Trying to coerce non-coercible object');
  };
  return res;
}
const foo = nonCoercible({ foo: 'foo' }); // wtfjs: Non-coercible objects
attempt('foo * 10', () => foo * 10); // wtfjs: Non-coercible objects
attempt('foo + "evil"', () => foo + 'evil'); // wtfjs: Non-coercible objects
attempt('nonCoercible(null)', () => nonCoercible(null));
const prim: any = { [Symbol.toPrimitive]: (hint: string) => (hint === 'number' ? 42 : hint) };
console.log('toPrimitive hints', +prim, `${prim}`, prim + '', prim * 1);
