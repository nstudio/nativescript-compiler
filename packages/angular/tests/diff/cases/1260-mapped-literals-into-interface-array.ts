// `.map` of object literals built by spread (TypeScript types each element as the spread's own shape) where an array
// of an interface is wanted: through `computed<T[]>`, a declared return, a typed local, a field and an argument.
import { computed, signal } from '@angular/core';

interface Card { id: number; title: string; saved?: boolean }
interface Point { index: number; value: number }

const cards = signal<Card[]>([{ id: 1, title: 'one' }, { id: 2, title: 'two', saved: false }]);
const savedIds = new Set<number>([2]);

const marked = computed<Card[]>(() => cards().map((c) => ({ ...c, saved: savedIds.has(c.id) })));

function renamed(): Card[] {
  return cards().map((c) => ({ ...c, title: c.title.toUpperCase() }));
}

function points(values: number[]): Point[] {
  return values.map((v, i) => ({ index: i, value: v * 2, label: `p${i}` }));
}

class Board {
  shown: Card[] = [];
  load(): void {
    this.shown = cards().map((c) => ({ ...c, id: c.id * 10 }));
  }
}

function countSaved(list: Card[]): number {
  return list.filter((c) => c.saved).length;
}

const local: Card[] = cards().map((c) => ({ ...c, saved: true }));
const b = new Board();
b.load();
b.shown.push({ id: 99, title: 'pushed' });

console.log(JSON.stringify(marked()));
console.log(JSON.stringify(renamed()));
console.log(JSON.stringify(points([3, 4])));
console.log(JSON.stringify(b.shown), b.shown.length);
console.log(JSON.stringify(local));
console.log(countSaved(cards().map((c) => ({ ...c, saved: c.id > 1 }))));
const p0 = points([5])[0];
console.log(p0.index, p0.value, p0.value + 1);
cards.set([...cards(), { id: 3, title: 'three' }]);
console.log(marked().length, JSON.stringify(marked()[2]));
