// @plugin-both
// A plugin's providedIn-root service and its root subclasses, a plugin's and an app's, each have their own one instance.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';
import { Channel, LoudChannel } from './helpers/plugin/root-services.ts';

@Injectable({ providedIn: 'root' })
class QuietChannel extends Channel {
  override kind(): string {
    return 'quiet';
  }
}

const injector = Injector.create({
  providers: [
    { provide: Channel, useClass: Channel },
    { provide: LoudChannel, useClass: LoudChannel },
    { provide: QuietChannel, useClass: QuietChannel },
  ],
});
runInInjectionContext(injector, () => {
  const plain = inject(Channel);
  const loud = inject(LoudChannel);
  const quiet = inject(QuietChannel);
  console.log(plain.send('a'), loud.send('b'), loud.send('c'), quiet.send('d'));
  console.log(inject(Channel) === plain, inject(LoudChannel) === loud, inject(QuietChannel) === quiet);
  console.log((plain as Channel) === loud, (loud as Channel) === quiet, loud instanceof Channel, quiet instanceof Channel);
  console.log(plain.sent.join(' '), loud.sent.join(' '), quiet.sent.join(' '));
});
