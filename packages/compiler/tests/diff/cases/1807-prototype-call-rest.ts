// `Base.prototype.m.call(obj, …)` runs Base's own `m` whatever obj's class overrides, a method with a rest parameter too.
class Base {
	sum(...xs: number[]): string {
		return 'base ' + xs.reduce((a, b) => a + b, 0);
	}
	tag(label: string): string {
		return 'base ' + label;
	}
}

class Derived extends Base {
	sum(...xs: number[]): string {
		return 'derived ' + xs.length + ' / ' + Base.prototype.sum.call(this, ...xs);
	}
	tag(label: string): string {
		return 'derived / ' + Base.prototype.tag.call(this, label);
	}
}

const d = new Derived();
console.log(d.sum(1, 2, 3));
console.log(d.tag('x'));
console.log(Base.prototype.sum.call(d, 4, 5));
