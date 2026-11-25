// A computed that reads itself throws Angular's cycle error to its reader, catchable like any error.
import { signal, computed } from '@angular/core';
import type { Signal } from '@angular/core';

const on = signal(false);
const loop: Signal<number> = computed(() => (on() ? loop() + 1 : 0));
console.log('off', loop());
on.set(true);
try {
  console.log('never', loop());
} catch (e) {
  console.log('caught', e instanceof Error, (e as Error).message);
}
on.set(false);
console.log('off again', loop());
