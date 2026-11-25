// @lenient-both
// Library mode: a subclass's field with a value that its base declares without one, and that the base's constructor
// leaves unmade, is a key from the subclass's level of the constructor, in that level's order.
class Base {
  shared: number;
  id = 0;
  other: string;
}
class Middle extends Base {
  first = 'f';
  shared = 2;
  last = 'l';
}
const m = new Middle();
console.log(Object.keys(m).join(), JSON.stringify(m));
m.other = 'o';
console.log(Object.keys(m).join());
class Leaf extends Middle {
  leaf = true;
  shared = 3;
}
const l = new Leaf();
console.log(Object.keys(l).join(), JSON.stringify(l));
