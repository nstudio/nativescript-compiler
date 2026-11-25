// computed() made inside a function, from a named function, or with an `equal` naming a function: a signal each read recomputes when its sources change.
import { signal, computed } from '@angular/core';
import type { Signal } from '@angular/core';

function sameParity(a: number, b: number) { return a % 2 === b % 2; }

const base = signal(1);
let runs = 0;
function readBase() { runs++; return base() * 10; }
const tens = computed(readBase);
const parity = signal<number>(2, { equal: sameParity });

function makeSum(extra: number): Signal<number> {
  const sum = computed(() => tens() + extra);
  return sum;
}

const sums = [makeSum(1), makeSum(2)];
console.log(sums.map((s) => s()).join(','), runs);
base.set(3);
console.log(sums.map((s) => s()).join(','), runs);
parity.set(4);
console.log(parity());
parity.set(7);
console.log(parity());

const pick = (first: boolean): Signal<number> => (first ? sums[0] : computed(() => parity() + 100));
console.log(pick(true)(), pick(false)());
