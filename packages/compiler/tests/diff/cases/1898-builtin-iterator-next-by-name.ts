// A built-in iterator's `next` (and a generator's `next`, `return`) is a method readable by name, callable detached
// with the iterator as receiver.
const it: any = [1, 2][Symbol.iterator]();
const n = it.next;
console.log(typeof it.next, typeof n);
console.log(JSON.stringify(n.call(it)), JSON.stringify(it.next()), JSON.stringify(n.call(it)));
const u: any = new Set(['a']).values();
console.log(typeof u.next, JSON.stringify(u.next.call(u)));
const m: any = new Map([['k', 1]]).entries();
const mn = m.next;
console.log(typeof mn, JSON.stringify(mn.call(m)));
const s: any = 'hi'[Symbol.iterator]();
console.log(typeof s.next, JSON.stringify(s.next()));
const k: any = [7].keys();
console.log(typeof k.next, JSON.stringify(k.next.call(k)));
function* gen() { yield 1; yield 2; }
const g: any = gen();
console.log(typeof g.next, g.next().value, typeof g.return, JSON.stringify(g.return(9)), JSON.stringify(g.next()));
const g2: any = gen();
const self: any = g2[Symbol.iterator]();
console.log(self.next().value, JSON.stringify(g2.next.call(g2)));
