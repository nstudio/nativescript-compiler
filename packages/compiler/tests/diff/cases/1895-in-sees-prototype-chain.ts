// `in` sees the prototype chain: inherited class members and Object.prototype's members.
class Base { hello() { return 1; } get g() { return 2; } }
class Derived extends Base { own = 3; }
const d = new Derived();
console.log('own' in d, 'hello' in d, 'g' in d, 'toString' in d, 'missing' in d);
const lit = { a: 1 };
console.log('a' in lit, 'toString' in lit, 'hasOwnProperty' in lit, 'b' in lit);
const u: any = { a: 1 };
console.log('a' in u, 'toString' in u, 'valueOf' in u, 'b' in u);
const proto: any = { inherited: 1 };
const child: any = Object.create(proto);
child.mine = 2;
console.log('mine' in child, 'inherited' in child, 'toString' in child, 'nope' in child);
const bare: any = Object.create(null);
console.log('toString' in bare);
const ud: any = d;
console.log('hello' in ud, 'g' in ud, 'toString' in ud);
