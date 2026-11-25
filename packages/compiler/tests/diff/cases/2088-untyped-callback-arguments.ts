// A callback held untyped, given to an array's method: called with the element, its index and the array, as script
// calls it.
console.log(['1', '2', '3'].map(parseInt as any), ['10', '10', '10'].map(parseInt as any));
const seen: any = function (...args: unknown[]) {
	return args.length;
};
console.log([7, 8].map(seen), ['a'].filter(seen).length, [1, 2, 3].findIndex(seen), [0, 5].every(seen));
const log: any = (e: unknown, i: unknown, a: unknown) => console.log('each', e, i, Array.isArray(a));
['x', 'y'].forEach(log);
console.log([3, 4].some(parseInt as any), [1, 2].find(seen));
