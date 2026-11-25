// `x instanceof Object`: true of every object and function, false of null, undefined and the primitives, and of an
// object made with a null prototype.
class Point {
	x = 1;
}
const values: [string, any][] = [
	['null', null],
	['undefined', undefined],
	['number', 1],
	['string', 's'],
	['boolean', true],
	['literal', { a: 1 }],
	['array', [1, 2]],
	['function', () => 1],
	['instance', new Point()],
	['map', new Map()],
	['date', new Date(0)],
	['error', new Error('e')],
	['nullProto', Object.create(null)],
	['protoChild', Object.create({ a: 1 })],
];
for (const [name, v] of values) console.log(name, v instanceof Object);
const typed: Point = new Point();
const list: number[] = [1];
console.log(typed instanceof Object, list instanceof Object);
