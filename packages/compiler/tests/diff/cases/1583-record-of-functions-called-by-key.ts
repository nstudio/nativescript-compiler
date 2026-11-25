// A Record of functions, built from shorthand members or assigned by name, called through a computed key.
const log: string[] = [];
function save() { log.push('save'); }
function load() { log.push('load'); }
const actions: Record<string, () => void> = { save, load };
for (const name of ['save', 'load']) actions[name]();
actions['save']();
const reset = () => { log.push('reset'); };
const more: Record<string, () => void> = { reset, inline: () => { log.push('inline'); } };
for (const name of Object.keys(more)) more[name]();
const fn = actions['load'];
fn();
console.log(log.join(','), typeof actions.save, 'missing' in actions);

const count: Record<string, (n: number) => number> = {};
count.triple = (n) => n * 3;
count['quad'] = (n) => n * 4;
const k = 'five';
count[k] = (n) => n * 5;
function six(n: number) { return n * 6; }
count.six = six;
for (const name of Object.keys(count)) console.log(name, count[name](7));

const sizes: Record<string, number> = {};
sizes.small = 1;
const big = 9;
const all: Record<string, unknown> = { big, six, sizes };
console.log(sizes.small, all.big, typeof all.six, (all.six as (n: number) => number)(2), JSON.stringify(all.sizes));

// A function in a shorthand member of an object whose field is untyped, then called as asserted.
interface Opts { cb: unknown; other?: unknown }
const cb = reset;
const opts: Opts = { cb };
const declared: Opts = { cb: save };
(opts.cb as () => void)();
(declared.cb as () => void)();
const bag: { [k: string]: () => void } = { save, reset };
for (const key in bag) bag[key]();
console.log(log.slice(-4).join(','));
