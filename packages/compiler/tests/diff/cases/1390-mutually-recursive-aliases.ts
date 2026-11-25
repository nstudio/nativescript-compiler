// Aliases that name each other (a JSON value, an expression tree): values of each are what script makes, walked and stringified as JavaScript does.
type Json = string | number | boolean | null | JsonArray | JsonObject;
type JsonArray = Json[];
type JsonObject = { [key: string]: Json };

type Expr = { kind: 'num'; value: number } | { kind: 'add'; terms: Terms };
type Terms = [left: Expr, right: Expr];

function depth(v: Json): number {
  if (Array.isArray(v)) return 1 + v.reduce<number>((m, x) => Math.max(m, depth(x)), 0);
  if (v !== null && typeof v === 'object') return 1 + Object.values(v).reduce<number>((m, x) => Math.max(m, depth(x)), 0);
  return 0;
}

function evaluate(e: Expr): number {
  return e.kind === 'num' ? e.value : evaluate(e.terms[0]) + evaluate(e.terms[1]);
}

const inner: JsonArray = [1, 'two', null];
const b: JsonObject = { c: true, d: [inner] };
const doc: JsonObject = { a: inner, b };
console.log(depth(doc), JSON.stringify(doc));
inner.push({ e: 5 });
b.c = 'x';
console.log(depth(doc), JSON.stringify(doc), doc.b === b);

const one = { kind: 'num' as const, value: 1 };
const sum: Expr = { kind: 'add', terms: [one, { kind: 'add', terms: [{ kind: 'num', value: 2 }, one] }] };
console.log(evaluate(sum), JSON.stringify(sum));
one.value = 10;
console.log(evaluate(sum), sum.kind === 'add' && Array.isArray(sum.terms));
