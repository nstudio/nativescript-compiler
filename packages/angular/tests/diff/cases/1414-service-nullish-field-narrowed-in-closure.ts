// A service's field that may hold null or undefined, narrowed by a truthiness test and then read and called inside
// a closure, as well as outside one; and a service's field written from outside with null and with an untyped value.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

class Handle {
  constructor(public name: string) {}
  destroy(): string { return 'destroyed ' + this.name; }
}

@Injectable({ providedIn: 'root' })
class HandleService {
  current: Handle | null | undefined;
  spare: Handle | null = null;
  log: string[] = [];
  replace(next: Handle | null | undefined): void {
    const drop = () => {
      if (this.current) this.log.push(this.current.destroy());
      if (this.spare) { this.log.push(this.spare.destroy()); }
    };
    drop();
    if (this.current) this.log.push('outside ' + this.current.name);
    this.current = next;
  }
}

const injector = Injector.create({ providers: [{ provide: HandleService, useClass: HandleService }] });
runInInjectionContext(injector, () => {
const s = inject(HandleService);
console.log(s.current === undefined, s.spare === null);
s.replace(new Handle('a'));
s.spare = new Handle('s');
s.replace(null);
console.log(s.current === null, s.log.join(', '));
s.replace(undefined);
s.replace(new Handle('b'));
s.spare = null;
s.replace(undefined);
console.log(s.current === undefined, s.spare === null, s.log.join(', '));
const found: any = new Handle('c');
s.spare = found;
s.replace(undefined);
console.log(s.spare === found, s.log.length, s.log[s.log.length - 1]);
});
