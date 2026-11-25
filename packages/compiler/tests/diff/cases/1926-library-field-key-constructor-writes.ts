// @lenient-both
// Library mode: a constructor's writes of its fields make their keys wherever they are (a declaration's value, a loop,
// a function it calls back), in the order they run.
class Grid {
  rows: number;
  cols: number;
  cells: number[];
  last: number;
  label = 'g';
  constructor(n: number) {
    const size = (this.cols = n);
    for (let i = 0; i < 2; i++) this.last = i;
    [1].forEach((v) => (this.rows = v + size));
    this.cells = [];
  }
}
const g = new Grid(3);
console.log(Object.keys(g).join(), JSON.stringify(g));
