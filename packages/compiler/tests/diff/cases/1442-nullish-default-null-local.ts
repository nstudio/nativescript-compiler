// @app-lenient
// A non-strict app's local inferred from `x ?? null` (a missing element's default), kept and returned by a method:
// it holds null where the element is missing and the element where it is present.
class Media {
  constructor(public url: string) {}
}

class Gallery {
  constructor(private items: Media[]) {}
  first() {
    const m = this.items[0] ?? null;
    return m;
  }
}

const empty = new Gallery([]).first();
console.log(empty === null, empty === undefined);
const full = new Gallery([new Media('u')]).first();
console.log(full.url);
