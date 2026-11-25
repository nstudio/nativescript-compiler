// @lenient-both
// Library mode: a subclass's constructor writing a field its base declares without a value makes the key there, after
// the subclass's own fields with values; a method writing it later makes it then.
class Shape {
  name: string;
  area: number;
  id = 0;
}
class Square extends Shape {
  side = 2;
  constructor() {
    super();
    this.name = 'square';
  }
  measure() {
    this.area = this.side * this.side;
  }
}
const sq = new Square();
console.log(Object.keys(sq).join());
sq.measure();
console.log(Object.keys(sq).join(), JSON.stringify(sq));
