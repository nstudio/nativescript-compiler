// `set` of an untyped source reads it as an array-like, length first, each index read and converted in turn; and a
// numeric key written on a typed array held untyped converts the value, what that throws reaching the program.
function attempt(label: string, f: () => unknown): void {
	try {
		f();
		console.log(label, 'done');
	} catch (e) {
		console.log(label, e instanceof TypeError ? 'TypeError' : e instanceof RangeError ? 'RangeError' : (e as Error).message);
	}
}
const ta = new Float64Array(4);
const source: any = { length: 2, 0: 1, 1: '2' };
ta.set(source, 1);
const text: any = '56';
ta.set(text);
const primitive: any = 7;
ta.set(primitive, 2);
console.log(ta.join());
const iterableOnly: any = new Set([9]);
ta.set(iterableOnly);
console.log(ta.join());
const lengthThrows: any = { get length() { throw new Error('length'); } };
attempt('length throws', () => ta.set(lengthThrows));
const valueThrows: any = { length: 2, 0: 3, 1: { valueOf() { throw new Error('value'); } } };
attempt('value throws', () => ta.set(valueThrows));
console.log(ta.join());
const long: any = { length: 5 };
attempt('too long', () => ta.set(long));
attempt('negative offset', () => ta.set(source, -1));
const held: any = new Int8Array(2);
attempt('index write', () => { held[0] = { valueOf() { throw new Error('index'); } }; });
attempt('fraction write', () => { held['1.5'] = { valueOf() { throw new Error('fraction'); } }; });
held[1] = '12';
console.log(held.join());
