// A module-level `var` declared twice is one variable of its module, where another module declares the same name too:
// the second declaration assigns the module's own variable, whichever module keeps the plain name.
import { bumpHelper, helperCount } from './helpers/redeclared/index.ts';
var count = 1;
var count = 2;
function bump() {
  count += 100;
}
bumpHelper();
bump();
console.log(count, helperCount());
