// `undefined` given to a library method's optional parameter reads as the argument left out; `null` given to `join`
// is a separator like any other value, joined as "null".
const xs = ['a', 'b', 'c'];
const none: string | undefined = undefined;
const sep = (n: number): string | undefined => (n > 0 ? '+' : undefined);
console.log(xs.join(undefined), xs.join(none), xs.join(), xs.join(sep(1)), xs.join(sep(0)), [1, 2].join(undefined));
console.log(new Float64Array([1.5, 2]).join(undefined), new Int32Array([3, 4]).join(sep(1)), [[1, 2], [3]].join(none));
const unset: any = null;
console.log([1, 2].join(unset), [1, 2].join(undefined as any), [1, 2].join(), xs.join(null as any), xs.join(unset as string | undefined), new Uint8Array([5, 6]).join(unset));
for (const k of [0, 1, 2]) console.log(xs.join(k > 5 ? '+' : (unset as string)), new Int32Array([3, 4]).join(k > 1 ? (null as any) : '/'));
for (const k of [0, 1, 2]) console.log(xs.join(k > 0 ? (k > 1 ? (null as any) : '/') : undefined), new Int32Array([3, 4]).join(k < 2 ? (k < 1 ? undefined : unset) : '-'));
