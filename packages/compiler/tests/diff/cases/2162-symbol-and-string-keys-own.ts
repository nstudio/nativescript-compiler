// @members-by-name
// Symbol keys read and tested on an app class's instances given undeclared properties, and on a subclass naming a
// method by a symbol; an object's string, index and symbol keys added and deleted in turn.
const tag = Symbol('tag');
const run = Symbol('run');

class Item {
  name = 'n';
}
class Runner extends Item {
  [run](): string {
    return 'ran ' + this.name;
  }
}

const i: any = new Item();
const r: any = new Runner();
console.log(tag in i, i[tag], run in i, tag in r, run in r, typeof r[run]);
i[tag] = 'tagged';
r[tag] = 'r';
console.log(tag in i, i[tag], tag in r, r[tag], run in r, r[run]());
delete i[tag];
console.log(tag in i, i[tag], tag in r, r[tag]);

const o: any = {};
const s1 = Symbol('s1');
o[s1] = 1;
console.log('a' in o, o.a, s1 in o, o[s1], Object.keys(o).length);
o.a = 2;
delete o[s1];
console.log('a' in o, o.a, s1 in o, o[s1], Object.keys(o).join());
o[0] = 'zero';
delete o.a;
console.log(0 in o, o[0], 'a' in o, o.a, s1 in o, Object.keys(o).join());
delete o[0];
o[s1] = 3;
console.log(0 in o, o[0], s1 in o, o[s1], Object.keys(o).length);
