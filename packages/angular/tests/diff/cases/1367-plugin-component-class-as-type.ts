// A plugin component class the app names only as a type: a field and a parameter typed by it hold any value.
// @packages ns-fixture-pager/angular=ns-fixture-pager/angular/fesm2022/ns-fixture-pager-angular.mjs
import '@angular/compiler';
import { PagerComponent } from 'ns-fixture-pager/angular';

class Indicator {
  pagerViewRef: PagerComponent | null = null;
  describe(ref: PagerComponent | null): string {
    return ref === null ? 'no pager' : 'pager';
  }
}

const indicator = new Indicator();
console.log(indicator.describe(indicator.pagerViewRef));
indicator.pagerViewRef = null;
console.log(indicator.describe(indicator.pagerViewRef), indicator.pagerViewRef === null);
