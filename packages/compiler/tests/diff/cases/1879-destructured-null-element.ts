// A pattern reads an array's or a tuple's element as it holds it: into a variable that keeps null apart from undefined
// (`T | null | undefined`) a null element stays null, an element past the array's end is undefined, and a default
// replaces undefined alone; through nested patterns and `for…of` targets too.
const xs: (number | null)[] = [null];
const [a] = xs;
let b: number | null | undefined;
[b] = xs;
console.log(a === null, b === null);
[, b] = xs;
console.log(b === undefined);
let r: number | null | undefined = 1;
[r] = [null, 's'] as [number | null, string];
console.log(r === null);
let s: number | null | undefined = 1;
[s = 5] = xs;
console.log(s === null);
[, s = 5] = xs;
console.log(s);
let k: string | null | undefined;
let v: number | null | undefined;
const pairs: [string, number | null][] = [['k', null], ['j', 2]];
for ([k, v] of pairs) console.log(k, v === null, v);
const nested: [number, (number | null)[]] = [1, [null]];
let n: number;
[n, [v]] = nested;
console.log(n, v === null);
[n, [, v = 7]] = nested;
console.log(n, v);
({ list: [v] } = { list: xs });
console.log(v === null);
const [c = 5] = xs;
const [, d = 5] = xs;
const us: (number | undefined)[] = [undefined];
const [e = 5] = us;
console.log(c, d, e);
function first(list: (number | null)[]): string {
  let x: number | null | undefined = 0;
  [x] = list;
  return x === null ? 'null' : x === undefined ? 'undefined' : String(x);
}
console.log(first([null]), first([]), first([3]));
