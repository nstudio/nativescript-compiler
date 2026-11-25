// A module-level `var` declared twice, of a name the importing case declares too.
var count = 10;
var count = 20;
export function bumpHelper() {
  count += 1;
}
export function helperCount() {
  return count;
}
