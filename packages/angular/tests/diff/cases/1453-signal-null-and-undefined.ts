// A signal whose value may be null or undefined both holds the one it is given: read back, compared, passed on and
// written, null stays null and undefined undefined.
import '@angular/compiler';
import { Injectable, signal } from '@angular/core';

const show = (v: string | null | undefined) => (v === null ? 'null' : v === undefined ? 'undefined' : v);

@Injectable()
class Notes {
  note = signal<string | null | undefined>(null);
  count = signal<number | null | undefined>(undefined);
  describe() {
    const v = this.note();
    return `${show(v)} ${v === null} ${v === undefined} ${v ?? 'none'} ${String(this.count())}`;
  }
}

const n = new Notes();
console.log(n.describe());
n.note.set(undefined);
n.count.set(null);
console.log(n.describe());
n.note.set('a');
n.count.set(2);
console.log(n.describe(), show(n.note()));
n.note.set(null);
const held: string | null | undefined = n.note();
console.log(show(held), held === null);
const notes = [n.note(), n.count()];
console.log(notes.length, notes[0] === null, notes[1] === 2);
