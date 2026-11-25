// @assign-fields
// Class fields assigned (below ES2022): the constructor assigns its parameter properties, then runs the field
// initializers, which read them.
class A {
  y = this.read();
  constructor(public x: number) {}
  read() {
    return String(this.x);
  }
}
const a = new A(3);
console.log(a.y, Object.keys(a).join());
class B {
  z: string;
  w = this.show();
  constructor(public k: string, n: number) {
    this.z = this.w + n;
  }
  show() {
    return 'w' + this.k;
  }
}
const b = new B('k', 2);
console.log(b.z, b.w, b.k, Object.keys(b).join());
class Base {
  tag = 'base';
}
class D extends Base {
  first = (() => this.tag + ':' + String(this.n))();
  constructor(private n: number) {
    super();
  }
}
console.log(new D(4).first);
