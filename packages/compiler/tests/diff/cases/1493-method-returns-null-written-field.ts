// @app-lenient
class Item {
  constructor(public name: string) {}
}
class Holder {
  private _item: Item = new Item('a');
  getItem(): Item {
    return this._item;
  }
  setItem(v: Item) {
    console.log('set', v === null, v === undefined);
    this._item = v;
  }
}
const h = new Holder();
h.setItem(null);
console.log(h.getItem() === null, h.getItem() === undefined);
h.setItem(undefined);
console.log(h.getItem() === null, h.getItem() === undefined);
function take(x: Item): string {
  return x === null ? 'null' : x === undefined ? 'undef' : x.name;
}
console.log(take(null), take(undefined));
class Wrapper {
  constructor(private h: Holder) {}
  item(): Item {
    return this.h.getItem();
  }
}
h.setItem(new Item('c'));
console.log(h.getItem().name);
const w = new Wrapper(h);
console.log(w.item().name);
h.setItem(null);
console.log(w.item() === null, w.item() === undefined);
