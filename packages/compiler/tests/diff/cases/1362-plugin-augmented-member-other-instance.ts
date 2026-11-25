// @plugin-both
// A method a plugin defines on one instance only (`Object.defineProperty` on the singleton its factory returns) is
// absent from the class's other instances: undefined when read, a TypeError when called, and undefined through `?.()`.
import { Hub, hub } from './helpers/plugin/hub-core.ts';
import './helpers/plugin/hub-mail.ts';

const other = new Hub('other');
console.log(typeof hub().mail, typeof other.mail, other.mail?.() === undefined);
try {
  other.mail();
  console.log('called');
} catch (e) {
  console.log(e instanceof TypeError);
}

console.log(hub().mail().send('x'));
