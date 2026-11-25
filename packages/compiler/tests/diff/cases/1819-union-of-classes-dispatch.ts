// A method called on a value typed as a union of unrelated program classes runs the receiver's own method.
class A {
  n = 1;
  run(): void {
    console.log('A ran');
  }
  twice(k: number): number {
    return k * 2 + this.n;
  }
}
class B {
  run(): void {
    console.log('B ran');
  }
  twice(k: number): number {
    return k * 20;
  }
}
function each(x: A | B | undefined) {
  x?.run();
}
function both(x: A | B) {
  x.run();
  return x.twice(3);
}
each(new A());
each(new B());
each(undefined);
console.log(both(new A()), both(new B()));
const xs: (A | B)[] = [new B(), new A()];
for (const x of xs) console.log(x.twice(1));
interface I {
  run(): string;
}
class C implements I {
  run(): string {
    return 'C';
  }
  get g(): number {
    return 5;
  }
}
class Base {
  run(): string {
    return 'base';
  }
}
class S1 extends Base {
  run(): string {
    return 'S1';
  }
}
class S2 extends Base {
  other(): number {
    return 2;
  }
}
function f(x: A | I) {
  return x.run();
}
console.log(f(new A()), f(new C()), f({ run: () => 'lit' }));
function g(x: S1 | S2) {
  return x.run();
}
console.log(g(new S1()), g(new S2()));
function h(x: C | S2) {
  return x instanceof C ? x.g : x.other();
}
console.log(h(new C()), h(new S2()));
const made: typeof A | typeof Base = Math.random() > 2 ? A : Base;
console.log(String(new made().run()));
