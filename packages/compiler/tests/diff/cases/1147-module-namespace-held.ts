// An object of a module namespace's members (a function and a class) kept in a module constant, as a page registry keeps
// its code-behind: a field named as its class, read by name and called, and the class constructed through it.
import * as code from './helpers/touch-page.ts';

const registry = { navigatingTo: code.navigatingTo, TouchAnimationsModel: code.TouchAnimationsModel };

console.log(registry.navigatingTo('list'));
const model = new registry.TouchAnimationsModel();
model.tap();
console.log(model.tap(), model instanceof code.TouchAnimationsModel, typeof registry.TouchAnimationsModel);
console.log(Object.keys(registry).join(','));
