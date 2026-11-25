// @plugin-both
// A plugin class's field its code holds as it may be undefined, read through `?.` links and a `?.` call head by an
// app's async method.
import { Shelf } from './helpers/plugin/shelf/index.ios.ts';

class Store {
  count = 0;
  async load(id: string) {
    const all = await Shelf.fetch();
    const offer = all.find((o) => o.id === id);
    const n = offer?.packs?.length;
    console.log(n ?? -1, (offer?.packs?.length ?? 0) > 0);
    console.log(offer ? offer.packs?.find((p) => p.name.endsWith('1'))?.name ?? 'no match' : 'no offer');
    if (offer?.packs?.length) {
      this.count = offer.packs.length;
      console.log('packs', this.count, offer.packs?.map((p) => p.name).join(','));
    } else console.log('none', id);
  }
}

const store = new Store();
store.load('a').then(() => store.load('b')).then(() => store.load('z'));
