// Iterated array destructuring with a rest element past the iterator's end, and annotated object patterns over untyped values.
function* two(): Generator<number> {
	yield 10;
	yield 20;
}

class Range {
	private limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	*[Symbol.iterator](): Generator<number> {
		for (let i = 1; i <= this.limit; i++) yield i;
	}
}

const [r1, r2, r3, ...rRest] = new Range(2);
const [m1, ...mRest] = new Range(4);
const [g1, g2, g3, ...gRest] = two();

console.log('top-range-short', r1, r2, r3, r3 === undefined, JSON.stringify(rRest));
console.log('top-range-long', m1, JSON.stringify(mRest));
console.log('top-gen-short', g1, g2, g3, g3 === undefined, JSON.stringify(gRest));

function localIterated() {
	const [a, b, c, ...rest] = new Range(2);
	const [head, ...tail] = two();
	console.log('local-range', a, b, c, c === undefined, JSON.stringify(rest));
	console.log('local-gen', head, JSON.stringify(tail));
}
localIterated();

const raw: any = JSON.parse('{"count": 2}');
const { title, count }: { title: string; count: number } = raw;
console.log('top-annotated', title, count, title === undefined);

function localAnnotated(input: any) {
	const { label, score }: { label: string; score: number } = input;
	console.log('local-annotated', label, score, label === undefined);
}
localAnnotated(JSON.parse('{"score": 7}'));
localAnnotated(JSON.parse('{"label": "ok", "score": 9}'));
