// A shorthand property (`{ name }`) reads the variable or function its name refers to.
let count = 1;
const label = 'box';
function double(x: number): number {
	return x * 2;
}
const optional: string | undefined = undefined;

count += 2;
const bag = { count, label, double, optional };
console.log(bag.count, bag.label, bag.double(bag.count), bag.optional === undefined, 'optional' in bag);
count = 10;
console.log(bag.count, { count }.count);

function make(items: number[]) {
	const total = items.reduce((a, b) => a + b, 0);
	return { items, total, first: items[0] };
}
const made = make([3, 4]);
console.log(made.total, made.items.length, made.first);
