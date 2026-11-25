// A computed's `equal` that throws makes the computed's value that error: each read throws it until a dependency changes.
import { signal, computed } from '@angular/core';

const n = signal(1);
let runs = 0;
const c = computed(
  () => {
    runs++;
    return n() * 10;
  },
  { equal: (a, b) => { if (b === 20) throw new Error('equal failed ' + a + ' ' + b); return a === b; } },
);
console.log('first', c(), runs);
n.set(2);
for (let k = 0; k < 2; k++) {
  try {
    console.log('read', c());
  } catch (e) {
    console.log('caught', (e as Error).message, runs);
  }
}
n.set(3);
console.log('after', c(), runs);
