// An undefined comparator sorts by the default order (elements as strings), whether written as `undefined` or passed
// through a parameter that may be undefined.
function sorted(xs: number[], by?: (a: number, b: number) => number) {
  return xs.slice().sort(by);
}
const nums = [10, 9, 1, 100];
console.log([...nums].sort(undefined).join());
console.log(sorted(nums).join(), sorted(nums, (a, b) => a - b).join());
const words = ['b', 'c', 'a'];
const none: ((a: string, b: string) => number) | undefined = undefined;
console.log(words.sort(none).join(), [3, 1, 2].toSorted(undefined).join());
const typed = new Float64Array([3, -1, 2]);
console.log(typed.sort(undefined).join());
