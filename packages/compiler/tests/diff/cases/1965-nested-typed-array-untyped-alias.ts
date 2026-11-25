// A `number[][]` held as `any[][]` is the same array, and so is each row: writes through either alias reach the other.
const grid: number[][] = [[1], [2]];
const loose: any[][] = grid;
console.log('same', loose === grid, loose[0] === grid[0]);
loose.push([3]);
loose[0].push(9);
loose[1][0] = 20;
console.log(grid.length, JSON.stringify(grid));
grid.push([4]);
console.log(loose.length, JSON.stringify(loose));
