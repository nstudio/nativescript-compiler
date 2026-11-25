// A plugin's generic classes whose members its type parameters type, read back through accessors with no annotation.
export class Item {
  constructor(public name: string, public weight: number) {}
}

export class HeavyItem extends Item {
  extra = 2;
}

export class Bag<T extends Item> {
  items: T[];
  constructor(items: T[]) {
    this.items = items;
  }
  get first() {
    return this.items[0];
  }
}

export class HeavyBag extends Bag<HeavyItem> {
  label = 'heavy';
}

export class Holder<U extends Item, T extends Bag<U>> {
  protected mBag: T = null;
  get bag() {
    return this.mBag;
  }
  set bag(b: T) {
    this.mBag = b;
  }
}

export class HeavyHolder extends Holder<HeavyItem, HeavyBag> {}

export class Reader {
  constructor(public holder: HeavyHolder) {}
  weigh(i: HeavyItem): number {
    return i.weight * i.extra;
  }
  total(): number {
    const bag = this.holder.bag;
    let sum = 0;
    for (const it of bag.items) sum = this.weigh(it) + sum;
    return sum;
  }
  heaviest(): HeavyItem {
    const items: HeavyItem[] = this.holder.bag.items;
    let best: HeavyItem = items[0];
    for (const it of items) if (it.weight > best.weight) best = it;
    return best;
  }
  firstName(): string {
    const bag: HeavyBag = this.holder.bag;
    const first: HeavyItem = bag.first;
    return `${bag.label}:${first.name}`;
  }
}

export class FieldReader {
  protected mHolder: HeavyHolder;
  constructor(holder: HeavyHolder) {
    this.mHolder = holder;
  }
  count(): number {
    const bag = this.mHolder.bag;
    let n = 0;
    for (const it of bag.items) n = n + it.extra;
    return n;
  }
}
