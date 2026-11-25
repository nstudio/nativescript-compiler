// @plugin-both
// A plugin's async function typed to give an object that gives null where nothing is found: the awaited value is null.
import { lookup } from './helpers/plugin/lookup.ts';

async function main() {
  const missing = await lookup('a');
  console.log(missing === null, missing === undefined, typeof missing);
  console.log((await lookup('abc')).name);
}
main();
