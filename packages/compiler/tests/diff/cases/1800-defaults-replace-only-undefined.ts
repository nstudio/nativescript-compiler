// A destructuring or parameter default replaces only undefined; null is kept.
const { a = 5 } = { a: null as number | null };
const { b = 5 } = { b: undefined as number | undefined };
console.log('object', a, b);
const [c = 1, d = 2] = [null as number | null, undefined as number | undefined];
console.log('tuple', c, d);
const list: (number | null)[] = [null];
const [e = 1, f = 2] = list;
console.log('array', e, f);
const { g: renamed = 'r' } = { g: null as string | null };
console.log('renamed', renamed);
const { outer: { inner = 9 } = { inner: 0 } } = { outer: { inner: null as number | null } };
const { outer: { inner: deep = 9 } = { inner: 0 } } = { outer: undefined as { inner: number | null } | undefined };
console.log('nested', inner, deep);
interface Item {
	title?: string | null;
	count?: number | null;
}
const items: Item[] = [{ title: null, count: null }, { title: undefined }, {}];
for (const { title = 'Untitled', count = 0 } of items) console.log('both', title, count);
function param(x: number | null = 3) {
	return x;
}
console.log('param', param(null), param(undefined), param());
function pattern({ y = 'y' }: { y?: string | null }) {
	return y;
}
console.log('param pattern', pattern({ y: null }), pattern({}));
const arrow = (s: string | null = 'dflt') => s;
console.log('arrow', arrow(null), arrow());
const untyped: any = { k: null, l: undefined };
const { k = 1, l = 2 } = untyped;
const anyList: any[] = [null, undefined];
const [p = 'p', q = 'q'] = anyList;
console.log('untyped', k, l, p, q);
function untypedParam(v: any = 'v') {
	return v;
}
console.log('untyped param', untypedParam(null), untypedParam(undefined));
let x1: number | null = 0;
let x2: number | null = 0;
const source: { x1: number | null; x2?: number | null } = { x1: null, x2: null };
({ x1 = 8, x2 = 8 } = source);
console.log('assignment', x1, x2);
let y1: number | null = 0;
let y2: number | null = 0;
[y1 = 6, y2 = 7] = list;
console.log('array assignment', y1, y2);
