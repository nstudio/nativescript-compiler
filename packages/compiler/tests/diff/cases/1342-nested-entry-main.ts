// A secondary entry whose package.json names only `main`.
// @packages ns-fixture-sheet/legacy=ns-fixture-sheet/legacy/lib/legacy.js
import { count, entry } from 'ns-fixture-sheet/legacy';

console.log(entry);
console.log(count(2, 5).join(','));
