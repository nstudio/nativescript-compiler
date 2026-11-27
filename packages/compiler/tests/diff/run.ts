#!/usr/bin/env node
// Differential tests: each case of the suite's diff/cases (tests/suite.ts: these, or $NS_TEST_SUITE's) runs under Node and, translated,
// as a native program: Swift as a macOS command-line program linking the
// kit's JavaScript runtime (Foundation only), and Kotlin on the host JVM
// with kit-android's runtime (plain JVM). Output and exit status must match.
// Node's run is the reference only when it prints something and ends with 0, or with the status a `// @exit <n>` line declares.
//   node tests/diff/run.ts [case…] [--swift | --kotlin] [--keep] [--osize] [--no-cache] [--json <file>]
// A case argument is a case's number or whole name, or `<prefix>*` for every case it begins.
// --json writes each run's result (pass, refused, known, fail) and, for a refusal, its id (src/semantics/refusals.ts).
// A case whose build inputs (its emitted program, the runtime, flags, toolchain and host) are a stored run's reuses that
// run's outcome from tests/build-cache.ts's cache, and Node's output is reused for unchanged JavaScript. --no-cache builds
// and runs every case and stores the outcomes; --keep does too, leaving every case's build products.
// --osize builds the Swift runtime and cases with -Osize, the optimizer release builds use (into <build>-osize).
// Build products go to $NS_DIFF_BUILD (default: <tmp>/ns-compiled-diff).
// Node runs with --expose-gc: a case checking object lifetimes calls `globalThis.gc?.()`, which ARC needs no call for.
// Kotlin compiles with $KOTLINC, `kotlinc` on PATH, or the compiler Gradle cached for kit-android.
import { spawnSync } from 'node:child_process';
import { BuildCache, cacheRoot, failedBuild, hash, hashDir, hashFiles, host, kotlinCompiler, javaRuntime, nodeRuntime, outcomeOf, Placeholders, swiftToolchain, type Outcome } from '../build-cache.ts';
import { caseModules, kotlinRuntimeSources, nodeImportRoot, root, runtimeSources, SWIFT_MODE } from '../native-build.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { diffCases, knownFailuresFile, suiteDir } from '../suite.ts';
import { expectedExit, kotlinApp, kotlinOnly, kotlinOptions, nodeImports, packagesOf, refusalId, refusedWith, selected, swiftOnly, swiftOptions, uncaught } from './case-options.ts';
import { buildKotlinRuntime, buildSwiftRuntime, kotlinc, kotlinMain, kotlinStdlib, swiftc, swiftMain, translateKotlin as translateKotlinProgram, translateSwift } from '../native-build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const optimize = process.argv.includes('--osize') ? '-Osize' : '-Onone';
const build = (process.env.NS_DIFF_BUILD ?? join(tmpdir(), 'ns-compiled-diff')) + (optimize === '-Osize' ? '-osize' : '');
const argv = process.argv.slice(2);
const jsonFile = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : undefined;
const shardArg = argv.includes('--shard') ? argv[argv.indexOf('--shard') + 1] : undefined;
const shard = (() => {
  if (!shardArg) return null;
  const m = /^(\d+)\/(\d+)$/.exec(shardArg);
  if (!m) throw new Error(`invalid --shard ${shardArg}: expected <index>/<total> (1-based)`);
  const index = Number(m[1]), total = Number(m[2]);
  if (index < 1 || index > total) throw new Error(`invalid --shard ${shardArg}: index must be 1..${total}`);
  return { index, total };
})();
const args = argv.filter((a, k) => !a.startsWith('--') && argv[k - 1] !== '--json' && argv[k - 1] !== '--shard');
const keep = process.argv.includes('--keep');
// Emitted programs name their cases' files (Swift's #sourceLocation) and build folder: as placeholders in keys and entries, one checkout's entries serve another's.
const places = new Placeholders({ BUILD: build, ROOT: root, SUITE: suiteDir });
const local = (text: string) => places.encode(text);
const caches: BuildCache[] = [];
const cacheFor = (backend: string) => { const c = new BuildCache(backend, { read: !keep && !process.argv.includes('--no-cache'), places }); caches.push(c); return c; };
/** How the cases are built and run, checked, and their outcomes stored. */
const harness = hashFiles([fileURLToPath(import.meta.url), join(here, 'case-options.ts'), join(root, 'tests/native-build.ts'), join(root, 'tests/kotlin-toolchain.ts'), join(root, 'tests/build-cache.ts'), join(root, 'tests/suite.ts')], local);
const targets = process.argv.includes('--swift') ? ['swift'] : process.argv.includes('--kotlin') ? ['kotlin'] : ['swift', 'kotlin'];
mkdirSync(build, { recursive: true });
const packageModules = caseModules(build);
const modulesOf = (file: string) => (packagesOf(file) ? { modules: packageModules } : {});

function translate(file: string, out: string): void {
  const modules = translateSwift([file], out, { ...swiftOptions(file), ...modulesOf(file) });
  writeFileSync(join(out, 'main.swift'), swiftMain(modules));
}

/** The case as Kotlin in package `pkg`, with a `main` running its modules' top level and then the event loop. */
function translateKotlin(file: string, out: string, pkg: string): void {
  const modules = translateKotlinProgram([file], out, pkg, { ...kotlinOptions(file), ...modulesOf(file) });
  writeFileSync(join(out, '__Main.kt'), kotlinMain(modules, pkg));
}

/** The case as JavaScript for Node, the way an app's bundler compiles TypeScript (Node strips types but cannot transform parameter properties or enums). */
function toJavaScript(dir: string, out: string) {
  nodeImportRoot(out, packageModules);
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    if (!f.endsWith('.ts')) continue;
    const text = nodeImports(join(dir, f), readFileSync(join(dir, f), 'utf8'), f.split('/').length - 1);
    // A lenient case runs as core is built: class fields assigned, not defined (a declared field leaves the prototype's accessor visible).
    const { outputText } = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true, ...(text.startsWith('// @lenient') || /^\/\/ @assign-fields$/m.test(text) ? { useDefineForClassFields: false } : {}), ...(/^\/\/ @experimental-decorators$/m.test(text) ? { experimentalDecorators: true, useDefineForClassFields: false } : {}) } });
    mkdirSync(dirname(join(out, f)), { recursive: true });
    writeFileSync(join(out, f.replace(/\.ts$/, '.js')), outputText);
  }
}

// ---- Run ---------------------------------------------------------------------------------------

const allCases = selected(args, readdirSync(diffCases).filter((f) => f.endsWith('.ts')).map((f) => basename(f, '.ts'))).map((n) => `${n}.ts`).sort();
const cases = shard ? allCases.filter((_, k) => k % shard.total === shard.index - 1) : allCases;
const js = join(build, 'js');
rmSync(js, { recursive: true, force: true });
toJavaScript(diffCases, js);

/** The JavaScript files Node loads for `entry`: it and its relative imports, transitively. Null when it imports a package, which the key would not cover. */
function jsProgram(entry: string): string[] | null {
  const files = new Set([entry]);
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const { fileName } of ts.preProcessFile(readFileSync(f, 'utf8'), true, true).importedFiles) {
      if (fileName.startsWith('.')) files.add(resolve(dirname(f), fileName));
      else if (!fileName.startsWith('node:')) return null;
    }
  }
  return [...files].sort();
}

const nodeCache = cacheFor('node');
const shim = join(here, 'native-shim.js');
const nodeBase = hash('node', nodeRuntime(), host(), readFileSync(shim), harness);
const expected = new Map(cases.map((c): [string, Outcome] => {
  const entry = join(js, basename(c, '.ts') + '.js');
  const program = jsProgram(entry);
  const key = program && hash(nodeBase, ...program.flatMap((f) => [relative(js, f), existsSync(f) ? local(readFileSync(f, 'utf8')) : '']));
  const hit = key ? nodeCache.get(key) : null;
  if (hit) return [c, hit];
  const outcome = outcomeOf(spawnSync('node', ['--expose-gc', '--import', shim, entry], { encoding: 'utf8' }));
  if (key) nodeCache.put(key, outcome);
  return [c, outcome];
}));
let failed = 0;
/**
 * Cases known to fail on a target (the suite's diff/known-failures.json), each with its cause, its owner and its
 * signature: text the failure's one-line description holds (an error's text, or `line <n>: node … native …` for the
 * first line printed otherwise). A known failure is reported and not counted. One that fails otherwise than its signature
 * says fails the run, as does one that matches Node, so the list only shrinks. An entry that is only a string is a cause
 * with no signature.
 */
interface Known { cause: string; owner?: string; signature?: string }
const knownFile = JSON.parse(readFileSync(knownFailuresFile, 'utf8'));
const knownOf = (list: Record<string, string | Known> = {}): Record<string, Known> =>
  Object.fromEntries(Object.entries(list).map(([n, k]) => [n, typeof k === 'string' ? { cause: k } : k]));
const known: Record<string, Record<string, Known>> = { swift: knownOf(knownFile.swift), kotlin: knownOf(knownFile.kotlin) };
const knownFailed: string[] = [];
const failing = new Set<string>();
const ran = new Set<string>();
const results: Record<string, Record<string, { result: 'pass' | 'refused' | 'known' | 'fail'; detail?: string; refusal?: string }>> = { swift: {}, kotlin: {} };
/** Counts a failed run described by `text`, and returns how its report line marks it. */
function fail(name: string, target: string, text: string): string {
  const k = known[target]?.[name];
  failing.add(`${target}:${name}`);
  if (k && (!k.signature || text.includes(k.signature))) {
    knownFailed.push(`${name} (${target})`);
    results[target][name] = { result: 'known', detail: text };
    return ' [known]';
  }
  failed++;
  results[target][name] = { result: 'fail', detail: text };
  return k ? ` [known as ${JSON.stringify(k.signature)}, failing otherwise]` : '';
}
const pass = (name: string, target: string, refusal?: string) => (results[target][name] = { result: refusal === undefined ? 'pass' : 'refused', ...(refusal ? { refusal } : {}) });
const firstLine = (text: string) => text.split('\n').find((l) => l.trim()) ?? '';
/** The line naming an uncaught error in what a run printed to stderr, as Node prints it: `RangeError: 2 is too many`. */
const errorLine = (stderr: string) => stderr.split('\n').find((l) => /^\w*(Error|Exception)\b/.test(l));

/** How a native run differs from Node's: its first line printed otherwise, its exit status, or the uncaught error it reports. */
function difference(name: string, want: Outcome, actual: Outcome): string | null {
  const e = want.stdout.split('\n'), a = actual.stdout.split('\n');
  for (let k = 0; k < Math.max(e.length, a.length); k++) if (e[k] !== a[k]) return `line ${k + 1}: node ${JSON.stringify(e[k])} native ${JSON.stringify(a[k])}`;
  if (actual.status !== want.status) return `exit ${want.status} in Node, ${actual.status ?? actual.signal} native`;
  const thrown = uncaught(join(diffCases, name + '.ts')) && errorLine(want.stderr);
  if (thrown && !actual.stderr.includes(thrown)) return `stderr has no ${JSON.stringify(thrown)}`;
  return null;
}

function report(name: string, target: string, want: Outcome, actual: Outcome) {
  ran.add(`${target}:${name}`);
  const why = difference(name, want, actual);
  if (!why) { console.log(`✓ ${name} (${target})`); pass(name, target); return true; }
  console.log(`✗ ${name} (${target})${fail(name, target, why)}: output differs (exit ${want.status} in Node, ${actual.status} native): ${why}`);
  const e = want.stdout.split('\n'), a = actual.stdout.split('\n');
  for (let k = 0, shown = 0; k < Math.max(e.length, a.length) && shown < 8; k++) {
    if (e[k] !== a[k]) { console.log(`    line ${k + 1}\n      node:   ${JSON.stringify(e[k])}\n      native: ${JSON.stringify(a[k])}`); shown++; }
  }
  if (actual.stderr) console.log('    native stderr: ' + actual.stderr.split('\n').slice(0, 4).join('\n    '));
  return false;
}

/** Why Node's run of a case is no reference to compare with: it ended with a status the case does not declare, or printed nothing. */
function unusable(name: string, want: Outcome): string | null {
  const exit = expectedExit(join(diffCases, name + '.ts'));
  const lines = want.stderr.trim().split('\n');
  const stderr = lines.find((l) => /^\w*(Error|Exception)\b/.test(l)) ?? lines[0];
  if (want.status !== exit) return `Node's run exits ${want.status ?? want.signal}${exit ? ` where the case declares ${exit}` : ''} (a case ending otherwise declares \`// @exit <n>\`)${stderr ? `: ${stderr}` : ''}`;
  if (!want.stdout) return "Node's run prints nothing";
  return null;
}

/**
 * Reports a case's native outcome: `hit`, the stored one, or else what `make` builds and runs. A new outcome is stored
 * when it matches Node or the case is a known failure. One that newly differs is not, so it is built and run again
 * next time: a flaky failure never sticks.
 */
function settle(cache: BuildCache, key: string, hit: Outcome | null, name: string, target: string, want: Outcome, make: () => Outcome) {
  const why = unusable(name, want);
  if (why) {
    ran.add(`${target}:${name}`);
    console.log(`✗ ${name} (${target})${fail(name, target, `node: ${why}`)}: ${why}`);
    return;
  }
  const outcome = hit ?? make();
  let matches = false;
  if (outcome.error === undefined) matches = report(name, target, want, outcome);
  else {
    ran.add(`${target}:${name}`);
    const lines = outcome.error.split('\n');
    console.log(`✗ ${name} (${target})${fail(name, target, `${lines[0]} ${firstLine(lines.slice(1).join('\n'))}`)}: ${outcome.error}`);
  }
  if (!hit && (matches || known[target]?.[name])) cache.put(key, outcome);
}

/** A `// @refused` case: its translation must fail, saying what the case declares. */
function refusal(name: string, target: 'swift' | 'kotlin', file: string, translate: () => void) {
  ran.add(`${target}:${name}`);
  const want = refusedWith(file, target)!;
  let message = '', id: string | undefined;
  try { translate(); } catch (err) { message = (err as Error).message; id = refusalId(err as Error); }
  if (message.includes(want)) { console.log(`✓ ${name} (${target}) refused${id ? ` [${id}]` : ''}`); pass(name, target, id ?? ''); return; }
  const why = `${message ? `refused otherwise: ${firstLine(message)}` : 'translated'} where the case declares a refusal containing ${JSON.stringify(want)}`;
  console.log(`✗ ${name} (${target})${fail(name, target, why)}: ${why}`);
}

let swiftSkipped = 0;
if (targets.includes('swift')) {
  const cache = cacheFor('swift');
  const base = hash('swift', swiftToolchain(), host(), hashFiles(runtimeSources, local), optimize, ...SWIFT_MODE, harness);
  let runtimeBuilt = false;
  for (const c of cases) {
    const name = basename(c, '.ts');
    const file = join(diffCases, c);
    if (kotlinOnly(file) || kotlinApp(file)) { swiftSkipped++; continue; }
    const dir = join(build, name);
    if (refusedWith(file, 'swift')) { refusal(name, 'swift', file, () => translate(file, join(dir, 'Sources'))); rmSync(dir, { recursive: true, force: true }); continue; }
    try {
      translate(file, join(dir, 'Sources'));
    } catch (err) {
      ran.add(`swift:${name}`);
      console.log(`✗ ${name} (swift)${fail(name, 'swift', `translate: ${firstLine((err as Error).message)}`)}: ${(err as Error).message}${process.env.NS_COMPILED_STACKS ? (err as Error).stack : ""}`);
      if (!keep) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const key = hash(base, local(JSON.stringify(swiftOptions(file))), hashDir(join(dir, 'Sources'), local));
    settle(cache, key, cache.get(key), name, 'swift', expected.get(c)!, () => {
      if (!runtimeBuilt) { buildSwiftRuntime(build, optimize); runtimeBuilt = true; }
      const swiftFiles = readdirSync(join(dir, 'Sources')).map((f) => join(dir, 'Sources', f));
      const warnings: string[] = [];
      const errors = swiftc(swiftFiles, join(dir, name), build, optimize, [], warnings);
      if (errors) return failedBuild(`swiftc:\n${errors.slice(0, 15).join('\n')}`);
      // Isolation and sendability are checked as an app's code is: a warning there fails the case.
      const concurrency = warnings.filter((w) => /Sendable|actor|isolat|data race|concurrently/i.test(w));
      if (concurrency.length) return failedBuild(`swiftc concurrency warnings:\n${concurrency.slice(0, 15).join('\n')}`);
      return outcomeOf(spawnSync(join(dir, name), { encoding: 'utf8', timeout: 20000 }));
    });
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

let kotlinSkipped = 0;
if (targets.includes('kotlin')) {
  const pkg = (name: string) => 'case_' + name.replace(/\W/g, '_');
  const translated: string[] = [];
  for (const c of cases) {
    const name = basename(c, '.ts');
    if (swiftOnly(join(diffCases, c))) { kotlinSkipped++; continue; }
    if (refusedWith(join(diffCases, c), 'kotlin')) { refusal(name, 'kotlin', join(diffCases, c), () => translateKotlin(join(diffCases, c), join(build, 'kotlin', name), pkg(name))); continue; }
    try {
      translateKotlin(join(diffCases, c), join(build, 'kotlin', name), pkg(name));
      translated.push(name);
    } catch (err) {
      ran.add(`kotlin:${name}`);
      console.log(`✗ ${name} (kotlin)${fail(name, 'kotlin', `translate: ${firstLine((err as Error).message)}`)}: ${(err as Error).message}`);
    }
  }
  const cache = cacheFor('kotlin');
  const base = hash('kotlin', kotlinCompiler(), javaRuntime(), host(), hashFiles(kotlinRuntimeSources, local), harness);
  const keys = new Map(translated.map((name) => [name, hash(base, local(JSON.stringify(kotlinOptions(join(diffCases, name + '.ts')))), hashDir(join(build, 'kotlin', name), local))]));
  const hits = new Map<string, Outcome>();
  for (const name of translated) { const hit = cache.get(keys.get(name)!); if (hit) hits.set(name, hit); }
  const misses = translated.filter((name) => !hits.has(name));
  const runtime = misses.length ? buildKotlinRuntime(build) : '';
  const sourcesOf = (name: string) => readdirSync(join(build, 'kotlin', name)).map((f) => join(build, 'kotlin', name, f));
  const classes = join(build, 'kotlin-classes');
  // One compile for every case. The cases a failed compile's errors are reported in leave it, and the rest compile
  // together again; each case that left is compiled alone, for its own outcome. An error in no case's sources (the
  // compiler's own) leaves every case to compile alone.
  let together = misses;
  const alone: string[] = [];
  while (together.length) {
    const e = kotlinc(together.flatMap(sourcesOf), classes, [runtime]);
    if (!e) break;
    const broken = together.filter((name) => e.some((l) => l.startsWith(join(build, 'kotlin', name) + sep)));
    alone.push(...(broken.length ? broken : together));
    together = broken.length ? together.filter((name) => !broken.includes(name)) : [];
  }
  const runnable = new Map<string, string>();
  const errors = new Map<string, string>();
  for (const name of together) runnable.set(name, classes);
  for (const name of alone) {
    const out = join(build, 'kotlin-classes-' + name);
    const e = kotlinc(sourcesOf(name), out, [runtime]);
    if (e) errors.set(name, `kotlinc:\n${e.slice(0, 15).join('\n')}`); else runnable.set(name, out);
  }
  const settleKotlin = (name: string, make: () => Outcome) => settle(cache, keys.get(name)!, hits.get(name) ?? null, name, 'kotlin', expected.get(name + '.ts')!, make);
  // Build errors before runs, as each case's own build and run would report them.
  for (const name of translated) if (hits.get(name)?.error !== undefined || errors.has(name)) settleKotlin(name, () => failedBuild(errors.get(name)!));
  for (const name of translated) {
    const out = runnable.get(name);
    if (!out && (!hits.has(name) || hits.get(name)!.error !== undefined)) continue;
    settleKotlin(name, () => outcomeOf(spawnSync('java', ['-Xss16m', '-cp', [out!, runtime, kotlinStdlib()].join(':'), `${pkg(name)}.entry.__MainKt`], { encoding: 'utf8', timeout: 30000 })));
  }
  if (!keep) for (const d of readdirSync(build)) if (d.startsWith('kotlin-classes') || d === 'kotlin') rmSync(join(build, d), { recursive: true, force: true });
}

const total = cases.length * targets.length - kotlinSkipped - swiftSkipped;
const caseNames = new Set(cases.map((c) => basename(c, '.ts')));
const nowPassing = targets.flatMap((t) => Object.keys(known[t] ?? {}).filter((n) => caseNames.has(n) && ran.has(`${t}:${n}`) && !failing.has(`${t}:${n}`)).map((n) => `${n} (${t})`));
for (const n of nowPassing) console.log(`✗ ${n} matches Node: remove it from ${knownFailuresFile}`);
failed += nowPassing.length;
if (knownFailed.length) console.log(`${knownFailed.length} known failures (${knownFailuresFile}): ${knownFailed.join(', ')}`);
console.log(`cache (${cacheRoot}): ${caches.map((c) => c.summary()).join(', ')}`);
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(Object.fromEntries(targets.map((t) => [t, results[t]])), null, 1) + '\n');
console.log(`${total - failed - knownFailed.length + nowPassing.length} of ${total} runs match Node (${targets.join(', ')})`);
process.exit(failed ? 1 : 0);
