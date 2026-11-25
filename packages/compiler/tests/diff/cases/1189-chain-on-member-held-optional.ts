// @plugin-both
// `?.` after a plugin class's field TypeScript types present but the plugin's code holds as it may be undefined:
// read through a chain from the app, and as a chain's head inside the plugin.
import { Offer, Board } from './helpers/plugin/offers.ts';

class Account {
  current: Offer | null = null;
}

const offers = [new Offer('a', 2), new Offer('b', 0)];
const some = offers.find((o) => o.id === 'a');
const none = offers.find((o) => o.id === 'b');
const missing = offers.find((o) => o.id === 'z');
if (some?.packages?.length) console.log('some', some.packages.length);
if (!none?.packages?.length) console.log('none empty');
console.log(missing?.packages?.length ?? -1);
const account = new Account();
console.log((account.current?.packages?.length ?? 0) > 0);
account.current = some;
console.log((account.current?.packages?.length ?? 0) > 0);
const board = new Board();
board.mark(some.packages);
console.log(board.first());
