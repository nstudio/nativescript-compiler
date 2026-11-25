// An interface declaring toString: a class implementing it and an object literal of its type each convert by their own.
interface Named {
	toString(): string;
	readonly id: number;
}
class N implements Named {
	readonly id: number;
	constructor(id: number) { this.id = id; }
	toString(): string { return `N${this.id}`; }
}
function show(x: Named): string {
	return `<${x}> ${x.toString()} ${String(x)} ${'' + x}`;
}
console.log(show(new N(1)));
const lit: Named = { id: 2, toString() { return 'lit'; } };
console.log(show(lit));
const names: Named[] = [new N(3), lit];
console.log(names.join(','), names.map(String).join('|'));
