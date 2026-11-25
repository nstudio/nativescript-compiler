// An array pattern reads its value through the value's iterator: one held untyped whatever it holds, an iterable class's.
function* gen() {
	try {
		yield 1;
		yield 2;
		yield 3;
	} finally {
		console.log('closed');
	}
}
class Pair {
	a: number;
	b: number;
	constructor(a: number, b: number) {
		this.a = a;
		this.b = b;
	}
	*[Symbol.iterator]() {
		yield this.a;
		yield this.b;
	}
}
const values: any[] = [[1, 2, 3], 'hé', new Set(['s', 't']), new Map([['k', 1]]), gen(), new Pair(4, 5), [7]];
for (const v of values) {
	const [first, second] = v;
	console.log(JSON.stringify(first), JSON.stringify(second));
}
const g: any = gen();
const [head, ...tail] = g;
console.log(head, tail);
const [x, y] = new Pair(8, 9);
console.log(x + y);
const [p, ...q] = new Pair(1, 2);
console.log(p, q.length, q[0] + 1);
for (const bad of [42, null, undefined, {}] as any[]) {
	try {
		const [one] = bad;
		console.log('no error', one);
	} catch (e) {
		console.log((e as Error).constructor.name, (e as Error).message);
	}
}
