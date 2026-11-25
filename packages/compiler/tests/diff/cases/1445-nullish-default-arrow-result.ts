// @app-lenient
// A non-strict app's arrow whose body is `x || null` / `x ?? null` of an object, given for a generic callback: it gives
// null where `x` is missing and the object where it is present.
class Item {
  constructor(public name: string) {}
}

interface Reply {
  payload: Item;
}

function each<T, R>(xs: T[], f: (x: T, i: number) => R, done: (r: R) => void) {
  for (let i = 0; i < xs.length; i++) done(f(xs[i], i));
}

const show = (item: Item) => console.log(item === null ? 'null' : item.name);
each([{ payload: new Item('a') }, { payload: undefined }] as Reply[], (r) => r?.payload || null, show);
each([[new Item('b')], []], (xs: Item[]) => xs[0] ?? null, show);
