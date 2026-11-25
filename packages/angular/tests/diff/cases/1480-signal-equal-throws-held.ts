// A throwing `equal` on a class's signal, a linkedSignal's, and options held in a variable: the write's caller sees the throw.
import { signal, linkedSignal } from '@angular/core';

function refuseOdd(a: number, b: number): boolean {
  if (b % 2 !== 0) throw new Error('odd ' + b);
  return a === b;
}

class Counter {
  readonly count = signal<number>(0, { equal: (a, b) => refuseOdd(a, b) });
  readonly label = linkedSignal(() => 'n' + this.count(), { equal: (a: string, b: string) => { if (b === 'bad') throw new Error('bad label'); return a === b; } });
  step(by: number): string {
    this.count.update((v) => v + by);
    return 'stepped to ' + this.count();
  }
}

const c = new Counter();
console.log(c.step(2));
try {
  console.log(c.step(1));
} catch (e) {
  console.log('step threw', (e as Error).message, c.count());
}
try {
  c.label.set('bad');
} catch (e) {
  console.log('label threw', (e as Error).message, c.label());
}
c.label.set('good');
console.log(c.label());

const options = { equal: (a: string, b: string) => { if (b.length > 3) throw new Error('long ' + b); return a === b; } };
const word = signal<string>('a', options);
try {
  word.set('long word');
} catch (e) {
  console.log('word threw', (e as Error).message, word());
}
word.set('abc');
console.log(word());

const plain = signal(1, { equal: (a, b) => a === b });
plain.set(1);
plain.set(2);
console.log('plain', plain());
