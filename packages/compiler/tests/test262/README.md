# test262 conformance

Measures how much of JavaScript's semantics the compiled output keeps. A curated subset of
[tc39/test262](https://github.com/tc39/test262) goes through the same path an app's modules take: type check,
translation, and then the Swift runtime (as a macOS executable) and the Kotlin runtime (on the host JVM). No device
or simulator is needed.

## Running

```sh
cd packages/compiler
node tests/test262/run.ts                      # both backends
node tests/test262/run.ts --swift              # or --kotlin
node tests/test262/run.ts --only built-ins/Math --only self/   # tests whose path contains any of these
node tests/test262/run.ts --list               # what tests.txt selects and why tests are skipped, without running
node tests/test262/run.ts --report             # the results table of the last run, checked against baseline.json
node tests/test262/run.ts --report --readme    # and write it into this README's Results
node tests/test262/run.ts --update-baseline    # rewrite baseline.json from this run
```

| Variable | Default | |
|---|---|---|
| `NS_TEST262_CACHE` | `~/.cache/ns-test262` | test262's tarball at the pinned commit, and the directories `tests.txt` names, extracted from it |
| `NS_TEST262_BUILD` | `<tmp>/ns-test262` | batches, `results-<backend>.json`, `summary.md`, `solo.txt` |
| `NS_TEST262_MIN_FREE_GB` | `8` | the run stops before a batch if less disk space than this is free |
| `NS_TEST262_TIMES` | unset | print each batch's translate, compile and run times |

`--batch <n>` (default 250) sets the number of tests per native build. `--jobs <n>` sets how many test processes run at once. `--keep` keeps the batch directories.

The [Results](#results) table names the test262 and compiler commits it was measured at. To reproduce it, check out
that compiler commit, run `node tests/test262/run.ts`, then `node tests/test262/run.ts --report`.

A full run takes about 45 minutes per backend on a 16-core Mac. A batch's outputs stay under 100 MB and
are deleted once its results are recorded.

**CI.** The run fails only on a regression: a test that is not listed in `baseline.json` and does not pass. When a test
in the baseline starts passing, the run reports it and still succeeds. `--update-baseline` then removes it. A run
with `--only` updates only the entries for the tests it ran.

In GitHub Actions it runs in `.github/workflows/compiler-nightly.yml`, not on every push: nightly (from the default
branch, as GitHub schedules only there), from "Run workflow" on any branch, and on a pull request labelled `test262`.
Kotlin runs on Linux and Swift on macOS, each in its own job; the job summary holds the table.

## What runs

`tests.txt` lists the selection by area. test262 is pinned to one commit (`COMMIT` in `run.ts`) and is never vendored.
The areas are String, template literals, Array, Number, Math, JSON, Object (keys, entries, values, assign,
fromEntries, groupBy, object literals and spread), Map, Set, Promise, Date basics, RegExp basics (with String's
match/matchAll/search), destructuring, classes (with private members and static blocks), getters and setters,
closures and scope, optional chaining and nullish coalescing (with logical assignment), typeof and equality,
exceptions, typed arrays with ArrayBuffer and DataView, Symbol, BigInt, WeakMap/WeakSet/WeakRef, iterators and
generators (with `for-of`), async functions and async iteration, `Function.prototype.call/apply/bind`, the global
functions (`parseInt`, `parseFloat`, `isNaN`, `isFinite`, the URI functions), and `intl402` without Temporal. `self/`
holds the harness's own checks. They must pass on a backend for that backend's numbers to mean anything.

`tests.txt` ends with what is left out and why, one line each: what the compiler refuses by design (`Proxy`,
`Reflect`, `eval`, `with`, `Atomics`, `SharedArrayBuffer`, `FinalizationRegistry`, the `Function` constructors),
Annex B, features the compiler's TypeScript target does not declare (Temporal, the Set methods, the RegExp `v` flag
and modifiers, …), and reflection over the built-ins' own function objects (`length.js`, `name.js`,
`prop-desc.js`, `not-a-constructor.js`, `proto.js`). The rest of test262's language and built-in directories are not
selected yet: they are untested here, not excluded for a cause.

Every selected test ends with one status:

| Status | Meaning |
|---|---|
| pass | Ran natively as test262 expects: no uncaught error, `$DONE` called with nothing for async tests, the expected error for runtime-negative tests. |
| refused | The compiler reports the construct as not supported: an app's release build stops with that error. |
| type check rejected | The build's type check rejects the test, with the lenient checks an app whose tsconfig is not strict gets. Untyped test262 code often passes arguments TypeScript won't accept (`'abc'.indexOf()`, `{}` used as a function). A typed app can't contain this code. |
| compile error | The compiler accepted the test, but swiftc or kotlinc rejected its output, or the translator threw. |
| wrong output | The program built and ran, but not as JavaScript does: an assertion failed, or it threw, crashed, timed out or never called `$DONE`. |
| out of scope | Something the compiler refuses by design: `eval`, `new Function`, `Proxy`, `Reflect` (with the `isConstructor.js` include, which calls `Reflect.construct`), `with`, `SharedArrayBuffer`/`Atomics`, `FinalizationRegistry`, computed `import()`/`require()`. Or something that never applies to compiled code: sloppy-mode-only tests (`noStrict`, `raw`), early errors (TypeScript's parser rejects them first), `$262` host hooks, realms and buffer detaching, module fixtures, and features the compiler's TypeScript target does not declare (`BEYOND_TARGET` in `run.ts`). Detected from test262's `features` and `includes` metadata and from the test's code with comments stripped. |
| harness not ported | Needs a harness include that isn't ported (`testIntl.js`, `nativeErrors.js`, `regExpUtils.js`, …), or holds a typed array constructor as a value (below). |
| fails under Node | The adapted test fails under Node. That means the adaptation is wrong, not the compiler, so the test is not counted. |

Counted tests are those that pass, are refused, are rejected by the type check, fail to compile or give the wrong
output. Pass rate is pass / counted. Accepted pass rate is pass / (pass + compile error + wrong output): of the tests
the compiler accepted, the share that behaved as JavaScript does.

## How a test is adapted

The compiler takes TypeScript only; it resolves `.ts` files and type-checks them first. test262 is untyped JavaScript,
so each test is changed mechanically. No test is edited by hand.

1. The test becomes a module, `t<n>.ts`, of a batch directory whose `tsconfig.json` is not strict. The build then
   checks it the way it checks a non-strict app, and translates it as the CLI translates such an app
   (`appStrictness`). As a module, the test runs in strict mode, which every test not marked `noStrict` is written
   for.
2. One import per harness name the test uses goes in front of the source, on its first line, so test262's line
   numbers stay the same.
3. Each call `assert(…)` becomes `assert.ok(…)`. test262's `assert` is a function with properties assigned to it.
   The TypeScript form of that, a function merged with a namespace, doesn't compile for Swift, so `assert` here
   is a namespace.
4. `assert.throws(TypeError, …)` and `assert.throwsAsync` get the name of a built-in error constructor (`'TypeError'`)
   instead of the constructor itself. The harness then checks with `instanceof` against that constructor and
   none of its subclasses, which is what test262's `thrown.constructor === expected` decides. Passing an error
   constructor as a value does not compile for Swift, and leaving it would fail every `assert.throws` test for
   that one reason. Other constructors (a test's own classes, `URIError`, `EvalError`) are passed as they are.

5. A call of a `testTypedArray.js` runner (`testWithTypedArrayConstructors(function(TA, makeCtorArg) { … })` and
   its variants) becomes a list of cases, one per constructor it runs the test with. Each case is the test's
   function with its constructor parameter replaced by that constructor's name (`new TA(…)` becomes
   `new Float64Array(…)`), which is how the test reads with the constructor known. A constructor held as a value
   does not translate on either backend, and leaving it would fail every typed array test for that one reason. The
   first case stays where the function was; at the top level the others become function declarations after the
   test, so its line numbers stay test262's. A test that still holds a constructor as a value (the `%TypedArray%`
   intrinsic, a list of constructors it builds) is counted as harness not ported. A case the type check rejects
   is checked again with each constructor cast to `any` (`new (Float64Array as any)(…)`): in test262 the parameter is
   untyped, and a test that writes an expando or passes a wrong argument to a typed array is otherwise well typed.

The edits find calls with TypeScript's parser, not with regular expressions. Every adapted test also runs under Node,
built the way the bundler builds it. A test that fails there is marked invalid and not counted.

The harness includes are typed ports in `harness/`. Where they differ from test262's:

- `sta.js`: `Test262Error` is a class with a `name` field.
- `assert.js`: `assert` is a namespace (see 3), and `compareIterator` and `throwsAsync` are part of it. When
  `String(value)` throws, `formatSimpleValue` returns `[object <typeof>]`.
- `propertyHelper.js`: `verifyProperty` and the deprecated `verify*` checks call `hasOwnProperty` and
  `propertyIsEnumerable` on the object rather than through primordials captured with `.call`, which doesn't translate.
  `verifyCallableProperty` and `verifyAccessorProperty` are not ported.
- `asyncHelpers.js`: `asyncTest` doesn't check that `$DONE` is a global, because every async test imports it.
  `throwsAsync` settles through `Promise.resolve(result).then` instead of `result.then` with captured resolvers.
- `testTypedArray.js`: the runners take the cases above. The constructor-argument factories are those the target
  library can build (no resizable or immutable buffers, no `Float16Array`), each a record with its kinds where
  test262 compares functions by identity.
- `doneprintHandle.js` prints with `console.log`. `promiseHelper.js`, `tcoHelper.js`, `dateConstants.js`,
  `assertRelativeDateMs.js`, `decimalToHexString.js`, `nans.js` and `byteConversionValues.js` are typed but
  otherwise unchanged.

## Batching and isolation

The tests are compiled in batches of 250, so each backend needs about 60 native builds rather than one per test.
Within a batch, each failure is kept to the test that caused it:

- The type check runs over the whole batch. Each diagnostic is attributed to its test, those tests are marked
  refused, and the check runs again without them.
- Each module is translated separately. A module the translator refuses affects only its own test.
- A compiler error in a test's own file fails that test, and the batch compiles again without it. Swift reports
  errors at the test's own `.ts` lines through `#sourceLocation`. Errors in shared code are found by halving the batch.
- If the error is a top-level name that another module of the batch also declares (`conflicting declarations`,
  `invalid redeclaration`, `ambiguous use of`), the test is compiled again by itself, the way its own app would
  build it. These tests are listed in `solo.txt`.
- The batch builds one executable (or one set of classes). Its entry point runs the one test named by its argument,
  and each test runs in its own process with a 15-second timeout. A test that crashes or hangs affects only its own
  result.

## Results

<!-- results: generated by run.ts --report --readme -->
test262 `d53ebc8b19`, compiler `2389bc481`, run 2026-11-24. Swift as macOS executables, Kotlin on the host JVM.

| Backend | Selected | Out of scope | Harness not ported | Fails under Node | Counted | Pass | Refused | Type check rejected | Compile error | Wrong output | Pass rate | Accepted pass rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Swift | 18,817 | 3,989 | 432 | 107 | 14,289 | 4,240 | 3,342 | 3,657 | 1,936 | 1,114 | 29.7% | 58.2% |
| Kotlin | 18,817 | 3,989 | 432 | 107 | 14,289 | 4,408 | 3,237 | 3,657 | 1,917 | 1,070 | 30.8% | 59.6% |

By area (`tests.txt` lists each area's directories):

| Area | Selected | Out of scope | Harness not ported | Fails under Node | Counted | Pass | Refused | Type check rejected | Compile error | Wrong output | Pass rate | Accepted pass rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Harness, Swift | 5 | 0 | 0 | 0 | 5 | 5 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| Harness, Kotlin | 5 | 0 | 0 | 0 | 5 | 5 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| String, Swift | 916 | 20 | 0 | 1 | 895 | 253 | 372 | 189 | 41 | 40 | 28.3% | 75.7% |
| String, Kotlin | 916 | 20 | 0 | 1 | 895 | 294 | 368 | 189 | 6 | 38 | 32.8% | 87.0% |
| Template literals, Swift | 84 | 25 | 0 | 2 | 57 | 25 | 0 | 16 | 4 | 12 | 43.9% | 61.0% |
| Template literals, Kotlin | 84 | 25 | 0 | 2 | 57 | 25 | 0 | 16 | 4 | 12 | 43.9% | 61.0% |
| Array, Swift | 2,687 | 165 | 0 | 15 | 2,507 | 825 | 813 | 463 | 269 | 137 | 32.9% | 67.0% |
| Array, Kotlin | 2,687 | 165 | 0 | 15 | 2,507 | 819 | 769 | 463 | 170 | 286 | 32.7% | 64.2% |
| Number, Swift | 294 | 2 | 0 | 0 | 292 | 151 | 94 | 21 | 12 | 14 | 51.7% | 85.3% |
| Number, Kotlin | 294 | 2 | 0 | 0 | 292 | 158 | 100 | 21 | 1 | 12 | 54.1% | 92.4% |
| Math, Swift | 169 | 7 | 0 | 0 | 162 | 130 | 10 | 0 | 22 | 0 | 80.2% | 85.5% |
| Math, Kotlin | 169 | 7 | 0 | 0 | 162 | 146 | 10 | 0 | 6 | 0 | 90.1% | 96.1% |
| JSON, Swift | 136 | 27 | 0 | 0 | 109 | 73 | 11 | 17 | 0 | 8 | 67.0% | 90.1% |
| JSON, Kotlin | 136 | 27 | 0 | 0 | 109 | 75 | 10 | 17 | 0 | 7 | 68.8% | 91.5% |
| Object, Swift | 549 | 76 | 0 | 1 | 472 | 288 | 36 | 66 | 32 | 50 | 61.0% | 77.8% |
| Object, Kotlin | 549 | 76 | 0 | 1 | 472 | 254 | 36 | 66 | 69 | 47 | 53.8% | 68.6% |
| Map, Swift | 165 | 32 | 0 | 1 | 132 | 38 | 71 | 16 | 7 | 0 | 28.8% | 84.4% |
| Map, Kotlin | 165 | 32 | 0 | 1 | 132 | 38 | 71 | 16 | 7 | 0 | 28.8% | 84.4% |
| Set, Swift | 162 | 3 | 0 | 1 | 158 | 44 | 94 | 4 | 16 | 0 | 27.8% | 73.3% |
| Set, Kotlin | 162 | 3 | 0 | 1 | 158 | 52 | 94 | 4 | 8 | 0 | 32.9% | 86.7% |
| Promise, Swift | 675 | 124 | 0 | 3 | 548 | 96 | 175 | 182 | 53 | 42 | 17.5% | 50.3% |
| Promise, Kotlin | 675 | 124 | 0 | 3 | 548 | 112 | 175 | 182 | 41 | 38 | 20.4% | 58.6% |
| Date, Swift | 327 | 6 | 0 | 3 | 318 | 142 | 95 | 35 | 2 | 44 | 44.7% | 75.5% |
| Date, Kotlin | 327 | 6 | 0 | 3 | 318 | 130 | 95 | 35 | 57 | 1 | 40.9% | 69.1% |
| RegExp, Swift | 830 | 114 | 2 | 3 | 711 | 242 | 62 | 348 | 52 | 7 | 34.0% | 80.4% |
| RegExp, Kotlin | 830 | 114 | 2 | 3 | 711 | 221 | 57 | 348 | 79 | 6 | 31.1% | 72.2% |
| Destructuring, Swift | 651 | 165 | 0 | 2 | 484 | 114 | 38 | 247 | 72 | 13 | 23.6% | 57.3% |
| Destructuring, Kotlin | 651 | 165 | 0 | 2 | 484 | 115 | 26 | 247 | 74 | 22 | 23.8% | 54.5% |
| Classes, Swift | 666 | 140 | 0 | 6 | 520 | 37 | 137 | 236 | 84 | 26 | 7.1% | 25.2% |
| Classes, Kotlin | 666 | 140 | 0 | 6 | 520 | 47 | 132 | 236 | 82 | 23 | 9.0% | 30.9% |
| Getters and setters, Swift | 64 | 10 | 0 | 0 | 54 | 3 | 20 | 6 | 19 | 6 | 5.6% | 10.7% |
| Getters and setters, Kotlin | 64 | 10 | 0 | 0 | 54 | 2 | 20 | 6 | 19 | 7 | 3.7% | 7.1% |
| Closures and scope, Swift | 366 | 177 | 0 | 10 | 179 | 40 | 26 | 66 | 33 | 14 | 22.3% | 46.0% |
| Closures and scope, Kotlin | 366 | 177 | 0 | 10 | 179 | 50 | 23 | 66 | 21 | 19 | 27.9% | 55.6% |
| Optional chaining and nullish, Swift | 140 | 30 | 0 | 2 | 108 | 30 | 3 | 62 | 13 | 0 | 27.8% | 69.8% |
| Optional chaining and nullish, Kotlin | 140 | 30 | 0 | 2 | 108 | 38 | 3 | 62 | 5 | 0 | 35.2% | 88.4% |
| typeof and equality, Swift | 161 | 16 | 0 | 2 | 143 | 21 | 4 | 108 | 6 | 4 | 14.7% | 67.7% |
| typeof and equality, Kotlin | 161 | 16 | 0 | 2 | 143 | 29 | 4 | 108 | 0 | 2 | 20.3% | 93.5% |
| Exceptions, Swift | 295 | 73 | 18 | 11 | 193 | 79 | 19 | 35 | 40 | 20 | 40.9% | 56.8% |
| Exceptions, Kotlin | 295 | 73 | 18 | 11 | 193 | 71 | 10 | 35 | 42 | 35 | 36.8% | 48.0% |
| Typed arrays and buffers, Swift | 2,668 | 986 | 254 | 2 | 1,426 | 579 | 305 | 47 | 306 | 189 | 40.6% | 53.9% |
| Typed arrays and buffers, Kotlin | 2,668 | 986 | 254 | 2 | 1,426 | 531 | 344 | 47 | 409 | 95 | 37.2% | 51.3% |
| Symbol, Swift | 63 | 23 | 0 | 1 | 39 | 7 | 22 | 4 | 2 | 4 | 17.9% | 53.8% |
| Symbol, Kotlin | 63 | 23 | 0 | 1 | 39 | 7 | 22 | 4 | 1 | 5 | 17.9% | 53.8% |
| BigInt, Swift | 56 | 2 | 0 | 0 | 54 | 21 | 21 | 2 | 10 | 0 | 38.9% | 67.7% |
| BigInt, Kotlin | 56 | 2 | 0 | 0 | 54 | 21 | 22 | 2 | 9 | 0 | 38.9% | 70.0% |
| Weak references, Swift | 216 | 46 | 0 | 2 | 168 | 29 | 104 | 17 | 4 | 14 | 17.3% | 61.7% |
| Weak references, Kotlin | 216 | 46 | 0 | 2 | 168 | 28 | 104 | 17 | 4 | 15 | 16.7% | 59.6% |
| Iterators and generators, Swift | 2,111 | 881 | 3 | 3 | 1,224 | 279 | 126 | 409 | 288 | 122 | 22.8% | 40.5% |
| Iterators and generators, Kotlin | 2,111 | 881 | 3 | 3 | 1,224 | 357 | 98 | 409 | 235 | 125 | 29.2% | 49.8% |
| Async functions, Swift | 2,743 | 494 | 1 | 11 | 2,237 | 495 | 210 | 843 | 494 | 195 | 22.1% | 41.8% |
| Async functions, Kotlin | 2,743 | 494 | 1 | 11 | 2,237 | 555 | 191 | 843 | 445 | 203 | 24.8% | 46.1% |
| Function, Swift | 189 | 69 | 0 | 0 | 120 | 11 | 53 | 23 | 29 | 4 | 9.2% | 25.0% |
| Function, Kotlin | 189 | 69 | 0 | 0 | 120 | 26 | 33 | 23 | 26 | 12 | 21.7% | 40.6% |
| Global functions, Swift | 292 | 0 | 0 | 6 | 286 | 141 | 9 | 20 | 24 | 92 | 49.3% | 54.9% |
| Global functions, Kotlin | 292 | 0 | 0 | 6 | 286 | 161 | 9 | 20 | 94 | 2 | 56.3% | 62.6% |
| Intl, Swift | 1,137 | 276 | 154 | 19 | 688 | 42 | 412 | 175 | 2 | 57 | 6.1% | 41.6% |
| Intl, Kotlin | 1,137 | 276 | 154 | 19 | 688 | 41 | 411 | 175 | 3 | 58 | 6.0% | 40.2% |

Wrong output, by what the run showed: Swift an assertion failed 779, an error the test does not expect 283, a crash or a timeout 52, an async test that never finished 0; Kotlin an assertion failed 583, an error the test does not expect 479, a crash or a timeout 1, an async test that never finished 7.

Counted is pass + refused + type check rejected + compile error + wrong output. Pass rate is pass / counted.
Accepted pass rate is pass / (pass + compile error + wrong output): of the tests the compiler accepted, the share that
ran as JavaScript does.
<!-- /results -->

Wrong output is a test the compiler accepted that ran and did not do what JavaScript does; the line under the tables,
written with them, counts what the runs showed (a failed assertion, an unexpected error, a crash or timeout). By what
the test does, at the commit the tables name (Swift / Kotlin, each test under the first that applies): accessors
defined with `Object.defineProperty` on an object the program types or an array element, 189 / 328; the iteration
protocol in `for…of`, `for await…of` and generators (closing, delegation, async steps), 264 / 228; typed-array and
buffer methods, 227 / 198; property attributes (`writable: false`, `freeze`, `verifyProperty`), 151 / 168; an
object's own `valueOf`, `toString` or `Symbol.toPrimitive` in a conversion, 211 / 73; wrapper objects (`new String`,
`Object(1)`), 66 / 3; none of these, 387 / 405. Functions used as constructors with an assigned `prototype` no longer
run wrong: those tests fail to compile (240 on each backend). test262 is untyped JavaScript adapted
mechanically to typed modules, so it measures the compiler on code written without types; the differential cases
(`tests/diff`) measure it on typed code.

`baseline.json` records every counted test that does not pass, with its reason, for routing fixes.
`results-<backend>.json` in the build directory has the same information for every test.
