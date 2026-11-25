// @lenient-both
// Library mode: keys script adds to an object and keys its fields make at their first write list in the order they
// were made, whichever came first.
class Bag {
  first: string;
  second: string;
  kept = 1;
}
const b = new Bag();
const any: any = b;
any.added = 'a';
b.second = 's';
any.more = 'm';
b.first = 'f';
console.log(Object.keys(b).join(), JSON.stringify(b));
const c = new Bag();
c.first = 'f';
const cany: any = c;
cany.added = 'a';
console.log(Object.keys(c).join());
