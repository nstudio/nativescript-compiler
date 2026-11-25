// A typed object's own [Symbol.toPrimitive] that throws for one hint: the template's string hint, `+`'s default hint
// and unary `+`'s number hint each run it.
class Picky {
	[Symbol.toPrimitive](hint: string): string | number {
		if (hint === 'number') throw new TypeError('no number');
		if (hint === 'default') throw new Error('no default');
		return 'picky';
	}
}
const p = new Picky();
console.log(`${p}`);
try { console.log(p + ''); } catch (e) { console.log('default', (e as Error).message); }
try { console.log(+p); } catch (e) { console.log('unary', (e as Error).message); }
