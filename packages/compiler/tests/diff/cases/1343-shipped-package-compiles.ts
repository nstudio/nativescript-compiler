// A package that ships its TypeScript, its file as its source map describes it: compiled from the source it ships.
// @packages
import { Sheet, describe } from 'ns-fixture-sheet';

const sheet = new Sheet('main');
console.log(sheet.show('first'));
console.log(sheet.show('second', true));
console.log(describe(sheet));
