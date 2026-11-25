// A module's `var` a `for` head declares, at the module's level or in a nested block, is the module's one variable:
// a function declared before it reads it, a later head and a branch declare it again, and a labelled block's
// redeclaration after its `break` never runs. A function's `for` head `var` is read after its loop.
function readT() {
  return t;
}
for (var t = 0; t < 2; t++) {}
for (var t = 5; t < 7; t++) {}
console.log(readT(), t);
{
  for (var q = 0; q < 2; q++) {}
}
console.log(q);
const flag = Math.random() >= 0;
if (flag) {
  var label = 'yes';
} else {
  var label = 'no';
}
const readLabel = () => label;
console.log(readLabel());
var s = 'a';
if (flag) {
  var s = s + 'b';
} else {
  var s = 'c';
}
console.log(s);
var lb = 1;
outer: {
  var lb = lb + 1;
  if (flag) break outer;
  var lb = 100;
}
console.log(lb);
function fn(start: number) {
  var m = start;
  for (var i = 0; i < 2; i++) {
    var m = m + i;
  }
  return [m, i];
}
console.log(fn(2).join(), fn(0).join());
