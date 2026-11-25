// @app-lenient
// A service's fields declared without an initializer are its own stored fields, which its methods write.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

let made = 0;

@Injectable({ providedIn: 'root' })
class FlowService {
  private flowId: string;
  private timer: number;
  constructor() {
    made++;
  }
  start(s: string, t: number): void {
    this.flowId = s + '-1';
    this.timer = t;
  }
  describe(): string {
    return `${this.flowId} ${this.timer}`;
  }
  started(): boolean {
    return this.flowId !== undefined;
  }
}

const injector = Injector.create({ providers: [{ provide: FlowService, useClass: FlowService }] });
runInInjectionContext(injector, () => {
  const flow = inject(FlowService);
  flow.start('a', 3);
  console.log(flow.describe(), flow.started());
  console.log(inject(FlowService).describe());
});
console.log(made);
