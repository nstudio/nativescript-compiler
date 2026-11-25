// Symbol.toPrimitive and valueOf/toString declared on a class, read by the conversions that call them.
class Money {
  constructor(private cents: number) {}
  [Symbol.toPrimitive](hint: string) {
    return hint === 'number' ? this.cents / 100 : `$${this.cents / 100}`;
  }
}
const m = new Money(250);
console.log('typed toPrimitive', +m, `${m}`, String(m), Number(m));
class Valued {
  valueOf() { return 3; }
  toString() { return 'three'; }
}
const v = new Valued();
console.log('typed valueOf/toString', `${v}`, String(v), Number(v), v.valueOf() + 1);
