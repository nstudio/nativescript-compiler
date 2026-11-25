// A typed array returned where `any[]` is the result type, stored in an `any[]` field, or held in an `any[]` array is the
// one array.
function asLoose(xs: number[]): any[] {
  return xs;
}
const nums = [1, 2];
const l = asLoose(nums);
l.push(3);
console.log(l === nums, nums.length);
class Holder {
  items: any[] = [];
  constructor(src: string[]) { this.items = src; }
}
const src = ['a'];
const h = new Holder(src);
h.items.push('b');
console.log(h.items === src, src.join(','));
const outer: any[][] = [nums];
outer[0].push(4);
console.log(outer[0] === nums, nums.join(','));
const rec: { list: any[] } = { list: nums };
rec.list.length = 1;
console.log(nums.length, rec.list === nums);
const u: readonly unknown[] = nums;
console.log(u === nums, u.length);
