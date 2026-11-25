// More of a module-level `var` redeclared in a nested block: the module's one variable wherever it is declared again
// (a labeled block, a while or do body, before the module's own statement), unchanged by a redeclaration without a value,
// and kept apart from another module's variable of the name.
import { helperTotal } from './helpers/block-var/index.ts';
var total = 2;
{
  var total = total * 3;
}
console.log(total, helperTotal());
var p = 1;
outer: {
  var p = p + 1;
  if (p > 1) break outer;
  p = 100;
}
console.log(p);
var w = 0;
while (w < 5) {
  var w = w + 2;
}
console.log(w);
var q = 1;
do {
  var q = q * 4;
} while (q < 10);
console.log(q);
var keep = 'kept';
{
  var keep: string;
}
console.log(keep);
{
  var later = 'block';
}
var later = later + '+module';
console.log(later);
var later2 = 'a';
const bumps: (() => void)[] = [];
for (let i = 0; i < 2; i++) {
  var later2 = later2 + 'x';
  bumps.push(() => {
    later2 = later2 + '!';
  });
}
bumps.forEach((f) => f());
console.log(later2);
