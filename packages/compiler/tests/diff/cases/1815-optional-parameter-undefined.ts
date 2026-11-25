// An optional parameter left out holds undefined, which `??`, a default and a test against undefined all see.
function greet(name?: string, punct?: string): string {
	const who = name ?? 'world';
	return 'hello ' + who + (punct ?? '.') + (name === undefined ? ' (no name)' : '');
}
class Fmt {
	pad(n: number, width?: number): string {
		const w = width ?? 3;
		return String(n).padStart(w, '0') + (width === undefined ? '*' : '');
	}
}
console.log(greet(), greet('ana'), greet(undefined, '!'), greet('bo', undefined));
const f = new Fmt();
console.log(f.pad(7), f.pad(7, 5), f.pad(7, undefined));
