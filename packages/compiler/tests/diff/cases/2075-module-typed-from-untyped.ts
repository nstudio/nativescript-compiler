// An untyped value placed in a typed slot at module level is that value, as it is inside a function.
interface Item {
  name: string;
  qty: number;
}
class Row {
  constructor(public id: number) {}
}
const raw: any = JSON.parse('[{"name":"a","qty":1},{"name":"b","qty":2}]');
const items: Item[] = raw;
const src = [3, 1, 2];
const loose: any = src;
const nums: number[] = loose;
const asserted = loose as number[];
let names: string[] = JSON.parse('["x","y"]');
const grid: number[][] = JSON.parse('[[1,2],[3]]');
const rowsSrc = [new Row(1), new Row(2)];
const rowsAny: any = rowsSrc;
const rows: Row[] = rowsAny;
const first: Item = raw[0];
const total: number = raw.length;
console.log(items.length, items[1].name, first.qty, total);
nums.push(4);
console.log(nums === src, asserted === src, src.length, nums.join());
console.log(names.join(), grid[0][1] + grid[1][0], rows[1].id, rows === rowsSrc);
names = JSON.parse('["w"]');
console.log(names.length, names[0]);
