// Values that may be null or undefined both, read from fields and signals into arrays of one or several present types:
// each element keeps the one it was given, and compares with null and undefined as JavaScript does.
import '@angular/compiler';
import { signal } from '@angular/core';
class Box { x: string | null | undefined = null; y: number | null | undefined = undefined; }
const b = new Box();
const a = [b.x, b.y];
console.log(a.length, a[0] === null, a[1] === undefined);
const c = [b.x, 'z'];
console.log(c[0] === null, c[0] === undefined);
const s = signal<string | null | undefined>(null);
const d = [s(), 'z'];
console.log(d[0] === null, d[0] === undefined);
const w = s();
const k = (v: string | null | undefined) => String(v);
console.log(k(w), k(s()), `${s()}`, [s()].length);
const t = signal<number | null | undefined>(undefined);
const e = [s(), t()];
console.log(e[0] === null, e[1] === undefined, e[1] === null);
console.log(a[0] == null, a[0] == undefined, a[0] != null, e[1] == null, c[1] != undefined);
const v = s();
console.log(v == null, v != undefined, t() == null, t() != null, s() == undefined);
console.log(c[0] == null, c[0] != undefined, d[0] == undefined, d[1] != null);
