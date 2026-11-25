// @plugin
// @swift ledger:nativeSdk
// A plugin's number that may be undefined, a fraction or past the range, typed or untyped, set where a native API takes
// an integer: as the runtime converts it.
import { limit, untypedLimit } from './helpers/plugin/native-numbers.ts';

const q = NSOperationQueue.new();
const seen = [limit(q, { limit: 3 }), limit(q, {}), limit(q, { limit: 2.9 }), limit(q, { limit: 1e20 }), limit(q, { limit: -1 })];
const untyped = [untypedLimit(q, { limit: '7.5' }), untypedLimit(q, {}), untypedLimit(q, { limit: 'x' }), untypedLimit(q, { limit: 4 })];
console.log(seen.join(' '), untyped.join(' '));
