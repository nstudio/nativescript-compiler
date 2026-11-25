// Typed arrays', Map's and Set's callbacks and Array.from's mapper beside a thisArg: read as `this` by a function, ignored
// by an arrow or a function not reading it, and evaluated still.
interface Scale { k: number }
const scale: Scale = { k: 3 };
const order: string[] = [];
const given = (s: string): Scale => { order.push(s); return scale; };
const f32 = new Float64Array([1, 2, 3]);

f32.forEach(function (this: Scale, v, i) { order.push(`${v * this.k}@${i}`); }, scale);
console.log(f32.filter(function (this: Scale, v) { return v * this.k > 4; }, scale).join());
console.log(f32.every(function (this: Scale, v) { return v < this.k + 1; }, scale), f32.find(function (this: Scale, v) { return v === this.k; }, scale));
console.log(f32.findIndex(function (this: Scale, v) { return v === this.k - 1; }, scale), f32.findLastIndex(function (this: Scale, v) { return v < this.k; }, scale));
function ignored(xs: Float64Array) {
	console.log(xs.map((v) => v + 1, given('arrow')).join(), xs.some(function (v) { return v > 2; }, given('plain')));
}
ignored(f32);
console.log(Float64Array.from([1, 2], function (this: Scale, v) { return v * this.k; }, scale).join());
console.log(Array.from({ length: 3 }, function (this: Scale, _, i) { return i * this.k; }, scale).join());
new Set(['x']).forEach((v) => order.push(v), given('set'));
new Map([[1, 'one']]).forEach(function (v, k) { order.push(`${k}=${v}`); }, given('map'));
console.log(order.join(' '));
