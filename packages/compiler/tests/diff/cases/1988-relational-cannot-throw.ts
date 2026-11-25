// Comparisons whose operands convert without running code stay plain: numbers, strings, booleans, dates and a class
// whose own valueOf cannot throw.
class Plain {
	constructor(readonly v: number) {}
	valueOf(): number { return this.v; }
}
const d1 = new Date(1000);
const d2 = new Date(2000);
const s: string = 'b';
console.log(1 < 2, s > 'a', true > false, d1 < d2, new Plain(1) < new Plain(2), String(4), String('x'), String(true));
