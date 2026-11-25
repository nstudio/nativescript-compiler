// An array of arrays of a subclass held as arrays of the base class: the outer array, each row, and each object are
// the ones the typed side holds.
class Item {
  constructor(public id: number) {}
}
class Tool extends Item {
  use(): string { return 'tool ' + this.id; }
}
const rows: Tool[][] = [[new Tool(1)], [new Tool(2), new Tool(3)]];
const items: Item[][] = rows;
console.log(items === rows, items[1] === rows[1], items[1][0] === rows[1][0]);
items[0].push(new Tool(4));
items.push([new Tool(5)]);
console.log(rows[0][1].use(), rows[2][0].use(), rows.length);
function ids(list: Item[][]): string {
  return list.map((r) => r.map((i) => i.id).join('+')).join(' | ');
}
console.log(ids(rows));
