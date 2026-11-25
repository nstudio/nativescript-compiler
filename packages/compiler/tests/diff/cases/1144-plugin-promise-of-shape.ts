// @plugin-both
// An app awaiting a plugin method whose promise settles with an object of a type literal's shape (an override of an
// abstract method), and chaining on it, as an app does with @nativescript/imagepicker's `authorize()`; the plugin maps
// an array with its top-level arrow into `Promise.all(…).then(…)`, as @nativescript-community/perms does.
import { Asker, askAll } from './helpers/plugin/ask.ts';

async function main() {
  const a = new Asker(['camera', 'photo']);
  const r = await a.authorize();
  console.log(r.authorized, r.details.join(','));
  await new Asker(['video'])
    .authorize()
    .then((res) => console.log(res.authorized, res.details.length))
    .then(() => a.authorize())
    .then((res) => console.log(res.authorized));
  console.log((await askAll(['x', 'y'])).join(','));
}
main();
