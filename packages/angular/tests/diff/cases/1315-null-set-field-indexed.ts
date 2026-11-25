// @app-lenient
// Fields set to null that hold an array or a record, indexed once set: elements read and written, a method
// called on the array, and the TypeError naming null when indexed while it holds null again.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

@Injectable({ providedIn: 'root' })
class Messages {
  items: string[] = null;
  names: Record<string, number> = null;
  fill(): string {
    this.items = ['a', 'b', 'c'];
    this.names = { one: 1 };
    this.items[1] = 'B';
    this.names['two'] = 2;
    return `${this.items[0]}${this.items[1]} ${this.items.length} ${this.names['two']} ${this.items.indexOf('c')}`;
  }
  clear(): string {
    this.items = null;
    let caught = '';
    try { this.items[0] = 'x'; } catch (e) { caught = (e as Error).message; }
    return caught;
  }
}

const injector = Injector.create({ providers: [{ provide: Messages, useClass: Messages }] });
runInInjectionContext(injector, () => {
  const m = inject(Messages);
  console.log(m.fill());
  console.log(m.clear());
});

class Grid {
  rows: number[] = null;
  sum(): number { this.rows = [1, 2]; return this.rows[0] + this.rows[1]; }
}
console.log(new Grid().sum());
