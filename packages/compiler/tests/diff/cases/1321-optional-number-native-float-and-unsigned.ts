// @plugin
// @swift ledger:nativeSdk
// A plugin's number that may be undefined passed where a native API takes a Float, an unsigned 32-bit integer or a 64-bit one.
import { float, unsigned, wide } from './helpers/plugin/native-numbers.ts';

console.log(float(1.1), float(), float(3), float(1e40));
console.log(unsigned(70000.7), unsigned(), unsigned(5e9), unsigned(-3));
console.log(wide({ n: -2.5 }), wide({}), wide({ n: 2 ** 53 }));
