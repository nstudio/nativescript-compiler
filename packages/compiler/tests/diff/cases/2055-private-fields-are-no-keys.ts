// A private field (`#name`) is no property: no key, no member by name, not in JSON, nor `in` by its spelling.
class Counter {
	#count = 0;
	label = 'c';
	bump(): number {
		return ++this.#count;
	}
}
class Named extends Counter {
	#name = 'n';
	kind = 'named';
	get name(): string {
		return this.#name;
	}
}
const c = new Counter();
c.bump();
const n = new Named();
console.log(Object.keys(c).join(), JSON.stringify(c), '#count' in c);
console.log(Object.keys(n).join(), JSON.stringify(n), Object.entries(n).length, n.name, n.bump());
for (const k in n) console.log('key', k);
class Hidden {
	static #made = 0;
	static count = 1;
	#secret(): number {
		return 1;
	}
	get #twice(): number {
		return 2;
	}
	open = Hidden.#made + this.#secret() + this.#twice;
}
const h = new Hidden();
const byName = h as unknown as Record<string, unknown>;
console.log(Object.keys(h).join(), JSON.stringify(h), String(byName['#secret']), '#twice' in h, String(byName['#made']));
