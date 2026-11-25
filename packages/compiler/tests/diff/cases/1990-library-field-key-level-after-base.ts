// @lenient-both
// Library mode: keys a base's constructor made (a field it declares without a value, a key script adds) come before the
// keys of each later level of the constructor, which follow in their own order.
class Base {
  made: number;
  noted: string;
  constructor() {
    this.start();
  }
  start() {
    this.made = 1;
    (this as any).extra = 'x';
  }
}
class Middle extends Base {
  middle = 'm';
  other = 0;
}
class Leaf extends Middle {
  leaf = true;
  constructor() {
    super();
    this.noted = 'n';
  }
}
const m = new Middle();
console.log(Object.keys(m).join(), JSON.stringify(m));
const l = new Leaf();
console.log(Object.keys(l).join(), JSON.stringify(l));
(l as any).later = 1;
l.noted = 'again';
delete (l as any).extra;
(l as any).extra = 'y';
console.log(Object.keys(l).join());
const p = new Leaf();
(p as any).noted2 = 2;
console.log(Object.keys(p).join());
