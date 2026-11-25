// A field's initializer reads the instance's `this` outside the methods it holds, which have their own.
class Counter {
	start = 3;
	next = this.start + 1;
	viaArrow = () => this.start * 10;
	nested = {
		start: 100,
		read() {
			return this.start;
		},
	};
}

const c = new Counter();
console.log(c.start, c.next, c.viaArrow(), c.nested.read());
c.start = 5;
console.log(c.next, c.viaArrow());
