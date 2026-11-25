// @lenient-both
interface Box {
	readonly k: symbol;
}

const raw = { k: Symbol('a') };
const box: Box = raw;
const s1 = Symbol('s1');
const s2 = Symbol('s2');
let dynSym = Symbol('dyn1');
let fieldSym = Symbol('f1');

class Keyed {
	[fieldSym] = 42;
	[s1]() {
		return 1;
	}
	[s2]() {
		return 2;
	}
	[box.k]() {
		return 3;
	}
	[dynSym]() {
		return 4;
	}
}

const firstBoxKey = raw.k;
const firstDynKey = dynSym;
const firstFieldKey = fieldSym;
raw.k = Symbol('b');
dynSym = Symbol('dyn2');
fieldSym = Symbol('f2');

const o: any = new Keyed();
console.log('box:', typeof o[firstBoxKey], o[firstBoxKey](), typeof o[raw.k]);
console.log('dyn:', typeof o[firstDynKey], o[firstDynKey](), typeof o[dynSym]);
console.log('field:', o[firstFieldKey], firstFieldKey in o, fieldSym in o, o[fieldSym]);
console.log('const:', o[s1](), o[s2]());
