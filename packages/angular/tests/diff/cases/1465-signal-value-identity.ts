// A signal or computed that a function returns, alone or in an object, is the signal itself: each call reads it live.
import { signal, computed, untracked } from '@angular/core';
import type { Signal } from '@angular/core';

function exposed(): Signal<string> {
  const name = signal('x');
  name.set('y');
  return name.asReadonly();
}
const r = exposed();
console.log('returned', r());

function makeLabel(prefix: string) {
  const name = signal('a');
  const suffix = signal('!');
  let made = 0;
  const label = computed(() => {
    made++;
    const s = untracked(() => suffix());
    return prefix + name() + s;
  });
  return { label, name, suffix, made: () => made };
}
const l = makeLabel('#');
console.log(l.label(), l.made());
l.suffix.set('?');
console.log(l.label(), l.made());
l.name.set('b');
console.log(l.label(), l.made());
