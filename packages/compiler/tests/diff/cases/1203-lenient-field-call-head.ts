// @plugin-both
// A plugin's object fields, one never set, called through `?.` as a chain's head from the plugin's own method.
import { Field, Fields } from './helpers/plugin/viewport.ts';

console.log(new Fields(new Field()).wire());
console.log(new Fields().wire());
