// Options given as a variable or a call's result are read by name when the signal is made, as the literal's are.
import { signal, computed, linkedSignal } from '@angular/core';

interface Box { w: number }
const sameWidth = { equal: (a: Box, b: Box) => a.w === b.w };
const box = signal<Box>({ w: 1 }, sameWidth);
let boxRuns = 0;
const area = computed(() => {
  boxRuns++;
  return box().w * 2;
});
area();
box.set({ w: 1 });
area();
box.set({ w: 3 });
console.log('box', area(), boxRuns);

function caseless() {
  return { equal: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(), debugName: 'caseless' };
}
const word = signal<string>('Hi', caseless());
word.set('HI');
console.log('word', word());

const none = {};
const plain = signal({ w: 1 }, none);
const first = plain();
plain.set({ w: 1 });
console.log('plain', plain() === first);

const n = signal(1);
const parity = computed(() => ({ odd: n() % 2 === 1 }), caseOdd());
function caseOdd() {
  return { equal: (a: { odd: boolean }, b: { odd: boolean }) => a.odd === b.odd };
}
const p1 = parity();
n.set(3);
console.log('parity kept', parity() === p1);
n.set(4);
console.log('parity', parity().odd);

interface Follow {
  source: () => number;
  computation: (n: number, previous?: { source: number; value: string }) => string;
  equal?: (a: string, b: string) => boolean;
}
const count = signal(1);
const follow: Follow = {
  source: () => count(),
  computation: (n, previous) => (previous ? `${n}/${previous.source}` : `${n}`),
  equal: (a, b) => a.length === b.length,
};
const followed = linkedSignal(follow);
follow.computation = () => 'later';
console.log('linked', followed());
count.set(2);
console.log('linked', followed());
count.set(3);
console.log('linked kept', followed());
followed.set('set');
count.set(14);
console.log('linked', followed());

function lengths() {
  return { source: () => count(), computation: (n: number) => n * 10 };
}
const tens = linkedSignal(lengths());
count.set(5);
console.log('tens', tens());
