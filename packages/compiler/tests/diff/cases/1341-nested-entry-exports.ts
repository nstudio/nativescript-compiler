// A secondary entry whose package.json has both `exports` and `module`: the file `exports['.']` names is the one loaded.
// @packages ns-fixture-sheet/exported=ns-fixture-sheet/exported/esm/exported.mjs
import { entry, pick } from 'ns-fixture-sheet/exported';

console.log(entry);
console.log(pick(['a', 'tile', 'sheet', 'xy']));
