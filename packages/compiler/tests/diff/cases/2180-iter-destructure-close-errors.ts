// IteratorClose on array destructuring: errors and non-object return() results propagate.
{
	let returnCalls = 0;
	const throwingReturn = {
		[Symbol.iterator]() {
			let i = 0;
			return {
				next() {
					return { value: ++i, done: false };
				},
				return(): any {
					returnCalls++;
					throw new Error('close-boom');
				},
			};
		},
	};
	try {
		const [a] = throwingReturn;
		console.log('unexpected', a);
	} catch (e) {
		console.log('throw:', (e as Error).message, returnCalls);
	}
}

{
	const badReturn = {
		[Symbol.iterator]() {
			let i = 0;
			return {
				next() {
					return { value: ++i, done: false };
				},
				return(): any {
					return 42;
				},
			};
		},
	};
	try {
		const [a] = badReturn;
		console.log('unexpected', a);
	} catch (e) {
		console.log('primitive-return:', e instanceof TypeError);
	}
}

function* gen() {
	try {
		yield 10;
		yield 20;
	} finally {
		throw new Error('gen-finally');
	}
}
{
	try {
		const [a] = gen();
		console.log('unexpected', a);
	} catch (e) {
		console.log('gen:', (e as Error).message);
	}
}

{
	let closed = false;
	const throwingNext = {
		[Symbol.iterator]() {
			let i = 0;
			return {
				next() {
					if (i++ === 0) return { value: 1, done: false };
					throw new Error('next-boom');
				},
				return(): any {
					closed = true;
					throw new Error('should-not-close');
				},
			};
		},
	};
	try {
		const [a, b] = throwingNext;
		console.log('unexpected', a, b);
	} catch (e) {
		console.log('next-throw:', (e as Error).message, closed);
	}
}

{
	let closed = false;
	const shortIter = {
		[Symbol.iterator]() {
			let i = 0;
			return {
				next() {
					return i++ === 0 ? { value: 7, done: false } : { value: undefined, done: true };
				},
				return(): any {
					closed = true;
					throw new Error('should-not-close');
				},
			};
		},
	};
	const [a, b] = shortIter;
	console.log('exhausted:', a, b, closed);
}

{
	let closed = false;
	const cleanIter = {
		[Symbol.iterator]() {
			let i = 0;
			return {
				next() {
					return { value: ++i * 10, done: false };
				},
				return() {
					closed = true;
					return { value: undefined, done: true };
				},
			};
		},
	};
	const [a, , c] = cleanIter;
	console.log('clean:', a, c, closed);
}
