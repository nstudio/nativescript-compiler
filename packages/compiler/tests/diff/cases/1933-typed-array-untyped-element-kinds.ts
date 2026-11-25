// Arrays of strings, booleans, objects, optional elements and arrays held as `any[]`: each the same array, elements as they are.
class P {
  n: number;
  constructor(n: number) { this.n = n; }
}
const ps = [new P(1), new P(2)];
const lp: any[] = ps;
lp.push(new P(3));
console.log(ps.length, ps[2].n, lp[0] === ps[0]);
lp[1] = lp[0];
console.log(ps[1] === ps[0]);
const maybe: (string | undefined)[] = ['a', undefined];
const lm: any[] = maybe;
lm.push(undefined, 'b');
console.log(maybe.length, maybe.join('-'), lm[1] === undefined);
const grid: number[][] = [[1], [2]];
const lg: any[] = grid;
lg[0].push(9);
const three: number[] = [3];
lg.push(three);
console.log(lg[2] === three);
console.log(JSON.stringify(grid), lg[0] === grid[0]);
const objs: { k: number }[] = [{ k: 1 }];
const lo: any[] = objs;
lo[0].k = 5;
console.log(objs[0].k, lo[0] === objs[0]);
