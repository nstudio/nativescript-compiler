// A method read off its object and called alone has no receiver: `this` is undefined.
class Counter {
  n = 5;
  read() { return this.n; }
  name() { return typeof this; }
}
const c = new Counter();
const read = c.read;
try {
  console.log('read', read());
} catch (e) {
  console.log('read threw', (e as Error).constructor.name);
}
const name = c.name;
console.log('name', name());
const o = { k: 1, get() { return this?.k; } };
const g = o.get;
console.log('literal', g());
