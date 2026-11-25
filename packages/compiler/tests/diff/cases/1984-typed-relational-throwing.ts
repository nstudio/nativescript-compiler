// A typed object whose own valueOf may throw is compared by what can throw: its error reaches the `catch`.
class Reading {
	constructor(readonly value: number) {}
	valueOf(): number {
		if (Number.isNaN(this.value)) throw new Error('no reading');
		return this.value;
	}
}
const a = new Reading(3);
const b = new Reading(5);
console.log(a < b, a > b, a <= b, b >= a, +a < 4);
try { console.log(new Reading(NaN) < b); } catch (e) { console.log('lhs', (e as Error).message); }
try { console.log(a >= new Reading(NaN)); } catch (e) { console.log('rhs', (e as Error).message); }
function max(x: Reading, y: Reading): Reading {
	return x > y ? x : y;
}
console.log(max(a, b).value);
try { console.log(max(a, new Reading(NaN)).value); } catch (e) { console.log('max', (e as Error).message); }
