// for…of over arrays reads each index up to the live length: elements pushed during the loop are visited, removed ones
// are not, a truncated array ends the loop, the array variable reassigned in the body leaves the loop on the old array,
// and a write past the end visits undefined; with destructuring, a `let` binding written in the body, labels and closures.
const xs = [1, 2, 3];
const seen: number[] = [];
for (const x of xs) {
  seen.push(x);
  if (x < 3) xs.push(x * 10);
}
console.log(seen.join(','), xs.length);

const ys = [1, 2, 3, 4, 5];
const seenY: number[] = [];
for (const y of ys) {
  seenY.push(y);
  if (y === 2) ys.splice(0, 2);
  if (y === 5) ys.length = 0;
}
console.log(seenY.join(','), ys.length);

let zs = ['a', 'b', 'c'];
const seenZ: string[] = [];
for (const z of zs) {
  seenZ.push(z);
  zs = ['q'];
}
console.log(seenZ.join(','), zs.join(','));

const sparse: (number | undefined)[] = [1];
let n = 0;
for (const s of sparse) {
  n++;
  if (n === 1) sparse[2] = 7;
  console.log('sparse', s);
}

const pairs: [string, number][] = [['a', 1], ['b', 2]];
for (const [k, v] of pairs) console.log(k, v);
for (let p of pairs) {
  p = ['z', 0];
  console.log(p[0]);
}

const grid = [[1, 2], [3, 4], [5, 6]];
const found: string[] = [];
outer: for (const row of grid) {
  for (const cell of row) {
    if (cell === 2) continue outer;
    if (cell === 5) break outer;
    found.push(String(cell));
  }
}
console.log(found.join(' '));

const fns: (() => number)[] = [];
for (const x of [10, 20, 30]) fns.push(() => x);
console.log(fns.map((f) => f()).join(','));

function firstOver(values: number[], limit: number): number {
  for (const v of values) {
    if (v > limit) return v;
  }
  return -1;
}
console.log(firstOver([1, 5, 9], 4), firstOver([], 0));
