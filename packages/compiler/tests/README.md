# The compiler's tests

Run every command from `packages/compiler`, after `npm ci` there and `npm ci --prefix tests` (what the cases are typed
against). The Swift harnesses need macOS with Xcode; the Kotlin ones need a JDK and `kotlinc` (`$KOTLINC`, on `PATH`, or
the one Gradle cached for kit-android).

## What runs where

CI jobs are those of `.github/workflows/ci.yml` (every push and pull request) unless named
otherwise; `nightly` is `.github/workflows/compiler-nightly.yml`, which runs on a nightly schedule, via manual
`workflow_dispatch`, and on pull requests labelled `nightly`, `test262`, `fuzz`, or `decision-parity`.

| Harness | Command | CI | Cost |
|---|---|---|---|
| The harnesses type-checked (Node strips their types unchecked) | `node_modules/.bin/tsc -p tsconfig.tests.json` | `host` | seconds |
| `src/`'s layers: the shared front imports no backend, driver or target, neither backend the other, no value-import cycle; the front names a backend only through `semantics/ledger.ts`; the front and the backends keep no module-level state (a translation's is its translator's) but weak caches and the entries `MODULE_STATE` names | `node tests/checks/layers.ts` (also `nx run compiler:test`) | `host` | seconds |
| What both backends still define twice (same-name functions, identical bodies, decision-only twins, shared lines), held to `checks/twins.json`: a count may only fall, and is lowered there when it does | `node tests/checks/twins.ts [--write] [--list]` (also `nx run compiler:test`) | `host` | seconds |
| Runtime operations: every runtime function the backends call is an operation of `src/semantics/runtime.ts` its kit's index declares, and no string or template text in `src/` spells a call of one | `node tests/checks/runtime-ops.ts` (also `nx run compiler:test`) | `host` | seconds |
| Front unit tests: the shared front's API tables (`src/semantics/apis/`) against Node's answers (`semantics/js-answers.json`, recorded by `node tests/semantics/record-js-answers.ts`), and the template plan (`src/template/plan.ts`): its order under each behaviour, and one plan for both backends but where the ledger names a difference | `node --test tests/semantics/` (also `nx run compiler:test`) | `host` | seconds |
| Every diff case on both backends, or its `@swift`/`@kotlin` line naming a ledger entry the backends differ in or the refusal the other gives; each API table (methods, global functions, statics) spelled whole by both | `node tests/checks/both-backends.ts` (also `nx run compiler:test`) | `host` | seconds |
| Differential cases: each case under Node and as a native program, output and exit status compared | `node tests/diff/run.ts [case…] [--swift \| --kotlin]` | `host` (Kotlin), `ios` (Swift); with `--osize` on a push, or a pull request labelled `osize` | minutes per backend; unchanged cases reuse their stored outcome, stored from any checkout or build folder (`build-cache.ts`) |
| Decision parity: diff cases on both backends translated with `NS_DECISION_TRACE` (`src/semantics/decision-trace.ts`), each front answer (ProgramFacts, the front methods, ValueStates, `plan()`) and each native type a value is held as compared question by question; an answer keyed by the ledger is left out, and one that read a backend's own facts (binding, kit, which types it holds optional) is counted apart where the backends answered those differently (`--verbose` lists them). `--set merge` (the default) runs the cases `checks/decision-parity-cases.json` lists, which together ask every question and read every ledger field and backend input the full set does; `--set nightly` runs every case and fails when the merge set no longer covers it (`--update-set` chooses it again) | `node tests/checks/decision-parity.ts [case…] [--set merge \| nightly] [--update-set] [--verbose]` (also `nx run compiler:test`) | `ios`: the per-merge set; `nightly`: every case | about a minute on a 16-core Mac; every case, five minutes there and tens of minutes on a CI runner |
| Determinism: every diff case translated alone (a fresh worker) and inside the suite, the outputs byte-identical | `node tests/checks/determinism.ts [case…] [--swift \| --kotlin]` | `host` (Kotlin), `ios` (Swift) | minutes per backend |
| wtfjs coverage table (`diff/WTFJS.md`) | `node tests/diff/wtfjs.ts [--check]` | `host` (`--check`) | seconds |
| The docs: generated tables current (refusals, ledger, the diff suite below), links and named paths resolve, every kit runtime file in `docs/KIT.md`'s ECMA-262 table | `node tests/checks/docs.ts [--write]` (also `nx run compiler:test`) | `host` | seconds |
| Type-violation fuzzing: a typed value replaced by a wrong one, Node the referee | `node tests/fuzz/run.ts [case…] [--swift \| --kotlin] [--set merge \| nightly]` | `host`, `ios`: the per-merge set; `nightly`: the full set | minutes per backend; the full set, hours |
| test262, the selection in `test262/tests.txt` | `node tests/test262/run.ts [--swift \| --kotlin]` | `nightly` | about 45 minutes per backend on a 16-core Mac |
| Release checks: preflight, version ranges, source mapping, Kotlin diagnostics | `node tests/release-checks/run.ts` | `host`, release | a minute |
| The adapter API, with a framework that exists only here | `node tests/adapters/run.ts` | `host` | seconds |
| kit-android's Worker, and worker scripts' shared state | `node tests/worker/run.ts`, `node tests/worker-state/run.ts` | `host` | a minute |
| The harness's own module resolution (platform files) | `node tests/native-build-check.ts [--swift \| --kotlin]` | `host` (Kotlin), `ios` (Swift) | seconds |
| XML apps (`xml-ts/`, `apps/automated`, `apps/toolbox`): page plans, compiled bindings against core's evaluator, binding contexts, pages | `node tests/xml-plan-check.ts`, `xml-bindings-check.ts`, `xml-contexts-check.ts`, `xml-pages-check.ts` | `kit` | a minute |
| Core classes the generated kits name apart, from an app's code | `node tests/kit-class-names-check.ts`, after `nx run compiler:kit` and `compiler:kit-android` | `kit` | seconds |
| Traps (`!`, `!!`, `fatalError`) in the kits against `no-trap-allow.txt` | `node tests/no-trap-check.ts --kotlin` (Swift: inside `kit-build.sh`) | `kit` | seconds |
| The generated iOS kit built whole in a fixture app (`app/`), with `kit-index-check.ts`, `kit-manifest-check.ts`, `kit-warnings.ts` | `tests/kit-build.sh <built core>` | `ios`, release | tens of minutes |
| The fixture app launched on a simulator or emulator | `tests/launch-check.sh`, `tests/launch-check-android.sh` | `ios`, `android`, release | minutes |
| The packed compiler building an app from the tarball alone | `tests/pack-check.sh <android \| ios> <built core>` | `android`, release | tens of minutes |
| Both kits present before packing | `node tests/kits-present.ts` | `npm pack` | seconds |
| A framework's `ns create` template app, translated and built | `node tests/template-app.ts <fixture> <out>` | the framework adapters' own runner, for their template fixtures | minutes |
| The kits' color-mix() against core's | `node tests/color-mix/run.ts [count] [--swift \| --kotlin]` | none | seconds |
| CPU workloads, native against Node | `node tests/perf/run.ts [workload…]` | none | minutes |

`shadow/` holds measurement modes that observe a translation without changing it (`src/semantics/observers.ts`):
`node --import tests/shadow/install.ts …` installs those its environment names (`NS_CONVERSION_SHADOW`,
`NS_FORMS_SHADOW`, `NS_KEEP_SHADOW`, `NS_HELD_SHADOW`, each a JSONL file); `shadow/forms-run.ts` and
`shadow/conversion-summary.ts` run and summarize them.

A case argument (diff, fuzz) is a case's number or whole name; `<prefix>*` selects every case it begins.

## Differential cases

`diff/cases/<n>-<topic>.ts`, each one module (with `helpers/`). Node runs the case first: it must print something and
end with status 0, or with the status `// @exit <n>` declares. A case runs on both backends unless a directive says
otherwise. Directives are comment lines at the top of a case:

| Directive | Meaning |
|---|---|
| `// @swift <reason>` | Swift only; as the first line, or a line after another directive. `<reason>` is `ledger:<entry>`, a field of `src/semantics/ledger.ts` the two backends differ in, or `refused:<id>`, the refusal Kotlin gives the case (`checks/both-backends.ts`). |
| `// @kotlin <reason>` (first line) | Kotlin only, with its reason as for `@swift`. |
| `// @lenient` (first line) | Checked as core is (no `strictNullChecks`) and translated as the kit generated from core is: lenient, library mode; Swift only. `@lenient-kotlin`: Kotlin only. `@lenient-both`: both. |
| `// @app-lenient` (first line) | A non-strict app's own code (`strict: false`), on both backends. |
| `// @cli-program` | With `@app-lenient`: translated from the strictly typed program the CLI translates an app from. |
| `// @plugin` (first line) | A non-strict app whose imports from `helpers/plugin/` are a plugin's, compiled from source; Swift only. `@plugin-both`: both. |
| `// @packages [specifier=file…]` | Imports the fixture packages under `cases/helpers/plugin/packages/`, compiled as an app's plugins are; Node imports each listed specifier from the file given. |
| `// @weak-fields A.b …`, `// @weak-captures A.e …` | What the kit's configuration holds weakly. |
| `// @members-by-name` | Translated as an XML app's code is: its classes' accessors and methods readable by name. |
| `// @xml-keys k …` | Translated as an XML app with no run-time XML site: members read by name only by these keys and those its code names; `helpers/xml-*.ts` modules are the code generated from the XML. |
| `// @assign-fields` | Class fields assigned in the constructor, not defined (an app targeting below ES2022). |
| `// @experimental-decorators` | Node's run compiles the case with `experimentalDecorators`, as the translator reads every case. |
| `// @keep-going <text>` | Translated as `--keep-going --all-errors` builds an app: every error contains `<text>`, and what was written compiles and prints what Node does. |
| `// @exit <n>` | The status the case ends with, natively as under Node. |
| `// @uncaught` | The case ends on an uncaught error: the native run's stderr holds the error's `Name: message` line as Node prints it. |
| `// @refused <text>` | Translation must fail with a message containing `<text>`; nothing runs. `// @refused-swift <text>`, `// @refused-kotlin <text>`: on that backend only, the other runs the case. |
| `// @<tag>` | Node imports a module the suite's `suite.json` ports (`nodePorts`) from the port the adapter ships. |
| `// wtfjs: <heading>` (a line's end) | The line holds the wtfjs example with that heading (several joined by ` \| `); see `diff/WTFJS.md`. |

### The suite today

What a passing `node tests/diff/run.ts` gives at this commit: the run fails on any other outcome, so the table holds at
every commit where CI's differential steps pass. It is generated from the cases' directives and
`diff/known-failures.json` (`node tests/checks/docs.ts --write`).

<!-- generated: diff-suite -->
990 cases in `tests/diff/cases`.

| Backend | Runs | Of them on this backend only | Refused, as the case declares | Known failures | Match Node |
|---|---:|---:|---:|---:|---:|
| Swift | 979 | 65 | 44 | 7 | 928 |
| Kotlin | 925 | 11 | 39 | 3 | 883 |
<!-- /generated -->

`diff/known-failures.json` lists, per backend, the cases that do not match Node yet. Each entry has its `owner` (Swift
translator, Kotlin translator, Swift runtime, Kotlin runtime), its `cause` and its `signature`: text the failure's
one-line description holds, an error's text or `line <n>: node … native …`, the first line printed otherwise. A known
failure that fails otherwise, or matches Node, fails the run. Refusals are not failures: a case that is refused declares
it with `@refused`.

### wtfjs

The examples of [wtfjs](https://github.com/denysdovhan/wtfjs) at commit `a2c83226a15890004758971264211f116fff367a` are
held by diff cases, each line tagged with its example's heading (`// wtfjs: <heading>`). An example that needs a
refused construct is in a case of its own, so the refusal does not hide the other examples, and where the catalog has a
rewrite for it, the rewrite runs too (cases 1580-1582). `node tests/diff/wtfjs.ts` writes [diff/WTFJS.md](diff/WTFJS.md) from the tags and
`known-failures.json`; `--check` (CI) fails when it is stale, and `--results <file>` compares it with a real run's
outcomes (`node tests/diff/run.ts --json <file>`).

### test262

[test262/README.md](test262/README.md) says what is selected and why, how each test is adapted, and how to run and
reproduce the results; its results table is generated by the run, with the test262 and compiler commits it was
measured at.

## Fuzz baseline

`fuzz/known-fuzz-failures.json` summarizes each backend's full list of known fuzz failures (how many, a digest of their
keys, how many per cluster) and lists those among the variants the per-merge set draws, which is all a per-merge run
reads. The full lists are kept outside git, in the build cache (`fuzz/baseline.ts`). `node tests/fuzz/run.ts --set nightly
--update-baseline` writes them and the summary again; a nightly run without them passes only when it fails on exactly
the variants the summary names, and then writes them. A whole nightly run of a backend also records in its summary how
many variants it ran and compared with Node (`run`), the number its known failures (`variants`) are a share of: at
compiler `b178a7d98`, Swift 50,374 of 85,193 (59.1%) and Kotlin 48,031 of 75,815 (63.4%), by cluster in the file. Every
variant puts a value where the types say it cannot be, so the share measures how far a program that lies to the checker
departs from Node, not how often typed code does.
