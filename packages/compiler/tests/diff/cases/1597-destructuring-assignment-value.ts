// @app-lenient
// @cli-program
// A destructuring assignment used as a value is the value assigned from; a target past the list's end is undefined.
var x, y, z;
var result;
var vals = [1, 2, 3];
result = [x, ...y] = vals;
console.log(x, y, result === vals);
result = [, ...z] = vals;
console.log(z, result === vals);
result = [, , x, ...y] = vals;
console.log(x, y);
var a, b;
var nulls = [null];
[a, b] = nulls;
console.log(a, b, a === null, b === undefined);
