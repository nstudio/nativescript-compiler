// A callback whose parameters are typed, given to a method of an untyped array, runs on its elements as written.
interface Item {
  name: string;
  n: number;
}
class Row {
  constructor(public id: number) {}
}
function run() {
  const data: any[] = JSON.parse('[{"name":"b","n":2},{"name":"a","n":1},{"name":"c","n":3}]');
  console.log(data.map((d: Item) => d.name).join());
  data.forEach((d: Item, i: number) => console.log(i, d.n));
  console.log(data.filter((d: Item) => d.n > 1).length, data.find((d: Item) => d.name === 'a')?.n);
  data.sort((a: Item, b: Item) => a.n - b.n);
  console.log(data.map((d: Item) => d.name).join(), data.reduce((s: number, d: Item) => s + d.n, 0));
  const loose: any[] = [3, 1, 2];
  loose.sort((a: number, b: number) => a - b);
  console.log(loose.join(), loose.some((x: number) => x > 2), loose.every((x: number) => x > 0), loose.findIndex((x: number) => x === 2));
  console.log(loose.reduce((s: number, x: number) => s + x, 0), loose.map((x: number, i: number) => x * i).join());
  const words: any[] = ['b', 'a'];
  console.log(words.map((w: string) => w.toUpperCase()).join(), words.filter((w: string) => w < 'b').length);
  const rows: any[] = [new Row(2), new Row(1)];
  rows.sort((a: Row, b: Row) => a.id - b.id);
  rows.forEach((r: Row, i: number) => console.log('row', i, r.id));
  console.log(rows.map((r: Row) => r.id * 10).join(), rows.reduce((s: number, r: Row) => s + r.id, 0));
}
run();
const anyData: any = [{ name: 'z', n: 9 }];
console.log(anyData.map((d: Item) => d.n * 2).join(), anyData.some((d: Item) => d.name === 'z'));
const top: any[] = [5, 4];
top.sort((a: number, b: number) => a - b);
console.log(top.join());
