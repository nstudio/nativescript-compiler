// A package's secondary entry (`pkg/angular`) with no index file: its own package.json's `module` names the ES module bundle, compiled from the sources its map lists.
// @packages ns-fixture-sheet/angular=ns-fixture-sheet/angular/fesm2022/ns-fixture-sheet-angular.mjs
import { SheetService } from 'ns-fixture-sheet/angular';

const service = new SheetService();
console.log(service.open());
console.log(service.open({ title: 'settings', pinned: true }));
console.log(service.summary());
