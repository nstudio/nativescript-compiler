// @lenient-both
class Base {
	tag = 'base';
	get label(): string {
		return this.tag;
	}
}
class Mid extends Base {
	mid = 1;
}
class Sub extends Mid {
	sub = 2;
}

const s: any = new Sub();
console.log('initial:', s.label, 'label' in s);

(Base.prototype as any).kind = 'from-base';
console.log('proto-base:', s.kind, 'kind' in s);

Object.defineProperty(Mid.prototype, 'kind', {
	get() {
		return 'mid:' + this.tag;
	},
	configurable: true,
});
console.log('proto-mid:', s.kind, 'kind' in s);

delete (Mid.prototype as any).kind;
console.log('proto-restored:', s.kind, 'kind' in s);

delete (Base.prototype as any).kind;
console.log('proto-deleted:', s.kind, 'kind' in s);

console.log('chain:', Object.getPrototypeOf(s) === Sub.prototype, Object.getPrototypeOf(Sub.prototype) === Mid.prototype, Object.getPrototypeOf(Mid.prototype) === Base.prototype);
