// @refused-swift a getter that throws beside a setter
// An object literal whose getter throws and which also has a setter: the get throws, the set runs.
let stored = 0;
const o = {
	get v(): number {
		throw new Error('no read');
	},
	set v(x: number) {
		stored = x;
	},
};
o.v = 4;
console.log('stored', stored);
try {
	console.log(o.v);
} catch (e) {
	console.log('get threw', (e as Error).message);
}
