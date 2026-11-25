// Callbacks, iteration and whole-array changes through a nested view: sort and reverse of the rows, rows sorted in
// place, forEach and map seeing the typed rows.
const grid: number[][] = [[3, 1], [2], [9, 4, 7]];
const loose: any[][] = grid;
loose.sort((a, b) => a.length - b.length);
console.log(JSON.stringify(grid));
loose.forEach((r) => r.sort((a, b) => a - b));
console.log(JSON.stringify(grid));
loose.reverse();
const lens = loose.map((r) => r.length);
console.log(JSON.stringify(grid), lens.join(','), loose.every((r) => Array.isArray(r)));
const flat: any[] = [];
for (const r of loose) for (const v of r) flat.push(v * 10);
console.log(flat.join(','));
loose.splice(1, 1);
console.log(grid.length, JSON.stringify(grid));
