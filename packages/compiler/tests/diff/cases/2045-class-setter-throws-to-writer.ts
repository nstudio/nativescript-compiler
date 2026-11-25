// A class's setter that throws throws to the write: a catch around the write sees what it threw, and the write after
// it runs. So does its getter beside it, and a static one.
class Temperature {
	private c = 0;
	get celsius(): number {
		if (this.c > 100) throw new RangeError('too hot to read');
		return this.c;
	}
	set celsius(v: number) {
		if (v < -273) throw new RangeError('below absolute zero: ' + v);
		this.c = v;
	}
	set label(v: string) {
		if (v.length === 0) throw new Error('empty label');
		console.log('label', v);
	}
	static #unit = 'C';
	static get unit(): string {
		return Temperature.#unit;
	}
	static set unit(u: string) {
		if (u !== 'C' && u !== 'F') throw new TypeError('unit ' + u);
		Temperature.#unit = u;
	}
}
const t = new Temperature();
t.celsius = 20;
try {
	t.celsius = -300;
	console.log('not reached');
} catch (e) {
	console.log('caught', (e as Error).name, (e as Error).message);
}
console.log('after', t.celsius);
try {
	t.celsius -= 400;
} catch (e) {
	console.log('compound', (e as Error).message);
}
t.celsius = 150;
try {
	console.log(t.celsius);
} catch (e) {
	console.log('read', (e as Error).message);
}
try {
	t.label = '';
} catch (e) {
	console.log('label threw', (e as Error).message);
}
t.label = 'ok';
try {
	Temperature.unit = 'K';
} catch (e) {
	console.log('static', (e as Error).name, (e as Error).message);
}
console.log(Temperature.unit);
function set(x: Temperature, v: number): string {
	try {
		x.celsius = v;
		return 'set ' + v;
	} catch (e) {
		return 'refused ' + v;
	} finally {
		console.log('finally', v);
	}
}
console.log(set(t, 5), set(t, -500));
class Stored {
	protected v = 0;
	get value(): number {
		return this.v;
	}
	set value(x: number) {
		this.v = x;
	}
}
class Checked extends Stored {
	override get value(): number {
		return super.value;
	}
	override set value(x: number) {
		if (x < 0) throw new RangeError('negative ' + x);
		super.value = x;
	}
}
const b: Stored = new Checked();
try {
	b.value = -1;
} catch (e) {
	console.log('through the base', (e as Error).message);
}
b.value = 3;
function lower(x: Stored, by: number): number {
	x.value -= by;
	return x.value;
}
console.log(lower(b, 1));
try {
	lower(b, 10);
} catch (e) {
	console.log('lower', (e as Error).message, b.value);
}
try {
	const before = b.value--;
	console.log('before', before);
	b.value--;
	b.value--;
} catch (e) {
	console.log('decrement', (e as Error).message, b.value);
}
