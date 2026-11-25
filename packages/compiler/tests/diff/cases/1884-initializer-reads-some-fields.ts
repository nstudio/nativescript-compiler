// Class fields defined (ES2022): an initializer that reads a field the constructor sets later reads undefined there,
// and the fields it never reads keep the values the constructor gives them; one calling a method may read any field,
// one reading fields by name only those.
class C {
  w = this.get();
  z: number;
  s: string;
  list: string[];
  constructor(public k: number) {
    this.z = 1;
    this.s = 'a';
    this.list = [this.s];
  }
  get() {
    return String(this.z);
  }
}
const c = new C(2);
console.log(c.w, c.z + 1, c.s.toUpperCase(), c.list.length, c.k * 2);
class P {
  z!: number;
  s!: string;
  later?: number;
  w = String(this.z) + ':' + String(this.later);
  t = this.z;
  constructor(public k: number, public m: string) {
    this.z = 1;
    this.s = m + '!';
    if (k > 1) this.later = k;
  }
}
const p = new P(2, 'q');
console.log(p.w, p.t, p.z + 1, p.s.toUpperCase(), p.k * 2, p.m.length, p.later);
const p1 = new P(1, 'r');
console.log(p1.t === undefined, p1.later === undefined, p1.later ?? 'none');
