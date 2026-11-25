// @app-lenient
// A non-strict app's arrow whose result is a conditional, one branch `x || null` / `x ?? null` of an object, given for a
// generic callback: that branch gives null where `x` is missing.
class Item {
  constructor(public name: string) {}
}

interface Reply {
  payload: Item;
  fallback: Item;
}

function each<T, R>(xs: T[], f: (x: T, i: number) => R, done: (r: R) => void) {
  for (let i = 0; i < xs.length; i++) done(f(xs[i], i));
}

const show = (item: Item) => console.log(item === null ? 'null' : item.name);
const replies = [{ payload: new Item('a'), fallback: new Item('f') }, { payload: undefined, fallback: new Item('g') }] as Reply[];
each(replies, (r, i) => (i > 1 ? r.fallback : r?.payload || null), show);
each(replies, (r, i) => {
  if (i > 5) return r.fallback;
  return i < 0 ? r.fallback : (r.payload ?? null);
}, show);
