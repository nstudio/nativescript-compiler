// @plugin-both
// A plugin's plain function resolving its promise of an object with null: awaiting it gives null, as in the app's own.
import { chooseEntry } from './helpers/plugin/chooser.ts';

async function main() {
  const a = await chooseEntry('');
  console.log(a === null, a === undefined);
  const b = await chooseEntry('/x');
  console.log(b.path);
}
main();
