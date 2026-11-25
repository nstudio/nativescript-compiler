// Typed objects whose conversions cannot throw keep converting in every place: a toString and valueOf that only
// compute, an inherited one, and a class with neither.
class Point {
	constructor(readonly x: number, readonly y: number) {}
	toString(): string { return `(${this.x}, ${this.y})`; }
	valueOf(): number { return Math.hypot(this.x, this.y); }
}
class Named extends Point {}
class Plain {
	readonly v = 1;
}
const p = new Point(3, 4);
const q = new Named(6, 8);
console.log(`${p}`, "p=" + p, String(p), +p, +q + 1, `${q}`, q > p);
console.log(`${new Plain()}`, 'plain ' + new Plain(), String(new Plain()));
function sum(a: Point, b: Point): number {
	return +a + +b;
}
console.log(sum(p, q));
