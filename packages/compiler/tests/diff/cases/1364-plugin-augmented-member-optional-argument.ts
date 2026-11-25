// @plugin-both
// A method a plugin defines on a singleton with an optional parameter (one object per owner, a default without), whose
// result's promise the app awaits.
import { Hub, hub } from './helpers/plugin/hub-core.ts';
import { Config } from './helpers/plugin/hub-config.ts';

async function main() {
  const fb = hub();
  const d = fb.config();
  const other = new Hub('other');
  console.log(d instanceof Config, d.owner, fb.config() === d, fb.config(other).owner, fb.config(other) === fb.config(other));
  console.log(await fb.config().fetch('k'), await fb.config(other).fetch('j'));
}
main();
