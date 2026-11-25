// @lenient-both
// A `for…of` over a value held untyped inside functions a module-level constant holds (as core's bindable-expressions
// parsers are): it steps, and closes its iterator on every exit but exhaustion.
const log: string[] = [];

function* steps(name: string, throws: boolean): Generator<number> {
	let done = false;
	try {
		yield 0;
		yield 1;
		yield 2;
		done = true;
	} finally {
		if (!done) {
			log.push('return ' + name);
			if (throws) throw new Error('from return ' + name);
		}
	}
}
function counter(name: string, throws: boolean): any {
	return steps(name, throws);
}

const parsers = {
	sum: (expression: any): number => {
		let total = 0;
		for (const x of expression.elements) total += x;
		return total;
	},
	first: (expression: any): any => {
		for (const x of expression.elements) {
			if (x === 1) return x;
		}
		return null;
	},
	breaks: (expression: any): string => {
		for (const x of expression.elements) {
			log.push('x' + x);
			if (x === 0) break;
		}
		return 'after';
	},
	throws: (expression: any): string => {
		for (const x of expression.elements) {
			if (x === 1) throw new Error('from body');
		}
		return 'none';
	},
};
const sum = function (expression: any): number {
	let total = 0;
	for (const x of expression.elements) total += x;
	return total;
};

function run(label: string, f: () => any): void {
	try {
		console.log(label, f(), '|', log.join(','));
	} catch (e) {
		console.log(label, (e as Error).message, '|', log.join(','));
	}
	log.length = 0;
}

run('sum array', () => parsers.sum({ elements: [1, 2, 3] }));
run('sum iterable', () => parsers.sum({ elements: counter('a', true) }));
run('first ok', () => parsers.first({ elements: counter('a', false) }));
run('first throws', () => parsers.first({ elements: counter('a', true) }));
run('breaks ok', () => parsers.breaks({ elements: counter('b', false) }));
run('breaks throws', () => parsers.breaks({ elements: counter('b', true) }));
run('body throws', () => parsers.throws({ elements: counter('c', true) }));
run('function expression', () => sum({ elements: counter('d', true) }));
