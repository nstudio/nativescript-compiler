const symField = Symbol('field');
const symMethod = Symbol('method');
const symSubField = Symbol('subField');
const symSubMethod = Symbol('subMethod');
const symMissing = Symbol('missing');

class Plain {
	[symField] = 10;
	[symMethod](delta: number): number {
		return this[symField] + delta;
	}
}

class PlainSub extends Plain {
	[symSubField] = 100;
	[symSubMethod](delta: number): number {
		return this[symSubField] + this[symField] + delta;
	}
}

const typed = new Plain();
console.log('typed-in:', symField in typed, symMethod in typed, symMissing in typed);

const dyn: any = new Plain();
console.log('dyn-in:', symField in dyn, symMethod in dyn, symMissing in dyn);
console.log('dyn-call:', dyn[symField], dyn[symMethod](5));

const sub: any = new PlainSub();
console.log('sub-in:', symField in sub, symMethod in sub, symSubField in sub, symSubMethod in sub, symMissing in sub);
console.log('sub-call:', sub[symMethod](3), sub[symSubMethod](4));
