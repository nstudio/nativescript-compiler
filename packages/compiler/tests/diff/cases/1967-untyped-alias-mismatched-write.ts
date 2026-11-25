// A value of another type written into a typed array through its untyped alias is stored, as in any JavaScript array.
const nums: number[] = [1, 2];
const loose: any[] = nums;
try {
  loose.push('x');
  loose[0] = true;
} catch (e) {
  console.log('threw', e instanceof TypeError);
}
console.log(loose.length, loose[0], loose[2]);
console.log(nums.length, typeof nums[0], typeof nums[2]);
