// @keep-going may take or give null or undefined both
// One declaration of a module refused: the module's interfaces, functions and classes that translate are kept.
interface Point {
  x: number;
  y: number;
}

function length(p: Point): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

class Grid {
  cells: Point[] = [];
  add(p: Point): Grid {
    this.cells.push(p);
    return this;
  }
}

class Unused {
  get mark(): string | null | undefined {
    return this.cells.length ? 'set' : this.cells.length === 0 ? null : undefined;
  }
  cells: number[] = [];
}

const g = new Grid().add({ x: 3, y: 4 }).add({ x: 1, y: 1 });
console.log(g.cells.length, length(g.cells[0]), length(g.cells[1]).toFixed(3));
