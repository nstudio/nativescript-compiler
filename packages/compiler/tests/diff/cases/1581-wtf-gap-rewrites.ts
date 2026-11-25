// The rewrites the refusal catalog suggests for code the compiler does not translate yet (src/semantics/refusals.ts), each as written there.
// array-hole
const xs = [1, undefined, 3];
console.log('hole', xs.length, xs[1], xs.map((x) => x ?? 0).join(','));

// function-arguments
const sum = (...args: number[]) => args.length;
console.log('arguments', sum(1, 2, 3));

// builtin-prototype
const isOne = (n: number) => n === 1;
console.log('number', isOne(1), isOne(2));

// object-call
function wrap(v: unknown): object {
  const o = typeof v === 'object' && v !== null ? v : {};
  return o;
}
const held = { k: 1 };
console.log('object', wrap(held) === held, JSON.stringify(wrap(5)), JSON.stringify(wrap(null)));

// library-member
const s = '42px';
console.log('member', parseInt(s, 10), parseInt('ff', 16));

// function-value
const seen: number[] = [];
[1, 2].forEach((x) => console.log('value', x));
[3, 4].forEach((x) => seen.push(x));
console.log('value', seen.join(','));

// other-receiver
const fn = (a?: number, b?: number) => `${a},${b}`;
console.log('receiver', fn(2));

// finally-jump
function a(): number { console.log('a ran'); return 1; }
function bb(): number { return 2; }
function choose(): number {
  let r: number | undefined;
  try { a(); } finally { r = bb(); }
  return r;
}
console.log('finally', choose());

// class-expression
class Point { x = 1; }
const p = new Point();
console.log('class', p.x);

// named-function-expression
function down(n: number): number { return n ? down(n - 1) : 0; }
const g = down;
console.log('named', g(3));

// unsupported-base
class Fn { constructor(readonly call: () => number) {} }
console.log('base', new Fn(() => 7).call());
