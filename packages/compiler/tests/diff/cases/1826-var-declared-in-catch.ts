// A `var` declared in a catch block, with or without a value, is its module's or function's, read after the block.
const o = { foo: 42 };
try {
  throw o;
} catch (e) {
  var foo: number | undefined;
  var bar = 2;
}
console.log(foo, bar);
function f() {
  try {
    throw 1;
  } catch {
    var inner: string | undefined = 'in';
  }
  return inner;
}
console.log(f());
