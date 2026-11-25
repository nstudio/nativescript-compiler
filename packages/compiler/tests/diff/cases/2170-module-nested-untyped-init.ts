// Module constants with nested untyped-to-typed conversions move into module init rather than static/global init.
const raw: any = 42;
const n: any = 7;
const obj: { n: number } = { n: raw };
const sh: { n: number } = { n };
const arr: number[] = [raw, n];
const map = new Map<string, number>([['k', raw]]);
const set = new Set<number>([raw, n]);

console.log(obj.n, sh.n, arr.join(','), map.get('k'), set.has(42), set.has(7));
