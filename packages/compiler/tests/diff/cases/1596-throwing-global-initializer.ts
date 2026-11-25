// @app-lenient
// @cli-program
// A variable that later holds null, undefined and values of other types, made at the top of a module; objects found by
// identity among values of every kind.
var map = new Map();
var item = {};
map.set(item, 2);
console.log(map.get(item));
item = [];
map.set(item, 3);
console.log(map.get(item));
item = null;
map.set(item, 5);
console.log(map.get(item));
item = undefined;
map.set(item, 6);
console.log(map.get(item), map.size);
var obj = {};
var arr = [];
var sym = Symbol('s');
var sample = [42, 'x', null, undefined, true, sym, obj, arr];
console.log(sample.includes(obj), sample.includes(arr), sample.includes(sym), sample.includes(null), sample.includes(undefined));
console.log(sample.indexOf(obj), sample.indexOf(arr), sample.includes({}));
