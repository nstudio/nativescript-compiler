// @app-lenient
// A non-strict app's `join(null)` joins with "null"; only undefined, given or left out, joins with a comma.
const xs = ['a', 'b'];
const none = null;
let unset;
function sep(k: number): string { return k > 0 ? '+' : k < 0 ? null : undefined; }
console.log(xs.join(null), xs.join(undefined), xs.join(), xs.join(none), xs.join(unset), [1, 2].join(null));
console.log(xs.join(sep(1)), xs.join(sep(-1)), xs.join(sep(0)), new Int32Array([3, 4]).join(null), new Int32Array([3, 4]).join(undefined), new Int32Array([3, 4]).join());
