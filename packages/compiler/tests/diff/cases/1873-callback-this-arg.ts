// A callback function reading its own `this` gets the thisArg beside it as `this`; an arrow keeps its lexical `this`.
interface Box { t: number; seen: number[] }
const box: Box = { t: 2, seen: [] };
const nums = [1, 2, 3];

console.log(nums.some(function (this: Box, v) { return this.t === v; }, box));
console.log(nums.every(function (this: Box, v) { return v <= this.t + 1; }, box));
console.log(nums.map(function (this: Box, v) { return v * this.t; }, box).join());
console.log(nums.filter(function (this: Box, v) { return v !== this.t; }, box).join());
console.log(nums.find(function (this: Box, v) { return v > this.t; }, box));
console.log(nums.findIndex(function (this: Box, v) { return v === this.t; }, box));
console.log(nums.findLast(function (this: Box, v) { return v < this.t + 1; }, box));
console.log(nums.findLastIndex(function (this: Box, v) { return v < this.t; }, box));
console.log(nums.flatMap(function (this: Box, v) { return [v, this.t]; }, box).join());
nums.forEach(function (this: Box, v, i) { this.seen.push(v * 10 + i); }, box);
console.log(box.seen.join());

// Read inside an arrow function within the callback, and written.
nums.forEach(function (this: Box, v) { [v].forEach((w) => { this.t += w; }); }, box);
console.log(box.t);

// Typed arrays, Array.from, Map and Set.
const bytes = new Uint8Array([4, 5, 6]);
console.log(bytes.some(function (this: Box, v) { return v === this.t; }, { t: 5, seen: [] }));
console.log(bytes.map(function (this: Box, v) { return v + this.t; }, box).join());
console.log(Array.from([1, 2], function (this: Box, v) { return v + this.t; }, box).join());
const m = new Map<string, number>([['a', 1], ['b', 2]]);
m.forEach(function (this: Box, v, k) { this.seen.push(v); console.log(k, v + this.t); }, box);
new Set([7, 8]).forEach(function (this: Box, v) { console.log(v - this.t); }, box);

// Array.prototype's methods called over another receiver.
const like = { length: 2, 0: 2, 1: 9 };
console.log(Array.prototype.some.call(like, function (this: Box, v: number) { return v === this.t; }, box));

// An arrow ignores the thisArg; a callback not reading `this` keeps its form.
class Holder {
	t = 9;
	run(): number[] { return nums.map((v) => v + this.t, box); }
}
console.log(new Holder().run().join(), nums.map(function (v) { return v + 1; }, box).join());
