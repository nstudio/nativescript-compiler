// An array given where any[] or unknown[] is declared is the same array: identity and writes are shared.
const nums = [1, 2, 3];
const loose: any[] = nums;
console.log('typed to any[]', loose === nums);
loose.push(4);
console.log('write through', nums.length);
function take(xs: any[]) { xs.push(0); return xs; }
console.log('param', take(nums) === nums, nums.length);
const u: unknown[] = nums;
console.log('unknown[]', u === nums);
