// @lenient-both
// Library mode: a subclass's fields with values are keys once its level of the constructor starts, after any key its
// base's constructor made, and a field either level declares without a value is a key from its first write.
class Base {
  early: string;
  late: string;
  base = 'b';
  constructor() {
    this.setup();
  }
  setup() {
    this.early = 'e';
  }
}
class Derived extends Base {
  own = 'o';
  mine: number;
  constructor() {
    super();
    this.late = 'l';
  }
  setup() {
    super.setup();
    this.mine = 1;
  }
}
const d = new Derived();
console.log(Object.keys(d).join());
const e = new Derived();
e.late = 'x';
(e as any).added = true;
e.mine = 2;
console.log(Object.keys(e).join(), JSON.stringify(e));
class Plain extends Base {
  own = 'p';
}
console.log(Object.keys(new Plain()).join());
