// `arguments` inside function expressions: length, indexing, spread, slice.call, apply, named params, untyped & typed slots.

const countAny: any = function () {
	return arguments.length;
};
console.log('countAny:', countAny(), countAny('a'), countAny('a', 'b', 'c'));

const sumAny: any = function () {
	let total = 0;
	for (let i = 0; i < arguments.length; i++) total += arguments[i];
	return total;
};
console.log('sumAny:', sumAny(1, 2, 3, 4), sumAny());

const sliceAny: any = function () {
	return Array.prototype.slice.call(arguments, 1);
};
console.log('sliceAny:', sliceAny('x', 'y', 'z').join(','));

const spreadAny: any = function () {
	return [...arguments].join('-');
};
console.log('spreadAny:', spreadAny(10, 20, 30));

function joinThree(a: string, b: string, c: string): string {
	return `${a}:${b}:${c}`;
}
const forwardAny: any = function () {
	return joinThree.apply(null, arguments as any);
};
console.log('forwardAny:', forwardAny('p', 'q', 'r'));

const named = function (a: number, b?: number) {
	return `${arguments.length}:${a}:${b ?? -1}`;
};
console.log('named:', named(5), named(5, 6));

const typedSlot: (a: number, b: number) => number = function (a, b) {
	return arguments.length * 100 + a + b;
};
console.log('typedSlot:', typedSlot(3, 4));
