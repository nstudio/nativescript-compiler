// An untyped object placed in a typed slot is the same object: a kept reference compares equal to it, finds it in
// an array and keys a Map and a Set by it.
interface Item {
  id: number;
  name: string;
}

class Registry {
  items: Item[] = [];
  current: Item | null = null;
  byItem = new Map<Item, string>();
  seen = new Set<Item>();

  add(item: Item) {
    this.items.push(item);
    this.current = item;
    this.byItem.set(item, 'tag-' + item.id);
    this.seen.add(item);
  }

  isCurrent(item: Item): boolean {
    return this.current === item;
  }
}

const raw: any = JSON.parse('{"id": 1, "name": "one"}');
const other: any = JSON.parse('{"id": 1, "name": "one"}');
const reg = new Registry();
reg.add(raw);
console.log(reg.isCurrent(raw), reg.isCurrent(other));
console.log(reg.current === raw, reg.items[0] === raw);
console.log(reg.items.indexOf(raw), reg.items.indexOf(other), reg.items.includes(raw));
console.log(reg.byItem.get(raw), reg.byItem.get(other), reg.seen.has(raw), reg.seen.has(other));

const typed: Item = raw;
console.log(typed === raw, Object.is(typed, raw), [raw].indexOf(typed));

interface Keyed {
  id: number;
}
function sameEntry(k: Keyed, item: Item): boolean {
  return k === item;
}
console.log(sameEntry(raw, raw), sameEntry(raw, other), sameEntry(reg.current!, typed));
