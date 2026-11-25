// An array pattern past an iterator's end binds undefined, whatever its names are typed: a generator, a class's own
// iterator, a Set, a Map's keys, each as a typed iterable.
function* two() {
	yield 1;
	yield 2;
}
const [a, b, c] = two() as Iterable<number>;
console.log(a, b, c, c === undefined, typeof c, JSON.stringify([a, c]));
class Words {
	*[Symbol.iterator]() {
		yield 'x';
	}
}
const [s, t] = new Words() as Iterable<string>;
console.log(s, t, t === undefined, `${t}`);
const words: Iterable<string> = new Set(['p']);
const [u, v] = words;
console.log(u, v, v === undefined);
const flags = new Map([[true, 1]]).keys() as Iterable<boolean>;
const [p, q] = flags;
console.log(p, q, q === undefined, String(q));
function firstTwo(it: Iterable<number>): number[] {
	const [m, n] = it;
	return n === undefined ? [m] : [m, n];
}
console.log(firstTwo(new Set([5])), firstTwo([6, 7]));
