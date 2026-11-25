// Callbacks that throw, given to what runs them at once and rethrows: NgZone's run family, a signal's update, untracked.
import '@angular/compiler';
import { Injector, NgZone, signal, untracked } from '@angular/core';

const injector = Injector.create({ providers: [] });
const zone = injector.get(NgZone, null);

function checked(n: number): number {
  if (n > 2) throw new Error(`too many: ${n}`);
  return n;
}

function inZone<T>(f: () => T): T {
  return zone ? zone.run(f) : f();
}

const items = signal<number[]>([1]);

function add(n: number): string {
  try {
    items.update((xs) => [...xs, checked(xs.length + n)]);
    return `added ${items().length}`;
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
}

function addInZone(n: number): string {
  try {
    const total = inZone(() => checked(items().length + n));
    return zone ? zone.runOutsideAngular(() => `outside ${checked(total)}`) : `outside ${total}`;
  } catch (e) {
    return `zone refused: ${(e as Error).message}`;
  }
}

function readUntracked(n: number): string {
  try {
    return `untracked ${untracked(() => checked(items().length + n))}`;
  } catch (e) {
    return `untracked refused: ${(e as Error).message}`;
  }
}

console.log(add(0), add(5), items().join(','));
console.log(addInZone(0), addInZone(4));
console.log(readUntracked(0), readUntracked(3));
