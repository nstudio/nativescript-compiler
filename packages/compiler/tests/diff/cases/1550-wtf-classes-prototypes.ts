// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): members named like keywords, and prototypes.
const named: any = { class: function () { return 'k'; } };
console.log('{ class: function }', named.class(), Object.keys(named)); // wtfjs: A class of class
class Keywords {
  class() { return 'c'; }
  new() { return 'n'; }
  get default() { return 'd'; }
  static function() { return 'f'; }
}
const kw: any = new Keywords();
console.log('keyword members', kw.class(), kw.new(), kw.default, (Keywords as any).function()); // wtfjs: A class of class
class Base {
  who() { return 'base'; }
}
class Derived extends Base {
  who() { return 'derived:' + super.who(); }
}
class Counter {
  static made = 0;
  id = ++Counter.made;
}
new Counter();
console.log('static field', new Counter().id, Counter.made);

// Statically typed.
const k = new Keywords();
console.log('typed keyword members', k.class(), k.new(), k.default, Keywords.function()); // wtfjs: A class of class
const t: Base = new Derived();
console.log('typed super', t.who(), t instanceof Derived, t.constructor === Derived);
