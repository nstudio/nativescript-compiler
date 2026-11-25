// Copyright (c) 2012 Ecma International. All rights reserved.
// This code is governed by the BSD license found in test262's LICENSE file (https://github.com/tc39/test262/blob/main/LICENSE).

// test262's harness/sta.js, typed. test262's own is a constructor function with properties
// assigned to it, which TypeScript does not type as a class. The name field is what the runner and
// $DONE print a thrown Test262Error by.
export class Test262Error {
  name = 'Test262Error';
  message: string;
  constructor(message?: string) {
    this.message = message || '';
  }
  toString(): string {
    return 'Test262Error: ' + this.message;
  }
  static thrower(message?: string): never {
    throw new Test262Error(message);
  }
}

export function $DONOTEVALUATE(): never {
  throw 'Test262: This statement should not be evaluated.';
}
