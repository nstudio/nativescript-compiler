// @lenient-both
// Class fields assigned in the constructor (core's build): a field declared without a value is no own key of the
// instance until the program assigns it, and keys then list in assignment order.
class C {
  label: string;
  count: number;
  name = 'n';
}
const c = new C();
console.log(Object.keys(c).join(), 'label' in c, c.hasOwnProperty('label'), JSON.stringify(c));
const seen: string[] = [];
for (const k in c) seen.push(k);
console.log(seen.join());
c.count = 2;
c.label = 'x';
console.log(Object.keys(c).join(), 'label' in c, c.hasOwnProperty('label'), JSON.stringify(c));
class D {
  a: number;
  b: number;
  constructor(first: boolean) {
    if (first) this.b = 1;
  }
}
console.log(Object.keys(new D(true)).join(), Object.keys(new D(false)).length);
