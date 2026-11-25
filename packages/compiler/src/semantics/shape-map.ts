// ShapeMap: the classes a translation names for object shapes, by shape and by name.

/**
 * A translation's object shapes by key (their fields' names and types, `typeName`'s), in the order they were made, and
 * by the name of the class each is written as: names are unique, as a shape takes a free one when it is made.
 */
export class ShapeMap<S extends { readonly name: string }> extends Map<string, S> {
	private readonly byName = new Map<string, S>();

	override set(key: string, shape: S): this {
		const old = super.get(key);
		if (old) this.byName.delete(old.name);
		this.byName.set(shape.name, shape);
		return super.set(key, shape);
	}

	override delete(key: string): boolean {
		const old = super.get(key);
		if (old && this.byName.get(old.name) === old) this.byName.delete(old.name);
		return super.delete(key);
	}

	override clear(): void {
		this.byName.clear();
		super.clear();
	}

	/** The shape written as the class `name`. */
	named(name: string): S | undefined {
		return this.byName.get(name);
	}

	/** `name` itself, or with as many `_` after it as no shape's class has it already. */
	freeName(name: string): string {
		let free = name;
		while (this.byName.has(free)) free += '_';
		return free;
	}

	/**
	 * The shape of `key`: the one made already, else `make`'s, made now under the first free name from `name`. The one
	 * step that makes a shape: spelling a type requires its shape, inside a `question` only until the question ends.
	 */
	require(key: string, name: string, make: (name: string) => S): S {
		let s = this.get(key);
		if (!s) this.set(key, (s = make(this.freeName(name))));
		return s;
	}

	/**
	 * `f`'s answer, keeping none of the shapes the types it reads require: a question's answer is the same whether or not
	 * code is written there, and only code written requires a shape. Names stay as they were taken inside `f`, so a type
	 * spelled there and spelled again where code is written names one shape.
	 */
	question<T>(f: () => T): T {
		const made = this.size;
		try {
			return f();
		} finally {
			this.truncate(made);
		}
	}

	/** Removes the shapes made after the first `size`. */
	truncate(size: number): void {
		if (this.size <= size) return;
		let k = 0;
		const later: string[] = [];
		for (const key of this.keys()) if (k++ >= size) later.push(key);
		for (const key of later) this.delete(key);
	}
}
