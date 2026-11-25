// A plugin's function-typed parameter property is present as declared: called directly, without a check.
// @packages ns-fixture-pager/angular=ns-fixture-pager/angular/fesm2022/ns-fixture-pager-angular.mjs
import { SheetParams } from 'ns-fixture-pager/angular';

const params = new SheetParams({ id: 7 }, (...args: any[]) => console.log('closed with', args.length, args.join('/')));
params.closeCallback();
params.closeCallback('a', 2, null);
console.log(params.context.id, typeof params.closeCallback);
