// @app-lenient
// A service's fields that hold null as well as undefined, read where any value may go: each reads
// the state it holds, null apart from undefined.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

type Source = 'intro' | 'outro';

@Injectable({ providedIn: 'root' })
class FlowService {
  private source: Source = null;
  private timerId: number;
  private count = 0;
  private names: Record<string, string> = { intro: 'Intro', outro: 'Outro', null: 'none', undefined: 'unset' };
  pick(s: Source): void { this.source = s; this.count = 1; }
  clear(): void { this.source = null; this.timerId = null; }
  describe(): string {
    return `${this.names[this.source]} ${typeof this.timerId} ${String(this.count)} ${JSON.stringify([this.source, this.timerId])}`;
  }
}

const injector = Injector.create({ providers: [{ provide: FlowService, useClass: FlowService }] });
runInInjectionContext(injector, () => {
  const flow = inject(FlowService);
  console.log(flow.describe());
  flow.pick('intro');
  console.log(flow.describe());
  flow.clear();
  console.log(flow.describe());
});
