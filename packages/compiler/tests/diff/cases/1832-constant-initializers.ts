// Module and static initializers that read only constants run early, as the platform sets them; a computed key reads its variable where JavaScript evaluates it.
let k = 'a';
const o = { [k]: 1 };
const RE = /a+/g;
enum K { A = 'ka' }
namespace NS {
  export const base = 10;
}
class C {
  static s = { [k]: 2 };
  static w = JSON.stringify({ [K.A]: 3 });
  static r = /b+/g;
  static rr = RE;
  static f = Math.floor;
  static n = NS.base + 1;
  static m = new Map([['x', 1]]);
}
k = 'b';
console.log(JSON.stringify(o), JSON.stringify(C.s), C.w);
console.log(C.r.source, C.rr.source, C.f(2.5), C.n, C.m.get('x'));
console.log('abaab'.replace(C.r, '-'), 'aaab'.replace(RE, '+'));
