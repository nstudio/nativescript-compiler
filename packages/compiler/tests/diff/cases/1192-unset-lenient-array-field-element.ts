// @plugin-both
// An element's field read through `?.` from an array of untyped elements, with a fallback for undefined: a
// plugin's field never set, then set, read by the plugin's own code and by the app.
import { Board } from './helpers/plugin/offers.ts';

const board = new Board();
console.log(board.first());
console.log(board.marked?.[0]?.name ?? 'unset');
board.mark([{ name: 'x' }]);
console.log(board.first(), board.marked?.[0]?.name ?? 'unset');
