// Whole-array operations through a base-class alias of a subclass array (sort, reverse, splice, unshift, fill,
// length) change the subclass array, and the objects stay the same objects.
class Shape {
  constructor(public size: number) {}
  area(): number { return this.size; }
}
class Square extends Shape {
  area(): number { return this.size * this.size; }
  label(): string { return 'square ' + this.size; }
}
const squares: Square[] = [new Square(3), new Square(1), new Square(2)];
const first = squares[0];
const shapes: Shape[] = squares;
shapes.sort((a, b) => a.size - b.size);
console.log(squares.map((s) => s.label()).join(', '), squares[2] === first);
shapes.reverse();
shapes.splice(1, 1, new Square(5), new Square(6));
console.log(squares.map((s) => s.label()).join(', '), squares.length);
shapes.unshift(new Square(9));
console.log(squares[0].label(), shapes.length, squares.indexOf(first), shapes.includes(first));
console.log(shapes.map((s) => s.area()).join(','), shapes.filter((s) => s.size > 4).length);
shapes.length = 2;
console.log(squares.length, squares[1].label());
