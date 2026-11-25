// @app-lenient
class Item {
  constructor(public name: string) {}
}
class Card {
  note?: Item;
  tag?: string;
  width = 1;
}
const c = new Card();
c.note = null;
console.log(c.note === null, c.note === undefined, Object.keys(c).join(','));
c.note = undefined;
console.log(c.note === null, c.note === undefined);
c.note = new Item('n');
console.log(c.note.name);
c.tag = 't';
console.log(c.tag, Object.keys(c).join(','));
console.log(JSON.stringify(c));
