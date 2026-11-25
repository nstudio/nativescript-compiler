// A package shipping its TypeScript whose installed file was changed after its source map was written.
// @packages
// @refused is not the file its source map describes
import { Sheet } from 'ns-fixture-patched-main';

console.log(new Sheet('main').show('first'));
