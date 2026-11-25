// Targets of a destructuring assignment's pattern are written, a rest's too; a shorthand's default is read.
class Box {
	label = 'box';
	rest: { [k: string]: number } = {};
	count = 0;
}

const box = new Box();
const src = { a: 1, b: 2, c: 3 };
let a = 0;
({ a, ...box.rest } = src);
console.log(a, JSON.stringify(box.rest));

const fallback = { d: 7 };
let d: number;
({ d = fallback.d } = {} as { d?: number });
console.log(d, fallback.d);

[box.count, box.label] = [5, 'renamed'];
({ count: box.count, label: box.label } = { count: box.count + 1, label: box.label + '!' });
console.log(box.count, box.label);
