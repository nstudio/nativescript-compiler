// `asReadonly()` gives a signal that reads the writable one and has no `set`.
import { signal, computed } from '@angular/core';

const count = signal(1);
const ro = count.asReadonly();
console.log('readonly', ro(), typeof (ro as any).set);
count.set(5);
console.log('follows', ro());
const doubled = computed(() => ro() * 2);
count.update((v) => v + 1);
console.log('doubled', doubled());

class Store {
  private readonly items = signal<string[]>([]);
  readonly view = this.items.asReadonly();
  add(s: string) {
    this.items.update((list) => [...list, s]);
  }
}
const s = new Store();
s.add('a');
s.add('b');
console.log('store', s.view().join(','), s.view().length);
