// `for…of` over an untyped value steps through its iterator as the body runs: one `next()` a pass, so an array pushed to
// while it is iterated visits the new elements, a generator's effects interleave with the body, and leaving early closes
// the iterator (a generator's finally runs, what a `return()` throws after `break` reaches the program).
const arr: any = [1, 2, 3];
const seen: number[] = [];
for (const x of arr) {
	seen.push(x);
	if (x < 3) arr.push(x * 10);
}
console.log(seen.join(','));

function* steps() {
	console.log('gen 1');
	yield 1;
	console.log('gen 2');
	yield 2;
	console.log('gen end');
}
const gen: any = steps();
for (const x of gen) console.log('body', x);

function* guarded() {
	try {
		yield 1;
		yield 2;
	} finally {
		console.log('guarded finally');
	}
}
const g2: any = guarded();
for (const x of g2) {
	console.log('guarded', x);
	break;
}
let again = 0;
for (const x of g2) again += x;
console.log('after guarded', again);

const throwing: any = {
	[Symbol.iterator]() {
		let i = 0;
		return {
			next() {
				return { value: i++, done: i > 3 };
			},
			return() {
				throw new Error('from return');
			},
		};
	},
};
try {
	for (const x of throwing) if (x === 1) break;
	console.log('no error');
} catch (e) {
	console.log('caught', (e as Error).message);
}

function first(values: any): any {
	for (const v of values) return v;
	return 'none';
}
console.log(first(guarded()), first([]), first('hé'));

const pairs: any = [
	['a', 1],
	['b', 2],
];
for (const [k, v] of pairs) {
	console.log(k, v);
	if (k === 'a') pairs.push(['c', 3]);
}

let last: any;
const letters: any = ['x', 'y'];
for (last of letters) if (last === 'x') letters.push('z');
console.log('last', last);

const str: any = 'a😀b';
const chars: string[] = [];
for (const c of str) chars.push(c);
console.log(chars.length, chars.join('|'));

try {
	const n: any = 42;
	for (const x of n) console.log(x);
} catch (e) {
	console.log('not iterable', e instanceof TypeError);
}
