interface Named {
	toString(): string;
}
class N implements Named {
	readonly n: string;
	constructor(n: string) { this.n = n; }
	toString(): string { return `N(${this.n})`; }
}
function show(x: Named): string { return `<${x}> ` + x.toString(); }
console.log(show(new N('a')));
const lit: Named = { toString() { return 'lit'; } };
console.log(show(lit));
