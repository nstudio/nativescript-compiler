// A class instance given where an interface it does not implement is expected, through an untyped value, is still the instance: instanceof,
// identity and writes are the instance's.
interface Named {
  name: string;
  tag: string;
}

class Person {
  constructor(public name: string, public age: number) {}
  greet() {
    return 'hi ' + this.name;
  }
}

function rename(n: Named, to: string): Named {
  n.name = to;
  return n;
}

const p = new Person('ann', 3);
const loose: any = p;
const back = rename(loose, 'bob');
console.log(back === loose, back instanceof Person, p.name, p.greet());
if (back instanceof Person) console.log(back.greet(), back.age);
const list: Named[] = [loose];
console.log(list[0] === loose, list.indexOf(loose), (list[0] as any).age);
list[0].tag = 'b';
console.log((p as any).tag, Object.keys(p).join(','));
