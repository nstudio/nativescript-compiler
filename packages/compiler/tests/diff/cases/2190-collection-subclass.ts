// Subclassing built-in Map and Set with constructors, fields, and overridden methods.

class TrackedMap<K, V> extends Map<K, V> {
	writes = 0;
	deletes = 0;

	override set(key: K, value: V): this {
		this.writes++;
		super.set(key, value);
		return this;
	}

	override delete(key: K): boolean {
		const removed = super.delete(key);
		if (removed) this.deletes++;
		return removed;
	}

	override clear(): void {
		this.writes = 0;
		super.clear();
	}
}

class KeyedMap<K, V> extends Map<K, V> {
	private hashFn: (k: K) => string;
	private byHash = new Map<string, [K, V]>();

	constructor(hashFn: (k: K) => string) {
		super();
		this.hashFn = hashFn;
	}

	override set(key: K, value: V): this {
		const h = this.hashFn(key);
		this.byHash.set(h, [key, value]);
		super.set(key, value);
		return this;
	}

	override get(key: K): V | undefined {
		const found = this.byHash.get(this.hashFn(key));
		return found ? found[1] : undefined;
	}

	override has(key: K): boolean {
		return this.byHash.has(this.hashFn(key));
	}

	override delete(key: K): boolean {
		super.delete(key);
		return this.byHash.delete(this.hashFn(key));
	}
}

class TrackedSet<T> extends Set<T> {
	label: string;
	addCount = 0;

	constructor(label: string) {
		super();
		this.label = label;
	}

	override add(value: T): this {
		this.addCount++;
		super.add(value);
		return this;
	}

	override delete(value: T): boolean {
		return super.delete(value);
	}
}

const tm = new TrackedMap<string, number>();
tm.set('a', 1).set('b', 2);
console.log('tm:', tm instanceof Map, tm instanceof TrackedMap, tm.size, tm.writes, tm.get('a'), tm.has('b'));
console.log('tm del:', tm.delete('a'), tm.delete('z'), tm.deletes, tm.size);
const entries: string[] = [];
for (const [k, v] of tm) entries.push(`${k}=${v}`);
console.log('tm iter:', entries.join(','));
tm.clear();
console.log('tm clear:', tm.size, tm.writes);

const tm2 = new TrackedMap<string, number>([['x', 10], ['y', 20]]);
console.log('tm2:', tm2.size, tm2.get('x'), tm2.get('y'));

const km = new KeyedMap<{ id: number }, string>((k) => `id:${k.id}`);
km.set({ id: 1 }, 'one');
km.set({ id: 2 }, 'two');
console.log('km:', km instanceof Map, km instanceof KeyedMap, km.get({ id: 1 }), km.has({ id: 2 }), km.has({ id: 3 }));
console.log('km del:', km.delete({ id: 1 }), km.has({ id: 1 }));

const ts = new TrackedSet<string>('tags');
ts.add('red').add('blue').add('red');
console.log('ts:', ts instanceof Set, ts instanceof TrackedSet, ts.label, ts.size, ts.addCount, ts.has('red'));
console.log('ts del:', ts.delete('red'), ts.size);
const vals: string[] = [];
for (const v of ts) vals.push(v);
console.log('ts iter:', vals.join(','));
