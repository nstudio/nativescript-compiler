// @app-lenient
// A callback function reading its own untyped `this`: the thisArg beside it, undefined without one, and the receiver
// Array.prototype's methods give it when called over another object.
const ctx = { t: 1 };
const like = { length: 2, 0: 1, 1: 2 };
console.log([1, 2].some(function (v) { return this.t === v; }, ctx));
console.log([1, 2].some(function (v) { return this.t === v; }, { t: 2 }), [3].map(function (v) { return v + this.t; }, { t: 1 }).join());
console.log(Array.prototype.filter.call(like, function (v) { return v > this.t; }, { t: 1 }).join());
console.log(Array.prototype.some.call(like, function (v) { return this.t === v; }, ctx));
console.log(Array.prototype.map.call(like, function (v) { return v + this.t; }, ctx).join());
console.log([1, 2].map(function () { return this === undefined; }).join());
console.log(Array.prototype.some.call(like, function () { return this === undefined; }));
new Map([['a', 1]]).forEach(function (v, k) { console.log(k, v, this.t); }, ctx);
console.log(Array.from({ length: 2 }, function (_, i) { return i + this.t; }, ctx).join());
try {
	[1].forEach(function () { console.log(this.t); });
} catch (e) {
	console.log(e instanceof TypeError);
}
