// The typed arrays' statics (`of`, `from` with and without a map function) and `ArrayBuffer.isView`, on both backends.
const a = Uint8Array.of(1, 2, 300);
const xs = [1.5, 2.5];
const b = Float64Array.of(...xs, 4);
const c = Float32Array.from([1, 2, 3], (v) => v * 2);
const d = Int16Array.from(new Set([7, 8]));
const e = BigInt64Array.of(1n, 2n);
console.log(a.join(','), b.join(','), c.join(','), d.join(','), e.join(','));
console.log(ArrayBuffer.isView(a), ArrayBuffer.isView(xs), ArrayBuffer.isView(new DataView(new ArrayBuffer(2))));
