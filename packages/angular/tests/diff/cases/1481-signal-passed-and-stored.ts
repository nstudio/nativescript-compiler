// A signal passed to a function, stored in a field, an array or a map, is the signal itself: each read is live.
import { signal, computed } from '@angular/core';
import type { Signal, WritableSignal } from '@angular/core';

function show(label: string, s: Signal<number>) {
  console.log(label, s());
}

class Counter {
  count = signal(1);
  doubled = computed(() => this.count() * 2);
  view = this.count.asReadonly();
  held: Signal<number>[] = [];
  keep(s: Signal<number>) { this.held.push(s); }
}

const c = new Counter();
const byName = new Map<string, Signal<number>>();
byName.set('count', c.count);
byName.set('doubled', c.doubled);
c.keep(c.count);
c.keep(c.doubled);
c.keep(c.view);
show('count', c.count);
show('doubled', c.doubled);
show('view', c.view);
c.count.set(5);
console.log(c.held.map((s) => s()).join(','));
console.log(byName.get('count')!(), byName.get('doubled')!());
show('doubled', c.doubled);

function bump(w: WritableSignal<number>) { w.update((v) => v + 1); }
bump(c.count);
console.log(c.held.map((s) => s()).join(','), c.view());
