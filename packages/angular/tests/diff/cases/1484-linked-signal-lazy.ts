// `linkedSignal` computes lazily, as `computed` does: nothing at construction (a computation that would throw then is
// never run), a read or write computes only when it never did or a value it read changed (a write first computes).
import { signal, computed, linkedSignal } from '@angular/core';

const log: string[] = [];
const src = signal(1);
const doubled = linkedSignal(() => {
  log.push('fn ' + src());
  return src() * 2;
});
log.push('made');
src.set(2);
src.set(3);
log.push('read ' + doubled());
log.push('again ' + doubled());
src.set(4);
doubled.set(100);
log.push('after set ' + doubled());
src.set(5);
log.push('read ' + doubled());
const plusOne = computed(() => doubled() + 1);
log.push('computed ' + plusOne());
src.set(6);
log.push('computed ' + plusOne());
console.log(log.join(', '));

const log2: string[] = [];
const page = signal(1);
const label = linkedSignal({
  source: page,
  computation: (s: number, previous?: { source: number; value: string }) => {
    log2.push(`c ${s} ${previous ? previous.source + ':' + previous.value : '-'}`);
    return 'p' + s;
  },
});
log2.push('made');
page.set(2);
page.set(3);
log2.push(label());
page.set(4);
page.set(5);
label.update((v) => v + '!');
log2.push(label());
page.set(5);
log2.push(label());
page.set(6);
log2.push(label());
console.log(log2.join(', '));

const ready = signal(0);
let readyRuns = 0;
const late = linkedSignal(() => {
  readyRuns++;
  if (ready() === 0) throw new Error('not ready');
  return ready() * 10;
});
console.log('made unready', readyRuns);
ready.set(4);
console.log('read', late(), readyRuns);
late.set(1);
console.log('after set', late(), readyRuns);
