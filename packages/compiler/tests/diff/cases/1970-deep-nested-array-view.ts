// A `number[][][]` held as `any[][][]` is the same array at every depth: a write three levels down through either
// alias is seen through the other, and so are the rows' identities.
const cube: number[][][] = [[[1, 2], [3]], [[4]]];
const loose: any[][][] = cube;
console.log(loose === cube, loose[0] === cube[0], loose[0][1] === cube[0][1]);
loose[0][1].push(30);
loose[1][0][0] = 40;
loose[1].push([5, 6]);
console.log(JSON.stringify(cube), cube[1].length, cube[1][1][1]);
cube[0].pop();
cube.push([[7]]);
console.log(JSON.stringify(loose), loose.length, loose[2][0][0]);
function sum(grid: any[][]): number {
  let s = 0;
  for (const row of grid) for (const v of row) s += v;
  return s;
}
console.log(sum(loose[0]), sum(loose[1]));
