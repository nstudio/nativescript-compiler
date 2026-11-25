// Arrays of arrays of object literals where an interface's arrays of arrays are declared, and an optional array of them.
interface Cell { row: number; col: number }

function grid(n: number): Cell[][] {
  return [...Array(n).keys()].map((r) => [...Array(n).keys()].map((c) => ({ row: r, col: c, id: `${r}:${c}` })));
}

function diagonal(n: number, wanted: boolean): Cell[] | undefined {
  return wanted ? [...Array(n).keys()].map((k) => ({ row: k, col: k, tag: 'd' })) : undefined;
}

const g = grid(2);
console.log(JSON.stringify(g), g[1][0].row, g[1][0].col);
const d = diagonal(3, true);
console.log(d ? d[2].col : -1, JSON.stringify(d), diagonal(3, false));
