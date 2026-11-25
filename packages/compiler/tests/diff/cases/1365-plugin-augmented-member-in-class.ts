// @plugin-both
// A service class holding the plugin's singleton calls the members two plugins add to it from its methods, a field
// initializer and a callback, as an app's services do.
import { Hub, hub } from './helpers/plugin/hub-core.ts';
import { Mail } from './helpers/plugin/hub-mail.ts';
import './helpers/plugin/hub-mail.ts';
import { Config } from './helpers/plugin/hub-config.ts';
import './helpers/plugin/hub-config.ts';

class Service {
  private fb: Hub = hub();
  private mail: Mail = this.fb.mail();
  config(): Config {
    return this.fb.config();
  }
  sendAll(to: string[]) {
    return to.map((t) => this.fb.mail().send(t)).join(',');
  }
}

const s = new Service();
console.log(s.sendAll(['a', 'b']), s.config().owner, s['mail'] === hub().mail());
s.config().fetch('z').then((v) => console.log(v));
