// An abstract member is no member at run time: a subclass's override is what every read and call finds, from the base's
// constructor too, where a subclass's field is not yet made and reads undefined.
abstract class Shape {
	seen: string;
	constructor() {
		this.seen = this.summary();
	}
	summary(): string {
		return `${this.label} ${this.unit} ${this.sides()}`;
	}
	abstract sides(): number;
	abstract kind: string;
	abstract get label(): string;
	abstract get unit(): string;
	abstract get scale(): number;
	abstract set scale(v: number);
	describe(): string {
		return `${this.label}: ${this.sides()} sides at ${this.scale}`;
	}
}
abstract class Polygon extends Shape {
	sides(): number {
		return 4;
	}
}
const scales = new Map<Square, number>();
class Square extends Polygon {
	unit = 'cm';
	kind = 'square';
	get label(): string {
		return 'square';
	}
	get scale(): number {
		return scales.get(this) ?? 1;
	}
	set scale(v: number) {
		scales.set(this, v * 2);
	}
}
class Triangle extends Shape {
	readonly label = 'triangle';
	kind = 'triangle';
	get unit(): string {
		return 'mm';
	}
	scale = 3;
	sides(): number {
		return 3;
	}
}
const shapes: Shape[] = [new Square(), new Triangle()];
for (const s of shapes) {
	console.log(s.seen, '|', s.describe(), '|', Object.keys(s).join());
	s.scale = 5;
	console.log(s.scale, 'sides' in s, 'label' in s, typeof s.sides);
}
