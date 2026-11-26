// Class expressions: anonymous, named, with constructors/fields/methods/statics, extending base classes, and subclassed.

const inline = new (class {
	x = 1;
	y = 2;
	sum() {
		return this.x + this.y;
	}
})();
console.log('inline:', inline.x, inline.y, inline.sum());

const inlineCtor = new (class {
	constructor(public a: number, public b: number) {}
	product() {
		return this.a * this.b;
	}
})(6, 7);
console.log('inlineCtor:', inlineCtor.a, inlineCtor.b, inlineCtor.product());

const Point = class {
	x: number;
	y: number;
	constructor(x: number, y: number) {
		this.x = x;
		this.y = y;
	}
	static origin() {
		return new Point(0, 0);
	}
	distSq() {
		return this.x * this.x + this.y * this.y;
	}
};
const p = new Point(3, 4);
const o = Point.origin();
console.log('Point:', p.distSq(), o.x, o.y, p instanceof Point);

const Boxed = class Box {
	static tag = 'box';
	constructor(public value: string) {}
};
const b = new Boxed('hello');
console.log('Boxed:', Boxed.tag, b.value, b instanceof Boxed);

class Base {
	baseVal = 10;
	greet() {
		return 'hi';
	}
}
const Sub = class extends Base {
	extra = 5;
	override greet() {
		return super.greet() + '!';
	}
};
const sub = new Sub();
console.log('Sub:', sub.baseVal, sub.extra, sub.greet(), sub instanceof Base, sub instanceof Sub);

class SubPoint extends Point {
	z: number;
	constructor(x: number, y: number, z: number) {
		super(x, y);
		this.z = z;
	}
}
const sp = new SubPoint(1, 2, 3);
console.log('SubPoint:', sp.x, sp.y, sp.z, sp instanceof Point, sp instanceof SubPoint);
