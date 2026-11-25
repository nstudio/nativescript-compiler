// @plugin-both
// A plugin's local copied from a field its code holds as it may be missing, read as a chain's head with a member and
// a call after it, then used past an `&&` that tested it.
import { Axis, Port } from './helpers/plugin/viewport.ts';

console.log(new Axis(new Port(100)).wide());
console.log(new Axis(new Port(20)).wide());
console.log(new Axis(new Port(5)).wide());
console.log(new Axis().wide());
