// A computed or signal read as a statement, its value unused, still runs the computation and subscribes the effect around it.
import { signal, computed } from '@angular/core';

const n = signal(1);
let runs = 0;
const doubled = computed(() => {
  runs++;
  return n() * 2;
});
doubled();
console.log('runs after statement read', runs);
n.set(2);
doubled();
console.log('runs after second read', runs);

class Counter {
  readonly count = signal(0);
  readonly label = computed(() => {
    this.made++;
    return 'c' + this.count();
  });
  made = 0;
  touch() {
    this.label();
    this.count();
  }
}
const c = new Counter();
c.touch();
console.log('class made', c.made);
c.count.set(1);
c.touch();
console.log('class made', c.made);
