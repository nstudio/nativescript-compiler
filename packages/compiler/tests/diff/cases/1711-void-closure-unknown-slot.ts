// A closure returning nothing placed where a function giving `unknown` or `any` is declared: calling it gives undefined,
// whether it ends, returns early with a bare `return`, or has an expression body of a void call.
function note(x: string): void {
  console.log('note', x);
}
type Gives = (x: string) => unknown;
const plain: Gives = (x) => {
  note(x);
};
const early: Gives = (x) => {
  if (x === 'skip') return;
  note(x);
};
const expressed: Gives = (x) => note(x);
const loose: (x: string) => any = (x) => {
  note(x);
};
function run(f: Gives, x: string): unknown {
  return f(x);
}
const table: { a: Gives } = { a: (x) => { note(x); } };
const list: Gives[] = [(x) => { note(x); }, (x) => x.length];
function make(): Gives {
  return (x) => {
    note(x);
  };
}
console.log(plain('p'), early('skip'), early('e'), expressed('x'), loose('l'));
console.log(run((x) => { note(x); }, 'r'), table.a('t'), list.map((f) => f('m')), make()('k'));
console.log(typeof plain('q'), plain('q') === undefined, [plain('z')].length, JSON.stringify({ v: plain('j') }));
const pick = Math.random() > 2;
const chosen: Gives = pick ? (x) => x.length : ((x) => { note(x); });
const nested: Gives = pick ? (x) => x.length : pick ? (x) => x : (x) => note(x);
console.log(chosen('c'), nested('n'));
const throwing: Gives = (x) => {
  if (x === 'bad') throw new Error('bad ' + x);
  JSON.parse(x);
};
try {
  console.log(throwing('1'), run((x) => { JSON.parse(x); }, '2'), (pick ? (x: string) => x : throwing)('3'));
  throwing('bad');
} catch (e) {
  console.log('caught', (e as Error).message);
}
