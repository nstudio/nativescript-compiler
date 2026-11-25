// Conversions of typed objects inside methods, getters and arrow functions: each throws to its caller.
class Money {
	constructor(readonly cents: number) {}
	valueOf(): number {
		if (!Number.isInteger(this.cents)) throw new RangeError(`bad cents ${this.cents}`);
		return this.cents;
	}
	toString(): string { return `$${(this.valueOf() / 100).toFixed(2)}`; }
}
class Wallet {
	constructor(readonly items: Money[]) {}
	get total(): number {
		return this.items.reduce((t, m) => t + +m, 0);
	}
	summary(): string {
		return this.items.map((m) => `${m}`).join(', ');
	}
}
const w = new Wallet([new Money(150), new Money(25)]);
console.log(w.total, w.summary());
const bad = new Wallet([new Money(1), new Money(2.5)]);
try { console.log(bad.total); } catch (e) { console.log('total', (e as Error).message); }
try { console.log(bad.summary()); } catch (e) { console.log('summary', (e as Error).message); }
