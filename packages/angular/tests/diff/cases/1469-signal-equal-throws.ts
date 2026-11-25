// A signal's `equal` that throws: the error reaches the caller of `set` or `update`, and the value is not written.
import { signal } from '@angular/core';

const s = signal(1, { equal: (a, b) => { if (b < 0) throw new Error('negative ' + b); return a === b; } });
try {
  s.set(-1);
  console.log('set returned');
} catch (e) {
  console.log('set threw', (e as Error).message);
}
console.log('value', s());
try {
  s.update((v) => v - 5);
  console.log('update returned');
} catch (e) {
  console.log('update threw', (e as Error).message);
}
console.log('value', s());
s.set(7);
console.log('value', s());
