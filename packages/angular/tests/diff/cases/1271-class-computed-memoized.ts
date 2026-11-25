// A class's computed field memoizes per instance: each read returns the same value until a signal it read changes.
import { signal, computed } from '@angular/core';

interface Item { name: string; done: boolean }

class TodoStore {
  readonly items = signal<Item[]>([{ name: 'a', done: false }, { name: 'b', done: true }]);
  runs = 0;
  readonly open = computed(() => {
    this.runs++;
    return this.items().filter((i) => !i.done).map((i) => ({ ...i }));
  });
  readonly summary = computed(() => `${this.open().length} open of ${this.items().length}`);

  add(name: string) {
    this.items.update((list) => [...list, { name, done: false }]);
  }
}

const store = new TodoStore();
const other = new TodoStore();
console.log('same:', store.open() === store.open(), store.open()[0] === store.open()[0], 'runs:', store.runs);
store.open()[0].name = 'renamed';
console.log('kept:', store.open()[0].name, store.summary(), 'runs:', store.runs);
store.add('c');
console.log('after add:', store.runs, store.summary(), store.open().map((i) => i.name).join(','), 'runs:', store.runs);
console.log('instances apart:', other.open() !== store.open(), other.runs);
