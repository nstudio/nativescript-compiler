// A large typed array written and read element by element through an `any[]` alias, and through its own type after.
const n = 20000;
const nums: number[] = [];
const loose: any[] = nums;
for (let i = 0; i < n; i++) loose.push(i);
let t = 0;
for (let i = 0; i < loose.length; i++) t += loose[i];
for (let i = 0; i < n; i++) loose[i] = loose[i] * 2;
let u = 0;
for (let i = 0; i < nums.length; i++) u += nums[i];
console.log(nums.length, t, u);
