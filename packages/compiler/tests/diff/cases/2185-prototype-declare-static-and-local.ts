// @lenient-both
class Early {
	private _v = 7;
	get val(): number {
		return this._v;
	}
	set val(n: number) {
		this._v = n;
	}
	static sawHas = 'val' in new Early();
	static sawRead = (new Early() as any).val;
	static sawWrite = (() => {
		const e: any = new Early();
		e.val = 19;
		return e.val;
	})();
}

function makeLocal(base: number): string {
	class Local {
		n: number;
		constructor(n: number) {
			this.n = n;
		}
		get doubled(): number {
			return this.n * 2;
		}
	}
	const inst: any = new Local(base);
	return `${'doubled' in inst}:${inst.doubled}`;
}

console.log('early:', Early.sawHas, Early.sawRead, Early.sawWrite);
console.log('local1:', makeLocal(3));
console.log('local2:', makeLocal(11));
console.log('local3:', makeLocal(25));
