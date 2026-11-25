// Array.prototype's methods read by name on an array held untyped, those the runtime spells generically among them.
const nums: any = [3, 1, 2];
console.log(nums.toSorted(), nums.toSorted((a: number, b: number) => b - a), nums);
console.log(nums.toReversed(), nums.toSpliced(1, 1, 'x', 'y'), nums.with(-1, 9), nums);
console.log(nums.toLocaleString(), [1234.5, 'a', null, undefined, true].toLocaleString());
const moved: any = [1, 2, 3, 4, 5];
console.log(moved.copyWithin(0, 3), moved.copyWithin(1, 0, 2), moved);
const f = nums.toReversed;
console.log(typeof f, typeof nums.with, f.call([7, 8]), nums.with.call(['a', 'b'], 0, 'z'));
try {
	nums.with(5, 0);
} catch (e) {
	console.log((e as Error).constructor.name, (e as Error).message);
}
try {
	nums.toSorted('nope');
} catch (e) {
	console.log((e as Error).constructor.name, (e as Error).message);
}
const own: any = [1, 2];
own.toSorted = () => 'own';
console.log(own.toSorted(), Array.prototype.toSorted.call(own));
const likes = { length: 2, 0: 'b', 1: 'a' };
console.log(Array.prototype.toSorted.call(likes), Array.prototype.with.call(likes, 0, 'c'));
