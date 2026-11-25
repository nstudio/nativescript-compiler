// src/angular/index.ts
import { Sheet, describe } from "ns-fixture-sheet";

// src/angular/options.ts
var DEFAULTS = { title: "untitled", pinned: false };
function merged(options) {
  return { ...DEFAULTS, ...options };
}

// src/angular/index.ts
var SheetService = class {
  sheet = new Sheet("service");
  open(options = {}) {
    const o = merged(options);
    return this.sheet.show(o.title, o.pinned);
  }
  summary() {
    return describe(this.sheet);
  }
};
export {
  SheetService
};
//# sourceMappingURL=ns-fixture-sheet-angular.mjs.map
