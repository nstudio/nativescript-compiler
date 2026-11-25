// A typed object whose class defines a valueOf that throws: unary `+` and `+` beside a string run it, and what it
// throws reaches the `catch`; a template runs toString first, which is Object's.
class Meter {
	constructor(readonly n: number) {}
	valueOf(): number {
		if (this.n < 0) throw new RangeError(`negative ${this.n}`);
		return this.n;
	}
}
const m = new Meter(4);
const neg = new Meter(-1);
console.log(+m, `${m}`, 'm' + m, Math.max(+m, 2));
try { console.log(+neg); } catch (e) { console.log('unary', (e as Error).name, (e as Error).message); }
try { console.log('neg ' + neg); } catch (e) { console.log('concat', (e as Error).name, (e as Error).message); }
let total = 0;
try { total += +neg; } catch (e) { console.log('add', (e as Error).name, (e as Error).message, total); }
