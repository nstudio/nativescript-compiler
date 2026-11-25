// A value typed by an interface converts by what can throw where a class implementing it throws in its conversion.
interface Labeled {
	readonly id: number;
}
class Fine implements Labeled {
	constructor(readonly id: number) {}
	toString(): string { return `fine#${this.id}`; }
}
class Strict implements Labeled {
	constructor(readonly id: number) {}
	toString(): string {
		if (this.id === 0) throw new Error('id 0 has no label');
		return `strict#${this.id}`;
	}
}
function tag(l: Labeled): string {
	return `<${l}>`;
}
console.log(tag(new Fine(1)), tag(new Strict(2)));
try { console.log(tag(new Strict(0))); } catch (e) { console.log('tag', (e as Error).message); }
