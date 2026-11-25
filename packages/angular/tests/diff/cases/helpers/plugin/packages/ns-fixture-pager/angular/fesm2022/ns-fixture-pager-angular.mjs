var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result) __defProp(target, key, result);
  return result;
};

// src/angular/params.ts
var SheetParams = class {
  constructor(context, closeCallback) {
    this.context = context;
    this.closeCallback = closeCallback;
  }
};

// src/angular/pager.component.ts
import { Component } from "@angular/core";
import { Pager } from "ns-fixture-pager";
var PagerComponent = class {
  constructor() {
    this.pager = new Pager("component");
  }
  get nativeElement() {
    return this.pager;
  }
};
PagerComponent = __decorateClass([
  Component({ selector: "FixturePager", template: "" })
], PagerComponent);

// src/angular/sheet.service.ts
var SheetService = class {
  constructor() {
    this.closed = [];
  }
  open(context, done) {
    return new SheetParams(context, (...args) => {
      const result = args.length ? `${context}:${args.join(",")}` : `${context}:none`;
      this.closed.push(result);
      done(result);
    });
  }
  get history() {
    return this.closed.join(" | ");
  }
};
export {
  PagerComponent,
  SheetParams,
  SheetService
};
//# sourceMappingURL=ns-fixture-pager-angular.mjs.map
