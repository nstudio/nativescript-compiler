// A signal's or computed's `equal` option decides whether a new value is a change: an equal one notifies nobody.
import { signal, computed } from '@angular/core';

interface Point { x: number; y: number }
const point = signal<Point>({ x: 1, y: 1 }, { equal: (a, b) => a.x === b.x && a.y === b.y });
let pointRuns = 0;
const sum = computed(() => {
  pointRuns++;
  const p = point();
  return p.x + p.y;
});
sum();
point.set({ x: 1, y: 1 });
sum();
point.set({ x: 2, y: 1 });
console.log('point', sum(), pointRuns);

const word = signal('Hello', { equal: (a, b) => a.toLowerCase() === b.toLowerCase() });
let wordRuns = 0;
const shout = computed(() => {
  wordRuns++;
  return word() + '!';
});
shout();
word.set('HELLO');
console.log('word', word(), shout(), wordRuns);
word.update((w) => w + ' there');
console.log('word', word(), shout(), wordRuns);

const n = signal(1);
const parity = computed(() => ({ odd: n() % 2 === 1 }), { equal: (a, b) => a.odd === b.odd });
let parityRuns = 0;
const parityLabel = computed(() => {
  parityRuns++;
  return parity().odd ? 'odd' : 'even';
});
parityLabel();
n.set(3);
console.log('parity', parityLabel(), parityRuns);
n.set(4);
console.log('parity', parityLabel(), parityRuns);
