// @lenient-both
// Library mode: a loop binding the body assigns from a function that may give null holds what that function gives,
// and later reads see it.
class Info {
  name: string;
  vars: boolean;
  constructor(name: string, vars = false) {
    this.name = name;
    this.vars = vars;
  }
}
class Resolver {
  resolve(info: Info): Info {
    if (info.name === 'drop') return null;
    return new Info(info.name + '!');
  }
  describe(info: Info): string {
    return info ? info.name : 'none';
  }
  run(list: Info[]): string[] {
    const out: string[] = [];
    for (let info of list) {
      if (info.vars) {
        info = this.resolve(info);
      }
      out.push(this.describe(info));
      out.push(info ? info.name.toUpperCase() : 'null');
      out.push(String(info == null));
    }
    return out;
  }
}
const r = new Resolver();
console.log(r.run([new Info('a'), new Info('b', true), new Info('drop', true)]).join());
let last: Info;
for (let x of [new Info('p'), new Info('drop')]) {
  x = r.resolve(x);
  last = x;
  console.log(x ? x.name : 'none');
}
console.log(last == null);
