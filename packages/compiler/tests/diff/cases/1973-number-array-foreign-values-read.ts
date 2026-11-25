// Values of other kinds written into a `number[]` through an untyped alias are stored as they are: typeof, printing,
// JSON, join, String, slice and concat of the typed array see them.
function fill(list: any[]): void {
  list.push('x', true, null, undefined, { a: 1 });
  list[0] = 'first';
}
const nums: number[] = [1, 2];
fill(nums);
console.log(nums.length, typeof nums[0], typeof nums[1], typeof nums[2], typeof nums[3], typeof nums[4], typeof nums[5], typeof nums[6]);
console.log(JSON.stringify(nums));
console.log(nums.join('|'));
console.log(String(nums));
console.log(nums);
console.log(JSON.stringify(nums.slice(2)), JSON.stringify(nums.concat([9])));
