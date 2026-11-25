// The untyped alias reads back what it wrote into a `number[]`: by index, through iteration and callbacks, by
// indexOf and includes, and an object written in is the same object.
const nums: number[] = [5, 6];
const loose: any[] = nums;
const obj = { k: 'v' };
loose.push('s', obj, false);
console.log(loose[2], loose[3] === obj, loose[4], loose.indexOf('s'), loose.includes(obj), loose.indexOf(false));
const seen: string[] = [];
for (const v of loose) seen.push(typeof v);
console.log(seen.join(','));
console.log(loose.map((v) => String(v)).join(','), loose.filter((v) => typeof v === 'number').length);
loose[2] = 7;
console.log(nums[2] + 1, typeof nums[2], nums.length);
const back = loose.slice(0, 2);
console.log(back.join(','), loose.at(-1), loose.lastIndexOf(obj));
