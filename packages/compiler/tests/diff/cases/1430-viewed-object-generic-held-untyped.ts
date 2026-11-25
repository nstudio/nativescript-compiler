// An object read through an interface its class does not implement, carried by a type parameter or a union, then
// held untyped, is still the class instance; carried typed, it is the same object too.
interface Named {
  name: string;
}

class Person {
  constructor(public name: string) {}
  greet() {
    return 'hi ' + this.name;
  }
}

const p = new Person('ann');

function check(label: string, x: any) {
  console.log(label, x instanceof Person, x === p, x instanceof Person ? x.greet() : '-');
}
function viaParam<T>(t: T): any {
  const u: any = t;
  return u;
}
function keep<T>(t: T): T {
  return t;
}
function viaUnion(v: Named | string) {
  check('union', v);
}

function routes(v: Named) {
  check('type parameter', viaParam(v));
  check('generic result', keep(v));
  viaUnion(v);
  const items: Named[] = [v];
  console.log(items.indexOf(p as any), new Set<Named>([v, p as any]).size);
}

const loose: any = p;
routes(loose);
