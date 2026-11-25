// @plugin-both
// A plugin compiled from source whose declarations beside it (`index.d.ts`) type its classes: the app reads their
// fields through a chain.
import type { Offer } from './helpers/plugin/shelf/index';
import { Shelf } from './helpers/plugin/shelf/index.ios.ts';

function main() {
  const offers: Offer[] = Shelf.all();
  const some = offers.find((o) => o.id === 'a');
  const none = offers.find((o) => o.id === 'b');
  if (some?.packs?.length) console.log('some', some.packs.length);
  if (!none?.packs?.length) console.log('none empty');
  console.log(offers.find((o) => o.id === 'z')?.packs?.length ?? -1);
  const own = Shelf.all();
  const first = own.find((o) => o.id === 'a');
  if (first?.packs?.length) console.log('first', first.packs.length);
  console.log(own.find((o) => o.id === 'z')?.packs?.length ?? -1);
}
main();
