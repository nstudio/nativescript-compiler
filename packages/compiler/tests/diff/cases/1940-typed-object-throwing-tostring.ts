// A typed object whose class defines a toString that throws: a template, `+` beside a string and unary `+` run it,
// and what it throws reaches the `catch`.
class Fails {
	constructor(readonly ok: boolean) {}
	toString(): string {
		if (!this.ok) throw new Error('no string');
		return 'fails-ok';
	}
}
const good = new Fails(true);
const bad = new Fails(false);
console.log(`${good}`, 'x' + good, good + 'y');
try { console.log(`${bad}`); } catch (e) { console.log('template', (e as Error).message); }
try { console.log('x' + bad); } catch (e) { console.log('concat', (e as Error).message); }
try { console.log(bad + 'y'); } catch (e) { console.log('concat right', (e as Error).message); }
try { console.log(+bad); } catch (e) { console.log('unary', (e as Error).message); }
let s = 'z';
try { s += bad; } catch (e) { console.log('+=', (e as Error).message, s); }
