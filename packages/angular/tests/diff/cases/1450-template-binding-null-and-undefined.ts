// An Angular class's template binding (`$bN()`, as angular.ts writes one) whose value may be null or undefined: read
// as the template reads it, null and undefined apart.
import '@angular/compiler';
import { Injectable } from '@angular/core';

interface Item {
  label: string;
  note?: string | null;
}

@Injectable()
class Card {
  item: Item | null = null;
  $b0() {
    return this.item?.note;
  }
}

const c = new Card();
const show = (v: string | null | undefined) => (v === null ? 'null' : v === undefined ? 'undefined' : v);
console.log(show(c.$b0()));
c.item = { label: 'a' };
console.log(show(c.$b0()));
c.item = { label: 'b', note: null };
console.log(show(c.$b0()));
c.item = { label: 'c', note: 'n' };
console.log(show(c.$b0()));
