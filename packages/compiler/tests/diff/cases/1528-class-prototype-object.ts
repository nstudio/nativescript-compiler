// A class's prototype object and the constructor's own prototype: Object.getPrototypeOf of a derived class and of its prototype, and a method read from the prototype.
class Base {
  who() { return 'base'; }
}
class Derived extends Base {
  who() { return 'derived:' + super.who(); }
}
const d: any = new Derived();
console.log('prototype chain', d.who(), Object.getPrototypeOf(Derived) === Base, Object.getPrototypeOf(Derived.prototype) === Base.prototype, d instanceof Base, d.constructor.name);
console.log('class field arrow vs method', typeof (Derived.prototype as any).who, Object.keys(d), d.hasOwnProperty('who'));
