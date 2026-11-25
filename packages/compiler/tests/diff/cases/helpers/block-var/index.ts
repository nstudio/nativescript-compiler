// A module-level `var` redeclared in a nested block, of a name the importing case declares too.
var total = 1;
if (total > 0) {
  var total = total + 100;
}
export function helperTotal() {
  return total;
}
var seen = 'helper';
export function helperSeen() {
  return seen;
}
if (seen.length > 0) {
  var mark = 'helper-block';
} else {
  var mark = 'helper-other';
}
for (let i = 0; i < 2; i++) {
  var mark = mark + i;
}
export function helperMark() {
  return mark;
}
