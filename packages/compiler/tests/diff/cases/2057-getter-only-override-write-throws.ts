// A setter alone reads undefined; a subclass's getter alone over its base's get/set pair is the instance's
// property, whose setter is undefined: a write through the base's type throws (class code is strict).
class SetOnly {
	private v = 0;
	set only(n: number) {
		this.v = n;
	}
	get value(): number {
		return this.v;
	}
}
const x = new SetOnly();
x.only = 5;
console.log(String((x as unknown as { only: unknown }).only), typeof (x as unknown as { only: unknown }).only);
console.log('only' in x, JSON.stringify(x), Object.keys(x).join());
console.log(x.value);

class Base {
	protected _x = 1;
	get x(): number {
		return this._x;
	}
	set x(n: number) {
		this._x = n;
	}
}
class Sub extends Base {
	get x(): number {
		return this._x * 10;
	}
}
class Leaf extends Sub {}
function write(target: Base, label: string): void {
	try {
		target.x = 7;
		console.log(label, 'no throw');
	} catch (e) {
		console.log(label, 'caught', (e as Error).name, (e as Error).message);
	}
	try {
		target.x += 1;
		console.log(label, 'no throw');
	} catch (e) {
		console.log(label, 'compound', (e as Error).message);
	}
}
const s = new Sub();
write(s, 'sub');
write(new Leaf(), 'leaf');
console.log(s.x, JSON.stringify(s), Object.keys(s).join());
const b = new Base();
write(b, 'base');
console.log(b.x);
