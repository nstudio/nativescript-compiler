// What a getter or setter throws reaches the code reading or writing it however it reads or writes: an optional chain,
// a destructuring, a logical assignment, a static accessor.
class Gauge {
	static #limit = 10;
	static get limit(): number {
		return Gauge.#limit;
	}
	static set limit(v: number) {
		if (v <= 0) throw new RangeError('limit ' + v);
		Gauge.#limit = v;
	}
	#level: number | undefined = undefined;
	get level(): number | undefined {
		if (this.#level !== undefined && this.#level > Gauge.limit) throw new RangeError('over ' + this.#level);
		return this.#level;
	}
	set level(v: number | undefined) {
		if (v !== undefined && v < 0) throw new RangeError('under ' + v);
		this.#level = v;
	}
}
const g = new Gauge();
const maybe: Gauge | undefined = Math.random() < 2 ? g : undefined;
const attempts: (() => unknown)[] = [
	() => (g.level ??= -1),
	() => (g.level = 4),
	() => (g.level ??= -1),
	() => (maybe!.level = 20),
	() => maybe?.level,
	() => {
		const { level } = g;
		return level;
	},
	() => (Gauge.limit = 0),
	() => (Gauge.limit = 30),
	() => g.level,
];
for (let k = 0; k < attempts.length; k++) {
	try {
		console.log(k, 'gives', attempts[k]());
	} catch (e) {
		console.log(k, 'throws', (e as Error).message);
	}
}
