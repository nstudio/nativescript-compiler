// A computed made inside a function memoizes like one at module level, and recomputes only when read after a change.
import { signal, computed } from '@angular/core';

function makeCounter(start: number) {
  const n = signal(start);
  let runs = 0;
  const boxed = computed(() => {
    runs++;
    return { total: n() * 10 };
  });
  return {
    read: () => boxed(),
    bump: () => n.update((v) => v + 1),
    runs: () => runs,
  };
}

const c = makeCounter(1);
console.log('unread runs:', c.runs());
const a = c.read();
console.log('same:', a === c.read(), a.total, 'runs:', c.runs());
c.read().total = 99;
console.log('kept:', c.read().total, 'runs:', c.runs());
c.bump();
c.bump();
console.log('lazy:', c.runs());
console.log('fresh:', c.read() !== a, c.read().total, 'runs:', c.runs());
