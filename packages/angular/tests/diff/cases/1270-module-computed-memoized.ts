// A module-level computed keeps one value until a signal it read changes: reads share identity, writes into it last.
import { signal, computed } from '@angular/core';

interface Row { id: number; title: string }

const source = signal<number[]>([1, 2, 3]);
let runs = 0;
const rows = computed<Row[]>(() => {
  runs++;
  return source().map((id) => ({ id, title: `row ${id}` }));
});

console.log('before read:', runs);
console.log('same row:', rows()[0] === rows()[0], 'same list:', rows() === rows());
rows()[0].title = 'edited';
console.log('kept write:', rows()[0].title, 'runs:', runs);
const first = rows();
source.set([4, 5]);
console.log('lazy after set:', runs);
console.log('new list:', rows() !== first, rows().length, rows()[0].title, 'runs:', runs);
console.log('again:', rows() === rows(), 'runs:', runs);
