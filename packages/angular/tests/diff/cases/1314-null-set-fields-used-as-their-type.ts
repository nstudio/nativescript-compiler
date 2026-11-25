// @app-lenient
// Fields set to null that hold an object or a function, used as their type once set: members read,
// written and called on them, the function called, and the object passed where its class goes; a member
// read once the field holds null again is the TypeError naming null.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

class Box {
  opacity = 1;
  label = 'box';
  inner = { depth: 2 };
  on(name: string, fn: () => void): string { fn(); return `${this.label}:${name}`; }
}

function describe(b: Box): string { return `${b.label} ${b.opacity}`; }

@Injectable({ providedIn: 'root' })
class Holder {
  private box: Box = null;
  private done: () => void = null;
  private title: string = null;
  private hits = 0;
  open(): string {
    this.box = new Box();
    this.done = () => { this.hits++; };
    this.box.opacity = 0.5;
    const shown = this.box.on('closed', () => this.done());
    this.done();
    this.title = 'T';
    return `${shown} ${this.box.inner.depth} ${describe(this.box)} ${this.hits} ${this.title.length}`;
  }
  close(): string {
    this.box = null;
    this.done = null;
    let caught = '';
    try { this.box.on('x', () => {}); } catch (e) { caught = (e as Error).message; }
    this.done?.();
    return `${this.box === null} ${this.done === undefined} ${caught}`;
  }
}

const injector = Injector.create({ providers: [{ provide: Holder, useClass: Holder }] });
runInInjectionContext(injector, () => {
  const h = inject(Holder);
  console.log(h.open());
  console.log(h.close());
});

class Plain {
  box: Box = null;
  set(): number { this.box = new Box(); this.box.opacity = 0.25; return this.box.opacity + this.box.label.length; }
}
console.log(new Plain().set());
