// Whole-array changes through an untyped alias keep the values of other kinds a `number[]` holds: reverse, splice,
// unshift and fill through the alias, and slice of the typed array.
const nums: number[] = [1, 2, 3];
const loose: any[] = nums;
loose.push('a');
loose.reverse();
console.log(JSON.stringify(nums), typeof nums[0]);
loose.splice(1, 1, 'b', 'c');
console.log(JSON.stringify(nums), nums.length);
loose.unshift(null);
console.log(JSON.stringify(nums), typeof nums[0]);
loose.fill(0, 0, 2);
console.log(JSON.stringify(nums), typeof nums[0], typeof nums[2]);
console.log(JSON.stringify(nums.slice(1, 4)), nums.indexOf(3));
