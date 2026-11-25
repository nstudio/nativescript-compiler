// A conversion method that throws through what it calls: the throws analysis follows the call, and a function that
// converts such an object throws to its caller.
function check(v: number): number {
	if (Number.isNaN(v)) throw new RangeError('not a number');
	return v;
}
class Reading {
	constructor(private readonly raw: string) {}
	valueOf(): number { return check(parseFloat(this.raw)); }
	toString(): string { return `reading ${check(parseFloat(this.raw))}`; }
}
function total(rs: Reading[]): number {
	let t = 0;
	for (const r of rs) t += +r;
	return t;
}
function describe(r: Reading): string {
	return `${r}!`;
}
console.log(total([new Reading('1.5'), new Reading('2')]), describe(new Reading('3')));
try { console.log(total([new Reading('1'), new Reading('x')])); } catch (e) { console.log('total', (e as Error).message); }
try { console.log(describe(new Reading('y'))); } catch (e) { console.log('describe', (e as Error).message); }
