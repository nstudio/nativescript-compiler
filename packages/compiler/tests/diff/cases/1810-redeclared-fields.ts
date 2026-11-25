// @lenient-both
// A field a subclass declares again over its base's field, accessor or parameter property: one property per object,
// read and written through the subclass's declaration.
class Base {
	static count = 1;
	label = 'base';
	constructor(public size: number, readonly kind: string) {}
	get title(): string {
		return 'title of ' + this.label;
	}
	set title(v: string) {
		this.label = v;
	}
}

class Derived extends Base {
	static count = 2;
	declare label: string;
	size = 7;
	constructor(override readonly kind: string, extra: number) {
		super(extra, kind);
	}
}

const d = new Derived('derived', 3);
console.log(d.label, d.size, d.kind, d.title, Base.count, Derived.count);
d.title = 'renamed';
d.size += 1;
console.log(d.label, d.size, d.title, JSON.stringify(d));
