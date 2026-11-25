// The rewrites the refusal catalog suggests for preflight's refusals (src/semantics/refusals.ts), each as written there.
// proxy: a Map for dynamic keys.
const counts = new Map<string, number>();
const read = (k: string) => counts.get(k) ?? 0;
counts.set('a', 2);
console.log('proxy', read('a'), read('b'));

// reflect: the operations directly.
const o: Record<string, number> = { a: 1, b: 2 };
console.log('reflect', 'a' in o, 'z' in o, Object.keys(o).join(','));

// eval: a lookup of known functions.
const log: string[] = [];
const save = () => { log.push('save'); };
const load = () => { log.push('load'); };
const actions = new Map<string, () => void>([['save', save], ['load', load]]);
for (const name of ['load', 'save', 'other']) actions.get(name)?.();
console.log('eval', log.join(','));

// function-constructor: the function in the source.
const add = (a: number, b: number) => a + b;
console.log('function', add(2, 3));

// arguments-callee: a named function.
function f(n: number): number { return n ? n * f(n - 1) : 1; }
console.log('callee', f(5));

// proto: instanceof.
class A {}
class B extends A {}
const b = new B();
console.log('proto', b instanceof A, new A() instanceof B);
