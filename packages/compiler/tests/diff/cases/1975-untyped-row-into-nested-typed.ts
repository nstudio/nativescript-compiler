// An untyped array written into a `number[][]` through its `any[][]` alias is the row JavaScript stores: the typed
// side reads that same array, and writes through either reach the other.
const grid: number[][] = [[1]];
const loose: any[][] = grid;
const row: any[] = [2, 3];
loose.push(row);
console.log(grid.length, grid[1] === row, loose[1] === row, grid[1][1]);
row.push(4);
grid[1].push(5);
console.log(JSON.stringify(grid), row.length, JSON.stringify(row));
grid[1][0] = 20;
console.log(row[0], loose[1][0]);
loose[0] = [7, 8];
console.log(grid[0][1], JSON.stringify(loose));
