// A service's field that starts null and is written from an untyped value: compared with ===, it holds the
// undefined the untyped value gave, apart from null, and the null it was set to again.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

@Injectable({ providedIn: 'root' })
class InviteService {
  respondingTo: string | null = null;
  respond(request: any): void { this.respondingTo = request.id; }
  busy(request: any): boolean { return this.respondingTo === request.id; }
  clear(): void { this.respondingTo = null; }
}

const injector = Injector.create({ providers: [{ provide: InviteService, useClass: InviteService }] });
runInInjectionContext(injector, () => {
const c = inject(InviteService);
const none: any = {};
console.log(c.respondingTo === null, c.busy({ id: 'a' }), c.busy(none));
c.respond(none);
console.log(c.respondingTo === undefined, c.respondingTo === null, c.busy(none), c.busy({ id: 'a' }));
c.respond({ id: 'a' });
console.log(c.respondingTo, c.busy({ id: 'a' }), c.busy(none));
c.clear();
console.log(c.respondingTo === null, c.busy(none));
});
