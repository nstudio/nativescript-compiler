// A value held as `any` given to a library method's typed parameter, and to a component's typed output.
import '@angular/compiler';
import { EventEmitter } from '@angular/core';

interface Mood { name: string; level: number }

class Picker {
  picked = new EventEmitter<Mood>();
  counts = new EventEmitter<number>();
  selected: any = null;
  raw: any = 3;
  choose(m: Mood) {
    this.selected = m;
    this.picked.emit(this.selected);
    this.counts.emit(this.raw);
  }
}

const p = new Picker();
p.picked.subscribe((m) => console.log('picked', m.name, m.level));
p.counts.subscribe((n) => console.log('count', n + 1));
p.choose({ name: 'calm', level: 2 });
