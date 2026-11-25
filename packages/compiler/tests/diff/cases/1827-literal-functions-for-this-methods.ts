// An object literal's functions for its interface's methods that declare `this`: a method shorthand and a function
// expression, each reading the object it is called on.
interface Counter {
  n: number;
  bump(this: Counter, by: number): number;
  show(this: Counter): string;
}
const c: Counter = {
  n: 1,
  bump(by) {
    this.n += by;
    return this.n;
  },
  show: function () {
    return 'n=' + this.n;
  },
};
console.log(c.bump(2), c.show());
c.n = 7;
console.log(c.show(), c.bump(1));
