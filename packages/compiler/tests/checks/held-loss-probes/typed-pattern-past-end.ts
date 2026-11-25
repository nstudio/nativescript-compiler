// An array pattern past an iterator's end binds undefined, whatever the names are typed.
function* two() {
	yield 1;
	yield 2;
}
const [a, b, c] = two() as Iterable<number>;
console.log(a, b, c);
const words: Iterable<string> = new Set(['x']);
const [s, t] = words;
console.log(s, t === undefined);
const flags = new Map([[true, 1]]).keys() as Iterable<boolean>;
const [p, q] = flags;
console.log(p, q);
