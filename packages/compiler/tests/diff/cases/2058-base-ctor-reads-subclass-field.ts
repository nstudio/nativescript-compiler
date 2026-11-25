class Base {
	constructor() {
		console.log('describe:', String(this.describe()));
		this.summary();
	}
	describe(): string {
		return 'base';
	}
	summary(): void {
		const self = this as unknown as { count: unknown; flag: unknown; items: unknown };
		for (const v of [self.count, self.flag, self.items]) console.log(String(v), typeof v);
	}
}
class Sub extends Base {
	label = 'x';
	count = 3;
	flag = true;
	items: string[] = [];
	describe(): string {
		return `${this.label}`;
	}
}
const s = new Sub();
console.log(s.describe(), s.count, s.flag, s.items.length, Object.keys(s).join());
