// A module's `var` declared only in its nested blocks is the module's one variable, read after its blocks and by its
// functions, however many blocks declare it again, and kept apart from another module's variable of the name (one
// declared only in that module's blocks too).
import { helperMark, helperSeen } from './helpers/block-var/index.ts';
var ready = Math.random() >= 0;
if (ready) {
  var seen = 1;
} else {
  var seen = -1;
}
for (let i = 0; i < 3; i++) {
  var seen = seen + 10;
}
function readSeen() {
  return seen;
}
console.log(seen, readSeen(), helperSeen());
switch (seen) {
  case 31:
    var label: string | undefined = 'thirty-one';
    break;
}
console.log(label);
var mark = 'module';
{
  var mark = mark + '+block';
}
console.log(mark, helperMark());
