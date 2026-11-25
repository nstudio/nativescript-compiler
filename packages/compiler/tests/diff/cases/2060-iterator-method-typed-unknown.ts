// A [Symbol.iterator]() typed as no iterator: iterating its instance checks what it gives, as GetIterator does.
class Plain {
	n = 1;
}
class BadIter {
	[Symbol.iterator](): unknown {
		return 5;
	}
}
class NoNext {
	[Symbol.iterator](): unknown {
		return {};
	}
}
class Counted {
	[Symbol.iterator](): unknown {
		let i = 0;
		return { next: () => (i < 2 ? { value: i++, done: false } : { value: undefined, done: true }) };
	}
}
const cases: [string, unknown][] = [['plain', new Plain()], ['bad', new BadIter()], ['nonext', new NoNext()], ['counted', new Counted()]];
for (const [name, v] of cases) {
	const items: unknown[] = [];
	try {
		for (const item of v as any) items.push(item);
		console.log(name, 'forof', items.join());
	} catch (e) {
		console.log(name, 'forof', (e as Error).name, name === 'bad' ? (e as Error).message : '');
	}
	try {
		console.log(name, 'spread', [...(v as any)].length);
	} catch (e) {
		console.log(name, 'spread', (e as Error).name, name === 'bad' ? (e as Error).message : '');
	}
}
