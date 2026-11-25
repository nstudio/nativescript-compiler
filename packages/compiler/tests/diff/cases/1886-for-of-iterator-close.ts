// IteratorClose as `for…of` runs it: every exit but a throw (break, a labeled break or continue to an outer loop, return)
// calls `return()` once, after the body's own finally blocks and outside its catch blocks, and what `return()` throws, or a
// result that is no object (TypeError), reaches the program; a throw leaving the loop wins over both; an exhausted
// iterator is not closed; nested loops close inner first; generators run their finally blocks.
const log: string[] = [];

class Counter {
	constructor(
		readonly name: string,
		readonly mode: 'ok' | 'throws' | 'primitive' | 'none',
	) {}
	[Symbol.iterator](): Iterator<number> {
		let i = 0;
		const name = this.name;
		const mode = this.mode;
		if (mode === 'none') return { next: () => ({ value: i++, done: i > 3 }) };
		return {
			next: () => ({ value: i++, done: i > 3 }),
			return: (): IteratorResult<number> => {
				log.push('return ' + name);
				if (mode === 'throws') throw new Error('from return ' + name);
				if (mode === 'primitive') return 7 as unknown as IteratorResult<number>;
				return { value: undefined, done: true };
			},
		};
	}
}

function run(label: string, f: () => string | void): void {
	try {
		const r = f();
		console.log(label, 'ok', r === undefined ? '' : r, '|', log.join(','));
	} catch (e) {
		console.log(label, e instanceof TypeError ? 'TypeError' : (e as Error).message, '|', log.join(','));
	}
	log.length = 0;
}

run('exhausted', () => {
	for (const x of new Counter('a', 'throws')) log.push('x' + x);
});
run('break', () => {
	for (const x of new Counter('a', 'throws')) if (x === 1) break;
});
run('break ok', () => {
	for (const x of new Counter('a', 'ok')) if (x === 1) break;
	log.push('after');
});
run('break primitive', () => {
	for (const x of new Counter('a', 'primitive')) if (x === 0) break;
});
run('break no return', () => {
	for (const x of new Counter('a', 'none')) if (x === 1) break;
	log.push('after');
});
run('throw', () => {
	for (const x of new Counter('a', 'throws')) if (x === 1) throw new Error('from body');
});
run('throw primitive', () => {
	for (const x of new Counter('a', 'primitive')) if (x === 1) throw new Error('from body');
});
run('return', () => {
	for (const x of new Counter('a', 'throws')) if (x === 2) return 'r' + x;
	return 'end';
});
run('return value first', () => {
	for (const x of new Counter('a', 'ok')) {
		if (x === 1) return (log.push('value'), 'v');
	}
	return 'end';
});
run('return ok', () => {
	for (const x of new Counter('a', 'ok')) if (x === 2) return 'r' + x;
	return 'end';
});
run('labeled break', () => {
	outer: for (const y of new Counter('o', 'ok')) {
		for (const x of new Counter('i', 'throws')) {
			if (x === 1) break outer;
		}
		log.push('unreached ' + y);
	}
});
run('continue outer', () => {
	outer: for (const y of new Counter('o', 'ok')) {
		log.push('y' + y);
		for (const x of new Counter('i', 'ok')) {
			if (x === 1) continue outer;
		}
	}
});
run('continue outer throws', () => {
	outer: for (const y of new Counter('o', 'ok')) {
		log.push('y' + y);
		for (const x of new Counter('i', 'throws')) {
			if (x === 1) continue outer;
		}
	}
});
run('labeled block', () => {
	block: {
		for (const x of new Counter('a', 'throws')) if (x === 0) break block;
		log.push('unreached');
	}
});
run('nested return', () => {
	for (const y of new Counter('o', 'throws')) {
		for (const x of new Counter('i', 'throws')) if (x === y + 1) return 'r';
	}
	return 'end';
});
run('nested return inner ok', () => {
	for (const y of new Counter('o', 'throws')) {
		for (const x of new Counter('i', 'ok')) if (x === y + 1) return 'r';
	}
	return 'end';
});
run('finally first', () => {
	for (const x of new Counter('a', 'ok')) {
		try {
			if (x === 1) return 'r';
		} finally {
			log.push('finally ' + x);
		}
	}
	return 'end';
});
run('catch skipped', () => {
	for (const x of new Counter('a', 'throws')) {
		try {
			if (x === 1) return 'r';
		} catch (e) {
			log.push('caught inside');
		}
	}
	return 'end';
});
run('caught inside body', () => {
	for (const x of new Counter('a', 'throws')) {
		try {
			if (x === 1) throw new Error('inner');
		} catch (e) {
			log.push('caught ' + (e as Error).message);
		}
	}
});
run('switch break', () => {
	for (const x of new Counter('a', 'throws')) {
		switch (x) {
			case 1:
				break;
			default:
				log.push('d' + x);
		}
	}
});
run('destructured', () => {
	const pairs = {
		*[Symbol.iterator]() {
			try {
				yield ['a', '1'];
				yield ['b', '2'];
			} finally {
				log.push('gen finally');
			}
		},
	};
	for (const [k, v] of pairs) {
		log.push(k + v);
		if (v === '1') break;
	}
});

function* gen(): Generator<number> {
	try {
		yield 1;
		yield 2;
		yield 3;
	} finally {
		log.push('gen finally');
	}
}
function* genThrows(): Generator<number> {
	try {
		yield 1;
		yield 2;
	} finally {
		// eslint-disable-next-line no-unsafe-finally
		throw new Error('from gen finally');
	}
}
run('generator break', () => {
	for (const x of gen()) if (x === 2) break;
});
run('generator exhausted', () => {
	for (const x of gen()) log.push('x' + x);
});
run('generator finally throws', () => {
	for (const x of genThrows()) if (x === 1) break;
});
run('generator finally throws, body throws', () => {
	for (const x of genThrows()) if (x === 1) throw new Error('from body');
});
run('generator return', () => {
	for (const x of gen()) if (x === 1) return 'r';
	return 'end';
});
run('generator reused', () => {
	const reused = gen();
	for (const x of reused) if (x === 1) break;
	for (const x of reused) log.push('again ' + x);
});
