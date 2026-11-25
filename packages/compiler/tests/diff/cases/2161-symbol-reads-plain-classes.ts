// @lenient-both
// Symbol keys read and tested on instances of a class that names no member by a symbol and of subclasses that name a
// method or a field so: own symbol-keyed properties added and deleted, and symbol keys a prototype gains and loses.
const added = Symbol('added');
const onProto = Symbol('onProto');
const method = Symbol('method');
const field = Symbol('field');

class Plain {
  x = 1;
}
class WithMethod extends Plain {
  [method]() {
    return 'm' + this.x;
  }
}
class WithField extends Plain {
  [field] = 'f';
}
class Deeper extends WithMethod {}

const p: any = new Plain();
const m: any = new WithMethod();
const w: any = new WithField();
const d: any = new Deeper();
const all = [p, m, w, d];
const show = (k: symbol) => all.map((o) => `${k in o}:${typeof o[k] === 'function' ? 'fn' : o[k]}`).join(' ');
console.log('a', show(added), show(method), show(field));
p[added] = 1;
d[added] = 2;
w[field] = 'f2';
console.log('b', show(added), show(field));
Object.defineProperty(Plain.prototype, onProto, {
  get() {
    return 'proto' + this.x;
  },
  configurable: true,
});
console.log('c', show(onProto));
delete p[added];
console.log('d', show(added));
delete (Plain.prototype as any)[onProto];
console.log('e', show(onProto));
(WithMethod.prototype as any)[onProto] = 'wm';
console.log('f', show(onProto), m[method](), d[method]());
