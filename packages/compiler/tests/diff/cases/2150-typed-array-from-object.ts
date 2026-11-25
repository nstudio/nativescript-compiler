// A typed array of an untyped object: the values its [Symbol.iterator] gives when it has one, else its length and
// indexes; each value converted as it is written, and what the iterator, a getter or a conversion throws reaches the program.
function attempt(label: string, f: () => unknown): void {
	try {
		console.log(label, String(f()));
	} catch (e) {
		console.log(label, e instanceof TypeError ? 'TypeError' : e instanceof RangeError ? 'RangeError' : (e as Error).message);
	}
}
const iterable: any = { [Symbol.iterator]: () => [1, 2.5, '3'].values() };
console.log(new Float64Array(iterable).join(), new Uint8Array(iterable).join(), Float32Array.from(iterable).join());
const set: any = new Set([4, 5]);
console.log(new Int16Array(set).join());
const order: string[] = [];
const likes: any = { length: 2, 0: { valueOf: () => (order.push('v0'), 7) }, 1: { valueOf: () => (order.push('v1'), 8) } };
console.log(new Float32Array(likes).join(), order.join());
const iteratorThrows: any = { [Symbol.iterator]() { throw new Error('iterator'); } };
attempt('iterator throws', () => new Float64Array(iteratorThrows));
const nextThrows: any = { [Symbol.iterator]: () => ({ next() { throw new Error('next'); } }) };
attempt('next throws', () => new Int8Array(nextThrows));
const lengthThrows: any = { get length() { throw new Error('length'); } };
attempt('length throws', () => new Uint16Array(lengthThrows));
const valueThrows: any = [1, { valueOf() { throw new Error('value'); } }];
attempt('value throws', () => new Float64Array(valueThrows));
const huge: any = { length: 2 ** 53 - 1 };
attempt('huge', () => new Float64Array(huge));
const bigs: any = { [Symbol.iterator]: () => [1n, 2n].values() };
console.log(new BigInt64Array(bigs).join());
const mixed: any = [{ valueOf: () => 7n }, '8', true];
console.log(new BigUint64Array(mixed).join());
const numbers: any = [1];
const bigIntValues: any = [1n];
attempt('number into bigint', () => new BigInt64Array(numbers));
attempt('bigint into float', () => new Float64Array(bigIntValues));
const buffer: any = new Float64Array([1, 2, 3]).buffer;
console.log(new Float64Array(buffer, 8, 1).join(), new Float64Array(buffer, 16).join());
