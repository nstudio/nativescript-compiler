// @plugin-both
// A plugin's providedIn-root service whose constructor takes another root service gets that service's one instance.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';
import { Ledger, Tally, madeCount } from './helpers/plugin/root-services.ts';

@Injectable({ providedIn: 'root' })
class Journal {
  private ledger = inject(Ledger);
  write(entry: string): string {
    return this.ledger.record(entry);
  }
}

const injector = Injector.create({
  providers: [
    { provide: Tally, useClass: Tally },
    { provide: Ledger, useClass: Ledger },
    { provide: Journal, useClass: Journal },
  ],
});
runInInjectionContext(injector, () => {
  const journal = inject(Journal);
  console.log(journal.write('a'), journal.write('b'));
  const tally = inject(Tally);
  console.log(tally.count, tally.bump(), inject(Ledger).record('c'), inject(Ledger).entries.join(','));
});
console.log(madeCount());
