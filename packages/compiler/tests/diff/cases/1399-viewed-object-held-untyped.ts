// An object read through an interface its class does not implement, then held untyped (returned, passed, stored in a
// field, an array, a Map, a closure's result or capture), is still the class instance: instanceof, casts, methods and
// identity are its.
interface Named {
  name: string;
}

class Person {
  constructor(public name: string, public age: number) {}
  greet() {
    return 'hi ' + this.name;
  }
}

class Holder {
  held: any = null;
}

const p = new Person('ann', 3);

function check(label: string, x: any) {
  console.log(label, x instanceof Person, x === p, x instanceof Person ? x.greet() + ' ' + x.age : '-', (x as Person).age);
}
function show(n: Named): any {
  return n;
}
function routes(v: Named) {
  v.name = 'bob';
  check('return', show(v));
  check('param', v);
  const h = new Holder();
  h.held = v;
  check('field', h.held);
  const arr: any[] = [v];
  arr.push(v);
  check('array', arr[1]);
  console.log(arr.indexOf(p), arr[1] === arr[0]);
  const m = new Map<string, any>();
  m.set('a', v);
  check('map', m.get('a'));
  const keep = (w: Named) => () => w;
  const fn: () => any = keep(v);
  check('closure', fn());
  const cap = () => {
    const u: any = v;
    return u;
  };
  check('capture', cap());
}

const loose: any = p;
routes(loose);
console.log(p.name, p.greet());
