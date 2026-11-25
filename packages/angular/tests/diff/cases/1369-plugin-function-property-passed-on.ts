// A plugin's function-typed parameter property passed on as a value and called through the reference.
// @packages ns-fixture-pager/angular=ns-fixture-pager/angular/fesm2022/ns-fixture-pager-angular.mjs
import { SheetParams } from 'ns-fixture-pager/angular';

function closeLater(close: (...args: any[]) => void, value: string): void {
  close(value, value.length);
}

const log: string[] = [];
const params = new SheetParams('ctx', (...args: any[]) => log.push(args.join('=')));
closeLater(params.closeCallback, 'done');
const close = params.closeCallback;
close('again');
console.log(log.join(';'), params.context);
