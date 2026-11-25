// @lenient-both
// Library code: a conditional of two object literals of different shapes, a function's result, is made as the
// conditional's type (an iterator's results, which iteration reads `done` of before `value`).
class Counted {
	n: number;
	constructor(n: number) {
		this.n = n;
	}
	[Symbol.iterator]() {
		let i = 0;
		const n = this.n;
		return { next: () => (i < n ? { value: i++, done: false } : { value: undefined, done: true }) };
	}
}
const items: number[] = [];
for (const v of new Counted(3)) items.push(v as number);
console.log(items.join(), [...new Counted(2)].length, Array.from(new Counted(4)).join('-'));
const step = (k: number) => (k > 0 ? { value: k, done: false } : { value: undefined, done: true });
console.log(step(1).value, step(1).done, step(0).done);
const pick = (k: number) => (k > 0 ? { a: k } : { b: 'x', c: true });
console.log(JSON.stringify(pick(2)), JSON.stringify(pick(0)));
