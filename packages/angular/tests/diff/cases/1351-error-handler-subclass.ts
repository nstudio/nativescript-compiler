// An app's ErrorHandler subclass, provided under ErrorHandler, is the one the injector gives; its own
// handleError runs, called through the token and directly, with its own fields.
import '@angular/compiler';
import { ErrorHandler, Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

@Injectable()
class CountingErrorHandler extends ErrorHandler {
  count = 0;
  last = '';
  override handleError(error: any): void {
    this.count++;
    this.last = error instanceof Error ? error.message : String(error);
    console.log('handled', this.count, this.last);
  }
}

const provider = { provide: ErrorHandler, useClass: CountingErrorHandler };
const injector = Injector.create({ providers: [provider] });
const handler = injector.get(ErrorHandler);
console.log(handler instanceof CountingErrorHandler, handler instanceof ErrorHandler, injector.get(ErrorHandler) === handler);
handler.handleError(new Error('boom'));
handler.handleError('plain text');
runInInjectionContext(injector, () => {
  const again = inject(ErrorHandler);
  again.handleError(42);
  console.log(again === handler, (again as CountingErrorHandler).count);
});
const direct = new CountingErrorHandler();
direct.handleError(new TypeError('direct'));
console.log(direct.count, direct.last, handler === direct);
try {
  throw new RangeError('caught');
} catch (e) {
  handler.handleError(e);
}
console.log((handler as CountingErrorHandler).last, provider.provide === ErrorHandler, provider.useClass === CountingErrorHandler);
