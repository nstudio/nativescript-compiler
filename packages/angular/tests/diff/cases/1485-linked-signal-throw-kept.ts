// A `linkedSignal` whose computation throws: each read and `update` rethrows it, computing again only after a value it
// read changes; a `set` writes over it.
import { signal, linkedSignal } from '@angular/core';

const bad = signal(0);
let runs = 0;
const guarded = linkedSignal(() => {
  runs++;
  if (bad() === 0) throw new Error('unset');
  return bad();
});
console.log('made throwing', runs);
try {
  console.log('read', guarded());
} catch (e) {
  console.log('read threw', (e as Error).message, runs);
}
try {
  console.log('read', guarded());
} catch (e) {
  console.log('read threw again', (e as Error).message, runs);
}
bad.set(7);
console.log('read', guarded(), runs);
bad.set(0);
try {
  guarded.update((v) => v + 1);
  console.log('updated', guarded());
} catch (e) {
  console.log('update threw', (e as Error).message, runs);
}
guarded.set(9);
console.log('after set', guarded(), runs);
bad.set(3);
console.log('read', guarded(), runs);
