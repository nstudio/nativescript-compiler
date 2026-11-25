// A class's computed fields (from an arrow, from a named function, aliasing a module's computed) passed and held as signals, each read live.
import { signal, computed } from '@angular/core';
import type { Signal } from '@angular/core';

const unit = signal(2);
function triple() { return unit() * 3; }
const squared = computed(() => unit() * unit());

interface Holder { label: string; source: Signal<number>; }

class Panel {
  local = signal(1);
  sum = computed(() => this.local() + unit());
  tripled = computed(triple);
  alias = squared;
  holders: Holder[] = [
    { label: 'sum', source: this.sum },
    { label: 'tripled', source: this.tripled },
    { label: 'alias', source: this.alias },
  ];
  read(s?: Signal<number>) { return s ? s() : -1; }
}

const p = new Panel();
const line = () => p.holders.map((h) => `${h.label}=${h.source()}`).join(' ');
console.log(line(), p.read(), p.read(p.tripled), p.alias(), p.tripled());
unit.set(5);
p.local.set(10);
console.log(line(), p.read(p.sum), p.alias(), p.tripled());
