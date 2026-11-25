// A module's `var` declared again with a value in a nested block (a plain block, a branch, a loop body, try, catch and
// finally, a switch case, a `for` head) is the module's one variable, assigned there and read by its closures; a
// function's likewise.
var n = 10;
{
  var n = n + 5;
}
console.log(n);
var a = 1;
if (a > 0) {
  var a = a * 3;
}
console.log(a);
var b = 0;
for (let i = 0; i < 3; i++) {
  var b = b + i;
}
console.log(b);
var c = 'x';
try {
  var c = c + 'y';
  throw new Error('e');
} catch (e) {
  var c = c + 'z';
} finally {
  var c = c + 'w';
}
console.log(c);
var d = 2;
switch (d) {
  case 2:
    var d = d * 10;
    break;
}
console.log(d);
var e = 1;
{
  if (true) {
    var e = e + 1;
  }
}
console.log(e);
var g = 7;
const readG = () => g;
console.log(readG());
{
  console.log(g);
  var g = 70;
}
console.log(g, readG());
function f() {
  var h = 3;
  const get = () => h;
  {
    var h = h + 4;
  }
  if (h > 0) {
    var h = h * 2;
  }
  return [h, get()];
}
console.log(f());
var k = 5;
for (var k = 0; k < 3; k++) {}
console.log(k);
