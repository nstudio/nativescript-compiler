// `String(x)` converts by ToString with the string hint: an object's toString runs before its valueOf, and what it
// throws reaches the `catch`.
const big: any = 5n;
const bad: any = { valueOf() { throw new Error('no value'); } };
const loud: any = { toString() { throw new Error('no string'); } };
const both: any = { toString() { return 'str'; }, valueOf() { return 7; } };
console.log(String(big), String(bad), String(both), `${both}`, '' + both);
try { console.log(String(loud)); } catch (e) { console.log('loud', (e as Error).message); }
class T {
	toString(): string { throw new Error('t'); }
}
try { console.log(String(new T())); } catch (e) { console.log('class', (e as Error).message); }
function label(x: any): string {
	return String(x) + '!';
}
console.log(label(1), label(null), label(undefined), label([1, 2]));
try { console.log(label(loud)); } catch (e) { console.log('label', (e as Error).message); }
