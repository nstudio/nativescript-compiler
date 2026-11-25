// A read inside `untracked` does not make the computed or effect around it depend on that signal.
import { signal, computed, untracked } from '@angular/core';

const count = signal(1);
const other = signal(100);
let runs = 0;
const mixed = computed(() => {
  runs++;
  return count() + untracked(() => other());
});
console.log('mixed', mixed(), runs);
other.set(200);
console.log('after untracked write', mixed(), runs);
count.set(2);
console.log('after tracked write', mixed(), runs);

class Totals {
  readonly items = signal(2);
  readonly rate = signal(10);
  computedRuns = 0;
  readonly total = computed(() => {
    this.computedRuns++;
    return this.items() * untracked(() => this.rate());
  });
}
const t = new Totals();
console.log('total', t.total(), t.computedRuns);
t.rate.set(20);
console.log('total', t.total(), t.computedRuns);
t.items.set(3);
console.log('total', t.total(), t.computedRuns);
