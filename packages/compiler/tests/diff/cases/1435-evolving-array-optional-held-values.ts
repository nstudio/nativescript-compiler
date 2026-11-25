// @lenient-both
// Values an untyped `[]` stated as `T[]` is given that the program holds as optional (a callback's element, a record read) go in as the same `T`.
class Item {
  name: string;
  visible: boolean;
  constructor(name: string, visible: boolean) {
    this.name = name;
    this.visible = visible;
  }
}

class Bar {
  private _items: Array<Item> = [];
  add(item: Item): void {
    this._items.push(item);
  }
  visibleItems(): Array<Item> {
    const visible = [];
    this._items.forEach((item) => {
      if (item.visible) visible.push(item);
    });
    return visible;
  }
  reversedItems(): Array<Item> {
    const out = [];
    const n = this._items.length;
    this._items.forEach((item, i) => {
      out[n - 1 - i] = item;
    });
    return out;
  }
}

const bar = new Bar();
const a = new Item('a', true);
bar.add(a);
bar.add(new Item('b', false));
bar.add(new Item('c', true));
const shown = bar.visibleItems();
console.log(shown.length, shown[0] === a, shown.map((i) => i.name).join(','));
const back = bar.reversedItems();
console.log(back.length, back[2] === a, back.map((i) => i.name).join(','));

class Frame {
  at: number;
  label: string;
  constructor(at: number, label: string) {
    this.at = at;
    this.label = label;
  }
}
function ordered(byKey: { [key: string]: Frame }): Frame[] {
  const list = [];
  for (const k in byKey) list.push(byKey[k]);
  list.sort((x, y) => x.at - y.at);
  return list;
}
const frames: { [key: string]: Frame } = { late: new Frame(2, 'late'), early: new Frame(1, 'early') };
const sorted = ordered(frames);
console.log(sorted.map((f) => f.label).join(','), sorted[0] === frames.early);
