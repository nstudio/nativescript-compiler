// @plugin-both
// A plugin gives another module's singleton a method its `declare module` augmentation declares on the class, by
// `Object.defineProperty` on the instance its factory returns; the app calls it through the factory.
import { hub } from './helpers/plugin/hub-core.ts';
import { Mail } from './helpers/plugin/hub-mail.ts';

const m = hub().mail();
console.log(m instanceof Mail, m.send('a'), hub().mail().send('b'), hub().mail() === m);
console.log(hub().app(), m.sent.join(','));
