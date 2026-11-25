// A typed array held as `any[]` and read back as its own type is still the one array.
const nums = [1, 2, 3];
const loose: any[] = nums;
const back = loose as number[];
back.push(4);
console.log(back === nums, nums.length, loose.length);
function sum(xs: number[]) {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
console.log(sum(loose));
const viaAny: any = loose;
function readBack() {
  const typed: number[] = viaAny;
  typed[0] = 100;
  return typed;
}
console.log(readBack() === nums, nums[0], loose[0]);
class P {
  n: number;
  constructor(n: number) { this.n = n; }
}
const ps = [new P(1)];
const lps: any[] = ps;
const backPs = lps as P[];
backPs.push(new P(2));
console.log(backPs === ps, ps.length, ps[1].n);
