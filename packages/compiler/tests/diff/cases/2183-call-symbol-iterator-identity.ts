// Untyped obj[Symbol.iterator]() preserves returned iterator identity, own properties, and raw values.
class FreshIterable {
	[Symbol.iterator]() {
		let n = 0;
		return {
			tag: 'class-iter',
			next() {
				return n < 2 ? { value: ++n, done: false } : { value: undefined, done: true };
			},
		};
	}
}

const fi = new FreshIterable();
const fiIt = (fi as any)[Symbol.iterator]();
console.log('class-tag:', fiIt.tag);
console.log('class-steps:', fiIt.next().value, fiIt.next().value, fiIt.next().done);

const retained = {
	tag: 'same-obj',
	next() {
		return { value: 99, done: false };
	},
};

class RetainedIterable {
	[Symbol.iterator](): any {
		return retained;
	}
}

const ri = new RetainedIterable();
const riIt = (ri as any)[Symbol.iterator]();
console.log('class-identity:', riIt === retained, riIt.tag, riIt.next().value);

const dynIter: any = { tag: 'dyn-obj' };
let dynN = 0;
dynIter.next = () => (dynN < 1 ? { value: ++dynN * 7, done: false } : { value: undefined, done: true });

class DynIterable {
	[Symbol.iterator](): any {
		return dynIter;
	}
}

const di = new DynIterable();
const diIt = (di as any)[Symbol.iterator]();
console.log('dyn-identity:', diIt === dynIter, diIt.tag, diIt.next().value, diIt.next().done);

const lit = {
	[Symbol.iterator]() {
		let n = 0;
		return {
			tag: 'lit-iter',
			next() {
				return n < 1 ? { value: ++n * 5, done: false } : { value: undefined, done: true };
			},
		};
	},
};

const litIt = (lit as any)[Symbol.iterator]();
console.log('lit-tag:', litIt.tag);
console.log('lit-steps:', litIt.next().value, litIt.next().done);

const litRetained = {
	[Symbol.iterator](): any {
		return retained;
	},
};
const litRetIt = (litRetained as any)[Symbol.iterator]();
console.log('lit-identity:', litRetIt === retained, litRetIt.tag);

class RawPrimClass {
	[Symbol.iterator]() {
		return 123;
	}
}
console.log('class-raw-prim:', (new RawPrimClass() as any)[Symbol.iterator]());

const rawPrimLit = {
	[Symbol.iterator]() {
		return 456n;
	},
};
const rawBig = (rawPrimLit as any)[Symbol.iterator]();
console.log('lit-raw-prim:', typeof rawBig, String(rawBig));

const arrIt = ([10, 20] as any)[Symbol.iterator]();
console.log('arr-builtin:', arrIt.next().value, arrIt.next().value, arrIt.next().done);
