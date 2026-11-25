// An iterator whose `next()` gives no object, though typed as giving one: iterating it throws as soon as that result is read.
const results: any[] = [true, null, undefined, 7, 'abc'];
let pick = 0;
interface Step {
	value: number;
	done: boolean;
}
class Range {
	i = 0;
	[Symbol.iterator]() {
		return this;
	}
	next(): Step {
		return this.i++ < 1 ? { value: this.i, done: false } : (results[pick] as Step);
	}
}
const counter = () => {
	let n = 0;
	return {
		[Symbol.iterator]() {
			return { next: (): Step => (n++ < 1 ? { value: n, done: false } : (results[pick] as Step)) };
		},
	};
};
const report = (label: string, f: () => void) => {
	try {
		f();
		console.log(label, 'no error');
	} catch (e) {
		console.log(label, (e as Error).constructor.name, (e as Error).message);
	}
};
for (pick = 0; pick < results.length; pick++) {
	const r = new Range();
	const u: any = new Range();
	report('spread', () => console.log([...r].length));
	report('spread untyped', () => console.log([...u].length));
	report('for-of', () => {
		for (const x of new Range()) console.log('got', x);
	});
	report('for-of untyped', () => {
		for (const x of u) console.log('got', x);
	});
	report('Array.from', () => console.log(Array.from(new Range()).length));
	report('Set', () => console.log(new Set(new Range()).size));
	report('literal spread', () => console.log([...counter()].length));
	report('literal for-of', () => {
		for (const x of counter()) console.log('got', x);
	});
	report('literal untyped', () => {
		const c: any = counter();
		console.log(Array.from(c).length);
	});
}
pick = 0;
report('destructuring', () => {
	const [a, b] = new Range();
	console.log(a, b);
});
report('destructuring untyped', () => {
	const held: any = new Range();
	const [a, b] = held;
	console.log(a, b);
});
report('destructuring rest', () => {
	const [a, ...more] = new Range();
	console.log(a, more.length);
});
const step = new Range().next();
console.log(step.value, step.done);
