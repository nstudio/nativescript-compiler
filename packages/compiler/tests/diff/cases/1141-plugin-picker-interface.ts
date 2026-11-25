// @plugin-both
// A plugin's abstract class implementing an interface only its types name, a top-level arrow typed by its parameter
// called with an element that may be undefined, and an object of a known shape assigned to a dictionary variable,
// as @nativescript/imagepicker and @nativescript-community/perms do.
import { Picker, askOnce } from './helpers/plugin/picker.ts';

async function main() {
  for (const type of ['image', 'any']) {
    const p = new Picker(type);
    console.log(await p.authorize());
    console.log((await p.present()).join(','));
  }
  console.log((await askOnce([])).join(','));
}
main();
