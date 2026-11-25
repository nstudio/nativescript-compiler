// `x[Symbol.iterator]()` of a value held untyped: an iterator's is the iterator itself; an iterable's a fresh iterator.
function* gen() {
	yield 1;
	yield 2;
}
const sources: [string, any][] = [
	['keys', ['a', 'b'].keys()],
	['entries', new Map([['k', 1]]).entries()],
	['values', new Set([1, 2]).values()],
	['string', 'ab'[Symbol.iterator]()],
	['generator', gen()],
];
for (const [name, it] of sources) {
	const self = it[Symbol.iterator]();
	console.log(name, self === it, JSON.stringify(self.next()), JSON.stringify(it.next()));
}
const arr: any = [1, 2];
const a1 = arr[Symbol.iterator]();
console.log(a1 === arr[Symbol.iterator](), a1.next().value, [...a1].join());
class Range {
	i = 0;
	[Symbol.iterator]() {
		return this;
	}
	next() {
		return this.i < 2 ? { value: this.i++, done: false } : { value: 0, done: true };
	}
}
const r: any = new Range();
console.log(r[Symbol.iterator]() === r, [...r].join());
const lit: any = {
	[Symbol.iterator]() {
		let n = 0;
		return { next: () => ({ value: n, done: n++ > 1 }) };
	},
};
console.log(JSON.stringify(lit[Symbol.iterator]().next()), [...lit].join());
