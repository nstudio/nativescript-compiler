// A class's own valueOf and toJSON are what conversion to a primitive and JSON.stringify call, over a base's static
// methods of those names (no instance's) and over an abstract one (no body).
class B {
  static valueOf(): number { return 1; }
  static toJSON(): string { return 'B'; }
}
class C extends B {
  n = 4;
  valueOf(): number { return this.n; }
  toJSON(): unknown { return { n: this.n }; }
}
console.log(+new C(), JSON.stringify(new C()));
abstract class D {
  abstract valueOf(): number;
}
class E extends D {
  valueOf(): number { return 7; }
}
console.log(+new E() + 1);
