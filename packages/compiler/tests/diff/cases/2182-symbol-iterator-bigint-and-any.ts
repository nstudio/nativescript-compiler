// [Symbol.iterator] returning BigInt or any on object literals and classes: non-object throws TypeError.
const badBigIntLit = {
	[Symbol.iterator]() {
		return 1n;
	},
};

try {
	for (const x of badBigIntLit as any) {
		console.log('unexpected', x);
	}
} catch (e) {
	console.log('lit-bigint-untyped:', e instanceof TypeError);
}

try {
	const arr = [...(badBigIntLit as any)];
	console.log('unexpected', arr);
} catch (e) {
	console.log('lit-bigint-spread:', e instanceof TypeError);
}

class BadBigIntClass {
	[Symbol.iterator]() {
		return 1n;
	}
}

try {
	for (const x of new BadBigIntClass() as any) {
		console.log('unexpected', x);
	}
} catch (e) {
	console.log('cls-bigint-untyped:', e instanceof TypeError);
}

function makeAnyLit(ret: any) {
	return {
		[Symbol.iterator](): any {
			return ret;
		},
	};
}

for (const bad of [1n, 42, 's', true, null, undefined]) {
	try {
		for (const x of makeAnyLit(bad)) {
			console.log('unexpected', x);
		}
	} catch (e) {
		console.log('any-lit-bad:', typeof bad, e instanceof TypeError);
	}
}

let count = 0;
const goodIter = {
	next() {
		return count < 3 ? { value: ++count * 10, done: false } : { value: undefined, done: true };
	},
};

const vals: any[] = [];
for (const x of makeAnyLit(goodIter)) {
	vals.push(x);
}
console.log('any-lit-good:', vals.join(','));
