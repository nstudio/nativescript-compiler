// An Angular class's field that may hold null or undefined both, read by its template bindings (`$bN()`, as angular.ts
// writes them): each binding reads the one the field holds, compared, interpolated and passed on as JavaScript does.
import '@angular/compiler';
import { Injectable } from '@angular/core';

const show = (v: string | null | undefined) => (v === null ? 'null' : v === undefined ? 'undefined' : v);

@Injectable()
class Detail {
  note: string | null | undefined = null;
  step = 0;
  next() {
    this.step++;
    this.note = this.step % 3 === 0 ? null : this.step % 3 === 1 ? undefined : 'n' + this.step;
  }
  $b0() {
    return this.note;
  }
  $b1() {
    return this.note === null;
  }
  $b2() {
    return `${this.note ?? ''}|${this.note == null}`;
  }
}

const d = new Detail();
for (let i = 0; i < 4; i++) {
  console.log(show(d.$b0()), d.$b1(), d.$b2(), String(d.note));
  d.next();
}
