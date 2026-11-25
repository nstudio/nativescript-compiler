// The prototype calls a build runs as JavaScript does, beside those it refuses: a built-in's method on a value of its
// own type, a library function whose `this` is unused, and a base class's method called through its prototype on `this`.
const padded = '  trimmed  ';
const amount = 3.14159;
console.log(`[${String.prototype.trim.call(padded)}]`, Number.prototype.toFixed.call(amount, 2));
const values = [4, 9, 2];
console.log(Math.max.apply(null, values), String.fromCharCode.apply(null, [72, 105]));
class Shape {
  describe(): string {
    return 'shape';
  }
}
class Square extends Shape {
  describe(): string {
    return `square, a ${Shape.prototype.describe.call(this)}`;
  }
}
console.log(new Square().describe());
