// @app-lenient
// A field set to null, searched for in an array of its type once set, inside a function that throws nothing else.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

enum Step { First = 'first', Second = 'second' }

@Injectable({ providedIn: 'root' })
class Survey {
  private step: Step = null;
  private title: string = null;
  position(): string {
    const order = [Step.First, Step.Second];
    const at = order.indexOf(this.step);
    return at >= 0 ? `${at + 1} of ${order.length}` : 'none';
  }
  run(): string {
    this.step = Step.Second;
    this.title = 'b';
    return `${this.position()} ${['a', 'b'].includes(this.title)}`;
  }
}

const injector = Injector.create({ providers: [{ provide: Survey, useClass: Survey }] });
runInInjectionContext(injector, () => {
  console.log(inject(Survey).run());
});
