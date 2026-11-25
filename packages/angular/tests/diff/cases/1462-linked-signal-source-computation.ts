// `linkedSignal({ source, computation })`: recomputed from the source when it changes, with the previous source and value; writable in between.
import { signal, linkedSignal } from '@angular/core';

const options = signal(['a', 'b', 'c']);
const chosen = linkedSignal<string[], string>({
  source: options,
  computation: (opts, previous) => (previous && opts.includes(previous.value) ? previous.value : opts[0]),
});
console.log('chosen', chosen());
chosen.set('b');
console.log('chosen', chosen());
options.set(['b', 'c']);
console.log('kept', chosen());
options.set(['c', 'd']);
console.log('reset', chosen());

const page = signal(1);
const log: string[] = [];
const label = linkedSignal({
  source: () => page() * 10,
  computation: (s: number, previous?: { source: number; value: string }) => {
    log.push(previous ? previous.source + '>' + s : 'first ' + s);
    return 'p' + s + (previous ? '<' + previous.value : '');
  },
});
console.log('label', label());
label.update((v) => v + '*');
console.log('label', label());
page.set(2);
console.log('label', label());
console.log(log.join(', '));

const size = signal(3);
let sizeRuns = 0;
const box = linkedSignal({
  source: size,
  computation: (s: number) => {
    sizeRuns++;
    return { w: s, h: s };
  },
  equal: (a, b) => a.w === b.w,
});
const first = box();
size.set(3);
console.log('same box', box() === first, sizeRuns);
size.set(4);
console.log('new box', box().w, sizeRuns);
