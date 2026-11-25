// A `for…of` whose body does not suspend, in an async function or a generator: `return` evaluates its value, then
// calls the iterator's `return()`, whose throw replaces the return (the promise rejects, the generator's caller sees
// it); `break` closes the same way; a throw leaving the loop wins over `return()`'s.
const log: string[] = [];

class Counter {
	constructor(readonly throws: boolean) {}
	[Symbol.iterator](): Iterator<number> {
		let i = 0;
		const throws = this.throws;
		return {
			next: () => ({ value: i++, done: i > 3 }),
			return: (): IteratorResult<number> => {
				log.push('return');
				if (throws) throw new Error('from return');
				return { value: undefined, done: true };
			},
		};
	}
}
const untyped = (throws: boolean): any => new Counter(throws);
const value = (v: string): string => {
	log.push('value ' + v);
	return v;
};

async function returns(throws: boolean): Promise<string> {
	await null;
	for (const x of new Counter(throws)) {
		if (x === 1) return value('ret');
	}
	return 'end';
}
async function returnsUntyped(throws: boolean): Promise<string> {
	await null;
	for (const x of untyped(throws)) {
		if (x === 1) return value('ret');
	}
	return 'end';
}
async function returnsNested(throws: boolean): Promise<string> {
	await null;
	for (const x of new Counter(false)) {
		for (const y of untyped(throws)) {
			log.push('xy' + x + y);
			if (y === 1) return value('nested');
		}
	}
	return 'end';
}
async function returnsEmpty(throws: boolean): Promise<void> {
	await null;
	for (const x of untyped(throws)) {
		if (x === 1) return;
	}
	log.push('not here');
}
async function breaks(throws: boolean): Promise<string> {
	await null;
	for (const x of untyped(throws)) {
		if (x === 1) break;
	}
	return 'after';
}
async function throwsInBody(): Promise<string> {
	await null;
	for (const x of untyped(true)) {
		if (x === 1) throw new Error('from body');
	}
	return 'end';
}

function* generator(throws: boolean): Generator<number | string, string> {
	yield 'start';
	for (const x of untyped(throws)) {
		if (x === 1) return value('gen');
	}
	return 'end';
}

function drain(label: string, g: Generator<number | string, string>): void {
	const got: (number | string)[] = [];
	try {
		for (let r = g.next(); ; r = g.next()) {
			got.push(r.value);
			if (r.done) break;
		}
		console.log(label, got.join(','), '|', log.join(','));
	} catch (e) {
		console.log(label, got.join(','), (e as Error).message, '|', log.join(','));
	}
	log.length = 0;
}
drain('gen return ok', generator(false));
drain('gen return throws', generator(true));

async function main(): Promise<void> {
	for (const [label, f] of [
		['return ok', () => returns(false)],
		['return throws', () => returns(true)],
		['untyped return ok', () => returnsUntyped(false)],
		['untyped return throws', () => returnsUntyped(true)],
		['nested ok', () => returnsNested(false)],
		['nested throws', () => returnsNested(true)],
		['empty ok', () => returnsEmpty(false).then(() => 'undefined')],
		['empty throws', () => returnsEmpty(true).then(() => 'undefined')],
		['break ok', () => breaks(false)],
		['break throws', () => breaks(true)],
		['body throws', () => throwsInBody()],
	] as [string, () => Promise<string>][]) {
		try {
			console.log(label, await f(), '|', log.join(','));
		} catch (e) {
			console.log(label, (e as Error).message, '|', log.join(','));
		}
		log.length = 0;
	}
}
main();
