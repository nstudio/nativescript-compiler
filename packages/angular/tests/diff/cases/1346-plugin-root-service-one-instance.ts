// @plugin-both
// A plugin's providedIn-root service injected by two app classes is one instance, made once.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';
import { Tally, madeCount } from './helpers/plugin/root-services.ts';

@Injectable({ providedIn: 'root' })
class Header {
  private tally = inject(Tally);
  tap(): number {
    return this.tally.bump();
  }
}

class Footer {
  readonly tally = inject(Tally);
}

const injector = Injector.create({
  providers: [
    { provide: Tally, useClass: Tally },
    { provide: Header, useClass: Header },
  ],
});
runInInjectionContext(injector, () => {
  const header = inject(Header);
  const footer = new Footer();
  console.log(header.tap(), header.tap(), footer.tally.bump(), footer.tally.count);
  console.log(inject(Tally) === footer.tally, inject(Tally).count, new Footer().tally === footer.tally);
});
console.log(madeCount());
