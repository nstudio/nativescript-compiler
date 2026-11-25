// @lenient-both
// Library mode: the constructor's writes make keys in the order they run (a field every path assigns at once, a field
// only some paths assign, and fields its methods assign), after the fields with values.
class Node1 {
  left: number;
  right: number;
  kind: string;
  extra: string;
  size = 0;
  constructor(flip: boolean) {
    this.kind = 'k';
    if (flip) this.right = 1;
    this.init();
    if (!flip) this.right = 2;
  }
  init() {
    this.left = 0;
  }
}
console.log(Object.keys(new Node1(true)).join(), Object.keys(new Node1(false)).join());
class Pair {
  second: number;
  first: number;
  constructor() {
    this.first = 1;
    this.second = 2;
  }
}
console.log(Object.keys(new Pair()).join(), JSON.stringify(new Pair()));
