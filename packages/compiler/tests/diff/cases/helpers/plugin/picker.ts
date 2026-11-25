import { PickerBase } from './picker-common.ts';

const store = {};
const setDidAskOnce = (permission: string) => Promise.resolve().then(() => (store['asked_' + permission] = true));

export function askOnce(permissions: string[]) {
  return setDidAskOnce(permissions[0]).then(() => Object.keys(store));
}

export class Picker extends PickerBase {
  constructor(private mediaType: string) {
    super();
  }
  authorize() {
    let requested: { [key: string]: { reason: string } } = {};
    const mediaPerms = { photo: { reason: 'photos' }, video: { reason: 'videos' } };
    if (this.mediaType === 'image') requested['photo'] = mediaPerms['photo'];
    else requested = mediaPerms;
    return Promise.resolve(this.mapResult(Object.keys(requested).length > 1 ? 'authorized' : 'limited'));
  }
  present() {
    return askOnce([this.mediaType]);
  }
}
