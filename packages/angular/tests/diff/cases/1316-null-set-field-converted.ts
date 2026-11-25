// @app-lenient
// Fields set to null that hold a number or a string, converted as script converts them: arithmetic, unary
// minus, comparison, concatenation and a key, while they hold null, undefined and a value.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

@Injectable({ providedIn: 'root' })
class Counter {
  count: number = null;
  label: string = null;
  names: Record<string, number> = { null: 7, undefined: 8, x: 9 };
  show(): string {
    return `${this.count + 1} ${this.count * 2} ${-this.count} ${this.count < 1} ${this.label + '!'} ${this.names[this.label]}`;
  }
}

const injector = Injector.create({ providers: [{ provide: Counter, useClass: Counter }] });
runInInjectionContext(injector, () => {
  const c = inject(Counter);
  console.log(c.show());
  c.count = undefined;
  c.label = undefined;
  console.log(c.show());
  c.count = 4;
  c.label = 'x';
  console.log(c.show());
});

class Plain {
  step: number = null;
  next(): number { return this.step * 3 + 1; }
}
const p = new Plain();
console.log(p.next());
p.step = 2;
console.log(p.next());
