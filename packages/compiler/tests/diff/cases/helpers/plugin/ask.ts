import { AskerBase } from './asker-common.ts';

const store = {};
const setDidAskOnce = (permission: string) => Promise.resolve().then(() => (store['asked_' + permission] = true));

export function askAll(permissions: string[]) {
  if (permissions.length > 1) return Promise.all(permissions.map(setDidAskOnce)).then(() => Object.keys(store));
  return setDidAskOnce(permissions[0]).then(() => Object.keys(store));
}

export class Asker extends AskerBase {
  constructor(private kinds: string[]) {
    super();
  }
  authorize() {
    if (this.kinds.length > 1) return askAll(this.kinds).then((keys) => this.mapResult(keys));
    return Promise.resolve(this.mapResult(this.kinds));
  }
}
