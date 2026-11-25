// A typed array given to an `any[]` or `unknown[]` parameter is the caller's array: the callee's writes are the caller's,
// and what it returns is the array itself.
function grow(xs: any[], v: any): any[] {
  xs.push(v);
  xs[0] = v;
  return xs;
}
function count(xs: unknown[]): number {
  return xs.length;
}
function clear(xs: any[]) {
  xs.length = 0;
}
const nums = [1, 2, 3];
const back = grow(nums, 8);
console.log(back === nums, nums.join(','), count(nums));
const words = ['a', 'b'];
console.log(grow(words, 'z') === words, words.join(','));
const flags: boolean[] = [true];
grow(flags, false);
console.log(flags.join(','), flags.length);
clear(nums);
console.log(nums.length, count(nums));
class Box {
  items: number[] = [1];
  hold(into: any[]) { into.push(this.items.length); }
}
const box = new Box();
box.hold(box.items);
console.log(box.items.join(','));
