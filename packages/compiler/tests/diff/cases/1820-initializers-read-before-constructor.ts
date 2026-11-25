// Class fields defined (ES2022): field initializers run before the constructor assigns its parameter properties and
// runs its body, so what an initializer reads through `this` of those is undefined.
class A {
  y = this.read();
  constructor(public x: number) {}
  read() {
    return String(this.x);
  }
}
const a = new A(3);
console.log(a.y, a.x, Object.keys(a).join());
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
class C {
  w = this.get();
  z: number;
  s: string;
  constructor() {
    this.z = 1;
    this.s = 'a';
  }
  get() {
    return String(this.z) + ':' + this.s;
  }
}
const c = new C();
console.log(c.w, c.z + 1, c.s, Object.keys(c).join());
class Base {
  tag = 'base';
}
class D extends Base {
  first = (() => this.tag + ':' + String(this.n))();
  constructor(private n: number) {
    super();
  }
  get value() {
    return this.n * 2;
  }
}
const d = new D(4);
console.log(d.first, d.value);
