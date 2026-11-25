// Iterating one alias while the other writes: each pass sees the array as it is then.
const nums = [1, 2, 3];
const loose: any[] = nums;
const seen: number[] = [];
for (const x of loose) {
  seen.push(x);
  if (nums.length < 5) nums.push(x * 10);
}
console.log(seen.join(','), nums.length);
const visited: any[] = [];
nums.forEach((x, i) => {
  visited.push(x);
  if (i === 0) loose.splice(1, 1);
});
console.log(visited.join(','), nums.join(','));
let total = 0;
for (let i = 0; i < loose.length; i++) {
  total += loose[i];
  nums[i] = 0;
}
console.log(total, nums.join(','));
console.log(loose.map((x) => x + 1).join(','), loose.filter((x) => x === 0).length, loose.reduce((s, x) => s + x, 0));
console.log(Array.from(loose.entries()).length, [...loose.keys()].join(','), loose.indexOf(0), loose.includes(0));
