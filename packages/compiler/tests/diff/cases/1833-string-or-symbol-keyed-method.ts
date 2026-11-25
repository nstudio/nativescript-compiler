// A method keyed by a constant that may hold a string or a symbol is found by what the constant holds.
const observable: string | symbol = Math.random() > 2 ? Symbol('obs') : '@@observable';
class Source {
  [observable]() {
    return this;
  }
  name = 'src';
}
const s = new Source();
console.log((s as any)[observable]() === s, typeof observable);
