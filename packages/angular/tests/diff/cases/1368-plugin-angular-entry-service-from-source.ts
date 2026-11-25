// An Angular entry with no component the build compiles runs from its source: its service closes over the app's callback.
// @packages ns-fixture-pager/angular=ns-fixture-pager/angular/fesm2022/ns-fixture-pager-angular.mjs
import { SheetService, type SheetParams } from 'ns-fixture-pager/angular';

const service = new SheetService();
const seen: string[] = [];
const first: SheetParams = service.open('first', (r) => seen.push(r));
const second = service.open('second', (r) => seen.push(r.toUpperCase()));
second.closeCallback('x', 1);
first.closeCallback();
console.log(seen.join(' '), '|', service.history);
