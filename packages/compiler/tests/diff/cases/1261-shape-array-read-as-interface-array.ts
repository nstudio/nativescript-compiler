// An array of one object type read where an array of an interface with fewer keys is declared, where nothing writes
// either one or tests its identity: a parameter only read, a local only read, an optional one.
interface Point { x: number; y: number }
interface Labelled { x: number; y: number; label: string }

function sum(list: Point[]): number {
  let s = 0;
  for (const p of list) s += p.x + p.y;
  return s;
}

function firstX(list: Point[] | undefined): number {
  return list && list.length ? list[0].x : -1;
}

const labelled: Labelled[] = [{ x: 1, y: 2, label: 'a' }, { x: 3, y: 4, label: 'b' }];
console.log(sum(labelled), firstX(labelled), firstX(undefined));
const read: Point[] = labelled;
console.log(read.length, read[1].y, JSON.stringify(read));
const maybe: Labelled[] | undefined = labelled.length > 1 ? labelled : undefined;
console.log(firstX(maybe));
