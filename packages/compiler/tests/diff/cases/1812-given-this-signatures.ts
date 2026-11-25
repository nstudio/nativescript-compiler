// A function expression whose contextual signature declares its `this` reads the receiver the caller gives it.
class Widget {
	constructor(readonly name: string) {}
}
interface Handlers {
	onOther: (this: Widget, e: string) => string;
}
const handlers: Handlers = {
	onOther: function (e) {
		return this.name + '/' + e;
	},
};
const typed: (this: Widget, e: string) => string = function (e) {
	return this.name + ':' + e;
};
const w = new Widget('w');
console.log(handlers.onOther.call(w, 'b'), typed.call(w, 'a'), typed.call(new Widget('v'), 'c'));
