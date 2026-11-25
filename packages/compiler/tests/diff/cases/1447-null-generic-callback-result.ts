// @app-lenient
// A non-strict app's null given for a generic callback's result, directly (`r => null`) or through an object's field
// (`{ payload: null }` read by `r => r?.payload || null`): the callback's result holds it.
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
each([{ payload: null }, { payload: new Item('a') }] as Reply[], (r) => r?.payload || null, show);
each([{ payload: new Item('b') }] as Reply[], (r) => null, show);
each([[new Item('c')], []], (xs: Item[]) => null, show);
