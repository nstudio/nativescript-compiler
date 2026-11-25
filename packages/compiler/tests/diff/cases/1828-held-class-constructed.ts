// `new k(…)` of a class held in a variable, an array, a parameter or a field constructs the class it holds when it runs,
// a subclass of the one its type names too.
class Base {
  constructor(public n: number) {}
  who() { return 'base' + this.n; }
}
class Derived extends Base {
  who() { return 'derived:' + super.who(); }
}
const K = Derived;
console.log(new K(2).who());
const ks: (typeof Base)[] = [Base, Derived];
for (const k of ks) console.log(new k(3).who());
function make(c: typeof Base, n: number) { return new c(n); }
console.log(make(Derived, 4).who(), make(Base, 5) instanceof Derived);
class Holder {
  constructor(public made: typeof Base) {}
  build(n: number) { return new this.made(n); }
}
console.log(new Holder(Derived).build(7).who());
