// @app-lenient
// @refused `new` of a function is not supported in a release build yet
// A non-strict app constructing a plain function, which script runs as a constructor (its `this` a new object).
function Point(x: number, y: number) {
  console.log('constructing', x, y);
}
const p = new Point(1, 2);
console.log(typeof p, p instanceof Point);
