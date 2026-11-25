// @app-lenient
// @cli-program
// A number method's argument of another type converts as ToNumber does, undefined still absent; a non-enumerable
// symbol key on an object literal.
var n = 123.456;
console.log(n.toPrecision(true), n.toPrecision('2'), n.toFixed('1'), n.toPrecision([2]));
var sixteen = { valueOf: function () { return 16; } };
console.log((255).toString(sixteen), n.toExponential(undefined), n.toFixed(undefined));
var hidden = Symbol('hidden');
var o = { key: 1 };
Object.defineProperty(o, hidden, { enumerable: false, value: 2 });
console.log(Object.values(o), Object.keys(o), o[hidden]);
