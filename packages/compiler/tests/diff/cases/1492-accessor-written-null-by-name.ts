// @app-lenient
class Item {
  constructor(public name: string) {}
}
class Holder {
  private _item: Item = new Item('a');
  get item(): Item {
    return this._item;
  }
  set item(v: Item) {
    console.log('set', v === null, v === undefined);
    this._item = v;
  }
}
const h = new Holder();
console.log(h.item.name);
h.item = null;
console.log(h.item === null, h.item === undefined);
h.item = undefined;
console.log(h.item === null, h.item === undefined);
h.item = new Item('b');
console.log(h.item.name);
const any: any = h;
any.item = null;
console.log(h.item === null, h.item === undefined);
class Box {
  item: Item = new Item('x');
}
const b = new Box();
const ab: any = b;
ab.item = null;
console.log(b.item === null, b.item === undefined);
b['item'] = undefined;
console.log(b.item === null, b.item === undefined);
b['item'] = null;
console.log(b.item === null, b.item === undefined);
h['item'] = undefined;
console.log(h.item === null, h.item === undefined);
