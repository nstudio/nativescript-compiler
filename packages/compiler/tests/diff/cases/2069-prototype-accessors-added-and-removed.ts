// @lenient-both
// A class's prototype gaining and losing an accessor after its instances were read (`Property.register` defines one on a
// prototype), `key in` a symbol key on class instances, and loose equality, typeof and truthiness of class instances.
function define(cls: { prototype: any }, key: string, value: string): void {
	Object.defineProperty(cls.prototype, key, {
		get() {
			return value;
		},
		configurable: true,
	});
}
function undefine(cls: { prototype: any }, key: string): void {
	delete cls.prototype[key];
}

class Base {
	x = 1;
}
class Derived extends Base {}

const d: any = new Derived();
console.log('a', d.extra, 'extra' in d);
define(Base, 'extra', 'from-base');
console.log('b', d.extra, 'extra' in d);
define(Derived, 'extra', 'from-derived');
console.log('c', d.extra);
undefine(Derived, 'extra');
console.log('d', d.extra);
undefine(Base, 'extra');
console.log('e', d.extra, 'extra' in d);

const key = Symbol('key');
class Box {
	valueOf() {
		return 42;
	}
}
class Plain {
	x = 1;
}
const b: any = new Box();
const p: any = new Plain();
const zero: any = 0, empty: any = '', one: any = 1, a: any = 'a', nan: any = NaN;
console.log(key in p, p[key]);
p[key] = 5;
console.log(key in p, p[key], key in b);
console.log(b == 42, b == '42', p == '[object Object]', p == 'auto', empty == zero, one == '1', a == 'a', nan == nan);
console.log(typeof p, typeof b, typeof one, typeof a, typeof (one === 1), typeof nan);
console.log(!!p, !!b, !!zero, !!empty, !!a, !!nan);
