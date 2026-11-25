// A `for…of` in a generator or async function whose body suspends closes its iterator as any other does: `break` and
// `return` call `return()` and what it throws reaches the program (the generator's caller, the promise); a throw leaving
// the loop wins over it.
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
const counter = (throws: boolean) => new Counter(throws);

function* breaks(throws: boolean): Generator<number | string, string> {
	for (const x of counter(throws)) {
		yield x;
		if (x === 1) break;
	}
	yield 'after';
	return 'end';
}
function* returns(throws: boolean): Generator<number | string, string> {
	for (const x of counter(throws)) {
		yield x;
		if (x === 1) return 'ret';
	}
	return 'end';
}
function* throwsInBody(): Generator<number | string, string> {
	for (const x of counter(true)) {
		yield x;
		if (x === 1) throw new Error('from body');
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
drain('gen break ok', breaks(false));
drain('gen break throws', breaks(true));
drain('gen return ok', returns(false));
drain('gen return throws', returns(true));
drain('gen throw', throwsInBody());

async function asyncBreak(throws: boolean): Promise<string> {
	for (const x of counter(throws)) {
		await null;
		if (x === 1) break;
	}
	return 'end';
}
async function asyncReturn(throws: boolean): Promise<string> {
	for (const x of counter(throws)) {
		await null;
		if (x === 1) return 'ret';
	}
	return 'end';
}
async function main(): Promise<void> {
	for (const [label, f] of [
		['async break ok', () => asyncBreak(false)],
		['async break throws', () => asyncBreak(true)],
		['async return ok', () => asyncReturn(false)],
		['async return throws', () => asyncReturn(true)],
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
