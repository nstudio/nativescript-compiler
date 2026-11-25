// An installed bundle changed after its source map was written (a patch-package edit): its sources are not the code that runs.
// @packages ns-fixture-patched/angular=ns-fixture-patched/angular/fesm2022/ns-fixture-patched-angular.mjs
// @refused is not the file its source map describes
import { SheetService } from 'ns-fixture-patched/angular';

const service = new SheetService();
console.log(service.open({ title: 'settings' }));
