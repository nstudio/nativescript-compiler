// Copyright (C) 2015 André Bargull. All rights reserved.
// This code is governed by the BSD license found in test262's LICENSE file (https://github.com/tc39/test262/blob/main/LICENSE).

// test262's harness/testTypedArray.js, typed, for tests that run.ts has expanded to one case per constructor: a
// constructor held as a value does not translate, so a case names its constructor and builds with it. The argument
// factories are those the target library can build (no resizable or immutable buffers); each is a record with its
// kinds, where test262 compares functions by identity, and is bound to its case by a closure.
import { isPrimitive } from './assert.ts';
import { Test262Error } from './sta.ts';

interface Constructor {
  name: string;
  make: (source: any) => any;
}
export interface TypedArrayCase extends Constructor {
  test: (makeCtorArg: (primitiveOrIterable: any) => any) => void;
}
export interface TypedArrayConversionCase extends Constructor {
  test: (value: any, expected: any, initial: number) => void;
}
type ArgFactory = { name: string; kinds: string[]; make: (TA: Constructor, primitiveOrIterable: any) => any };

function makeArray(TA: Constructor, primitiveOrIterable: any): any {
  if (isPrimitive(primitiveOrIterable)) {
    const n = Number(primitiveOrIterable);
    if (!(n >= 0 && n < 9007199254740992)) return primitiveOrIterable;
    return Array.from({ length: n }, () => '0');
  }
  return Array.from(primitiveOrIterable);
}

function makeArrayLike(TA: Constructor, primitiveOrIterable: any): any {
  const arr = makeArray(TA, primitiveOrIterable);
  if (isPrimitive(arr)) return arr;
  const obj: any = { length: arr.length };
  for (let i = 0; i < obj.length; i++) obj[i] = arr[i];
  return obj;
}

function makeIterable(TA: Constructor, primitiveOrIterable: any): any {
  const src: any[] = makeArray(TA, primitiveOrIterable);
  if (isPrimitive(src)) return src;
  return { [Symbol.iterator]: () => src.values() };
}

function makeArrayBuffer(TA: Constructor, primitiveOrIterable: any): any {
  const arr = makeArray(TA, primitiveOrIterable);
  if (isPrimitive(arr)) return arr;
  return TA.make(arr).buffer;
}

const typedArrayCtorArgFactories: ArgFactory[] = [
  { name: 'makePassthrough', kinds: ['passthrough'], make: (TA, primitiveOrIterable) => primitiveOrIterable },
  { name: 'makeArray', kinds: ['arraylike'], make: makeArray },
  { name: 'makeArrayLike', kinds: ['arraylike'], make: makeArrayLike },
  { name: 'makeIterable', kinds: ['iterable'], make: makeIterable },
  { name: 'makeArrayBuffer', kinds: ['arraybuffer'], make: makeArrayBuffer },
];
const KINDS = ['passthrough', 'arraylike', 'iterable', 'arraybuffer', 'resizable', 'immutable'];

function ctorArgFactoryMatchesSome(argFactory: ArgFactory, features: string[]): boolean {
  for (const f of features) {
    if (!KINDS.includes(f)) throw new Test262Error('unknown feature: ' + f);
    if (argFactory.kinds.includes(f)) return true;
  }
  return false;
}

/** testWithAllTypedArrayConstructors, over the cases run.ts made of the test's function, one per constructor. */
export function testTypedArrayCases(cases: TypedArrayCase[], includeArgFactories?: string[] | null, excludeArgFactories?: string[] | null): void {
  let ctorArgFactories = typedArrayCtorArgFactories;
  if (includeArgFactories) ctorArgFactories = ctorArgFactories.filter((a) => ctorArgFactoryMatchesSome(a, includeArgFactories));
  if (excludeArgFactories) ctorArgFactories = ctorArgFactories.filter((a) => !ctorArgFactoryMatchesSome(a, excludeArgFactories));
  if (ctorArgFactories.length === 0) throw new Test262Error('no arg factories match include ' + includeArgFactories + ' and exclude ' + excludeArgFactories);
  for (const argFactory of ctorArgFactories) {
    for (const c of cases) {
      try {
        c.test((primitiveOrIterable) => argFactory.make(c, primitiveOrIterable));
      } catch (e: any) {
        e.message += ' (Testing with ' + c.name + ' and ' + argFactory.name + '.)';
        throw e;
      }
    }
  }
}

/** testTypedArrayConversions, over the cases run.ts made of the test's function. */
export function testTypedArrayConversionCases(byteConversionValues: any, cases: TypedArrayConversionCase[]): void {
  const values: any[] = byteConversionValues.values;
  const expected = byteConversionValues.expected;
  for (const c of cases) {
    const name = c.name.slice(0, -5);
    values.forEach((value, index) => {
      const exp = expected[name][index];
      c.test(value, exp, exp === 0 ? 1 : 0);
    });
  }
}
