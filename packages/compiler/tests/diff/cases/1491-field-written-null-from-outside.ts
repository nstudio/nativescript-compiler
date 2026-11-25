// @app-lenient
class Item {
  constructor(public name: string) {}
}
class Inside {
  item: Item = new Item('i');
  clear() { this.item = null; }
}
const a = new Inside();
a.clear();
console.log(a.item === null, a.item === undefined);
class Plain {
  item: Item = new Item('p');
}
const p = new Plain();
p.item = null;
console.log(p.item === null, p.item === undefined);
p.item = undefined;
console.log(p.item === null, p.item === undefined);
