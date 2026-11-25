// @app-lenient
// A non-strict app's value typed present but holding null or undefined: a local, a parameter, a result, a field never
// assigned and an array's missing element. A member read through it is JavaScript's TypeError, catchable.
class Item {
  constructor(public name: string, public size: number) {}
}
class Box {
  unset: Item;
  kept: Item = new Item('k', 2);
}
interface Look {
  name: string;
  width: number;
}
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, e instanceof TypeError ? e.message : 'other');
  }
}
function count<T>(xs: T[]): number {
  return xs.length;
}
const show = (item: Item) => item.name;
const looks: Look[] = [{ name: 'a', width: 1 }];
function find(n: string): Item {
  return n === 'x' ? new Item('x', 1) : null;
}
interface Part {
  kind: string;
  size: number;
}
function pick(given: boolean): Part {
  return given ? { kind: 'a', size: 4 } : null;
}
function guards(given: boolean) {
  const part: Part = pick(given);
  const sizes = part && [1, 2].map((n) => n + part.size);
  console.log('closure', given, sizes ? sizes.join(',') : 'none');
  if (part?.kind === 'a') console.log('chain', part.size);
  else console.log('chain', 'none');
}
function main() {
  const it: Item = null;
  let un: Item = undefined;
  const look: Look = null;
  const box = new Box();
  attempt('param', () => show(it));
  attempt('undef', () => un.name);
  attempt('shape', () => look.width);
  attempt('result', () => find('y').name);
  attempt('element', () => looks[3].name);
  attempt('local', () => it.size);
  attempt('unset', () => box.unset.name);
  attempt('kept', () => box.kept.name);
  const none: Item[] = null;
  attempt('array', () => count(none));
  un = new Item('u', 3);
  attempt('assigned', () => un.name);
  guards(true);
  guards(false);
}
main();
