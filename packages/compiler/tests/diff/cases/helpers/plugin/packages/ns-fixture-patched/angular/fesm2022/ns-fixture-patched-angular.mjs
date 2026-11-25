// src/angular/index.ts
import { Sheet, describe } from "ns-fixture-patched";

// src/angular/options.ts
var DEFAULTS = { title: "untitled", pinned: false };
function merged(options) {
  return { ...DEFAULTS, ...options };
}

// src/angular/index.ts
var SheetService = class {
  sheet = new Sheet("service");
  open(options = {}) {
    return this.sheet.show(merged(options).title, true);
  }
  summary() {
    return describe(this.sheet);
  }
};
export {
  SheetService
};
//# sourceMappingURL=ns-fixture-patched-angular.mjs.map
