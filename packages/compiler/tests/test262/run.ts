#!/usr/bin/env node
// test262 conformance of the JavaScript the compiler emits: a curated subset of tc39/test262
// (tests.txt) translated as an app's modules are and run on the host, Swift as macOS executables
// linking the kit's runtime and Kotlin on the JVM with kit-android's runtime (tests/native-build.ts).
//   node tests/test262/run.ts [--swift | --kotlin] [--only <text>…] [--area <name>…] [--batch <n>] [--jobs <n>] [--update-baseline] [--keep] [--list | --report [--readme]]
// test262 is fetched at COMMIT into $NS_TEST262_CACHE (default ~/.cache/ns-test262); build products go to
// $NS_TEST262_BUILD (default <tmp>/ns-test262), with results-<backend>.json and summary.md.
// The run fails only on a regression against baseline.json: a test not listed there that does not pass.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildKotlinRuntime, buildSwiftRuntime, kotlinc, kotlinStdlib, swiftc, translateKotlin, translateSwift, SWIFT_HEADER } from '../native-build.ts';
import { COLUMNS, columnOf, WRONG_OUTPUT_KINDS, wrongOutputKind, type Column } from './columns.ts';

/** tc39/test262 main as of 2026-10-14. */
const COMMIT = 'd53ebc8b1931d9f1541e43d59650776e4b766248';

const here = dirname(fileURLToPath(import.meta.url));
const cache = process.env.NS_TEST262_CACHE ?? join(homedir(), '.cache/ns-test262');
const build = process.env.NS_TEST262_BUILD ?? join(tmpdir(), 'ns-test262');
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const values = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const backends = (flag('--swift') ? ['swift'] : flag('--kotlin') ? ['kotlin'] : ['swift', 'kotlin']) as Backend[];
const only = values('--only');
const areas = values('--area');
const batchSize = Number(values('--batch')[0] ?? 250);
const jobs = Number(values('--jobs')[0] ?? Math.max(2, availableParallelism() - 2));
const keep = flag('--keep');
const optimize = '-Onone';
/** The free disk space each batch needs to start, in GB. */
const minFree = Number(process.env.NS_TEST262_MIN_FREE_GB ?? 8);
// Every diagnostic, so that each test the type check refuses is told apart from the rest of its batch.
process.env.NS_COMPILED_DIAGNOSTICS = '1000000';

type Backend = 'swift' | 'kotlin';
type Status = 'pass' | 'fail' | 'refused' | 'out-of-scope' | 'unported' | 'invalid';

interface Test {
  /** The path under test262's test/, as tests.txt names it. */
  id: string;
  area: string;
  /** The module the adapted test is, in its batch. */
  module: string;
  source: string;
  meta: Meta;
  /** Why the test is not run, when it is not. */
  skip?: { status: Status; detail: string };
  adapted?: string;
  /** The adapted test with each typed array constructor cast to `any`, for a test the type check rejects as adapted. */
  generic?: string;
}

interface Meta { includes: string[]; flags: string[]; features: string[]; negative: { phase: string; type: string } | null }
interface Result { status: Status; detail?: string }

// ---- test262 ------------------------------------------------------------------------------------

/**
 * The tests tests.txt selects, by area: `[Area]` starts one, a path under test/ (a directory or a file) adds its tests,
 * `!path` takes them out. `self/` is the harness's own checks (self/), which must pass for a backend's results to hold.
 */
function selection(): { included: { path: string; area: string }[]; excluded: string[] } {
  const lines = readFileSync(join(here, 'tests.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const included: { path: string; area: string }[] = [];
  const excluded: string[] = [];
  let area = '';
  for (const l of lines) {
    const section = /^\[(.+)\]$/.exec(l);
    if (section) area = section[1];
    else if (l.startsWith('!')) excluded.push(l.slice(1).trim());
    else included.push({ path: l, area });
  }
  return { included, excluded };
}

function test262(entries: string[]): string {
  const dir = join(cache, `test262-${COMMIT}`);
  const tarball = join(cache, `test262-${COMMIT}.tar.gz`);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(tarball)) {
    console.log(`fetching test262 ${COMMIT.slice(0, 10)} into ${cache}`);
    const r = spawnSync('curl', ['-fsSL', `https://codeload.github.com/tc39/test262/tar.gz/${COMMIT}`, '-o', tarball + '.part'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('could not fetch test262');
    renameSync(tarball + '.part', tarball);
  }
  // Only what tests.txt names is extracted; the stamp says what has been.
  const stamp = join(dir, '.extracted');
  const extracted = new Set<string>(existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : []);
  const missing = entries.filter((e) => !extracted.has(e));
  if (missing.length) {
    const r = spawnSync('tar', ['-xzf', tarball, '-C', cache, ...missing.map((e) => `test262-${COMMIT}/test/${e}`)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tests.txt names what test262 ${COMMIT.slice(0, 10)} does not have:\n${r.stderr}`);
    writeFileSync(stamp, JSON.stringify([...extracted, ...missing].sort()));
  }
  return join(dir, 'test');
}

/** Where a tests.txt path is: test262's test/, or for `self/…` the harness's own checks beside this file. */
const baseOf = (dir: string, path: string) => (path.startsWith('self/') ? here : dir);

/** The directory a path or pattern names files under: up to its first wildcard. */
const fixedPart = (path: string) => path.split('/').filter((_, i, parts) => !parts.slice(0, i + 1).some((p) => p.includes('*'))).join('/');

/**
 * `*` matches within a path segment, `**` across segments; a pattern without one names a directory (all under it) or a
 * file. A pattern matching a directory matches what is under it.
 */
function matcher(pattern: string): (id: string) => boolean {
  if (!pattern.includes('*')) return (id) => id === pattern || id.startsWith(pattern.replace(/\/?$/, '/'));
  const re = new RegExp('^' + pattern.split(/(\*\*\/?|\*)/).map((p) => (p === '**' ? '.*' : p.startsWith('**') ? '(?:.*/)?' : p === '*' ? '[^/]*' : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
  return (id) => id.split('/').some((_, i, parts) => re.test(parts.slice(0, i + 1).join('/')));
}

function testFiles(dir: string, path: string): string[] {
  const base = fixedPart(path);
  const full = join(baseOf(dir, path), base);
  if (statSync(full).isFile()) return [path];
  const matches = matcher(path);
  return (readdirSync(full, { recursive: true }) as string[]).filter((f) => f.endsWith('.js') && !f.includes('_FIXTURE')).map((f) => join(base, f)).filter(matches).sort();
}

function metaOf(source: string): Meta {
  const yaml = /\/\*---([\s\S]*?)---\*\//.exec(source)?.[1] ?? '';
  const list = (key: string): string[] => {
    const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]`, 'm').exec(yaml);
    if (inline) return inline[1].split(',').map((s) => s.trim()).filter(Boolean);
    const block = new RegExp(`^${key}:\\s*\\n((?:[ \\t]+- .*\\n?)+)`, 'm').exec(yaml);
    return block ? block[1].split('\n').map((s) => s.replace(/^\s*- /, '').trim()).filter(Boolean) : [];
  };
  const negative = /^negative:\s*\n((?:[ \t]+\w+:.*\n?)+)/m.exec(yaml);
  const field = (k: string) => new RegExp(`${k}:\\s*(\\S+)`).exec(negative?.[1] ?? '')?.[1] ?? '';
  return { includes: list('includes'), flags: list('flags'), features: list('features'), negative: negative ? { phase: field('phase'), type: field('type') } : null };
}

// ---- What is not run ----------------------------------------------------------------------------

/** What the compiler refuses by design, by test262 feature and by what the code calls. */
const OUT_OF_SCOPE: { reason: string; features?: string[]; includes?: string[]; code?: RegExp }[] = [
  { reason: 'eval', code: /\beval\b/ },
  { reason: 'Function constructor', code: /\bnew\s+Function\s*\(|(?<![.\w$])Function\s*\(|\.constructor\s*\(\s*['"`]/ },
  { reason: 'Proxy', features: ['Proxy'], code: /\bProxy\b/ },
  // isConstructor.js asks Reflect.construct.
  { reason: 'Reflect', features: ['Reflect', 'Reflect.construct', 'Reflect.set', 'Reflect.setPrototypeOf'], includes: ['isConstructor.js'], code: /\bReflect\b/ },
  { reason: 'with', code: /(?<![.\w$])with\s*\(/ },
  { reason: 'SharedArrayBuffer', features: ['SharedArrayBuffer', 'Atomics'], code: /\bSharedArrayBuffer\b|\bAtomics\b/ },
  { reason: 'FinalizationRegistry', features: ['FinalizationRegistry'], code: /\bFinalizationRegistry\b/ },
  { reason: 'computed import/require', features: ['dynamic-import', 'import-defer', 'source-phase-imports'], code: /\bimport\s*\(|\brequire\s*\(/ },
];

/**
 * test262 features that the compiler's TypeScript target (ES2022 syntax, the ES2023 library with ES2024's groupBy and
 * withResolvers: `lib` in src/program/program.ts) does not declare, so an app's type check rejects them before translation.
 */
const BEYOND_TARGET = new Set([
  'Temporal', 'Intl.Era-monthcode', 'canonical-tz', 'Intl.DurationFormat', 'Intl.Locale-info',
  'resizable-arraybuffer', 'arraybuffer-transfer', 'immutable-arraybuffer', 'Float16Array',
  'iterator-helpers', 'Iterator.prototype.join', 'iterator-includes', 'iterator-chunking', 'iterator-sequencing', 'joint-iteration',
  'set-methods', 'upsert', 'Array.fromAsync', 'await-dictionary', 'promise-try', 'Math.sumPrecise', 'json-parse-with-source',
  'String.prototype.isWellFormed', 'String.prototype.toWellFormed', 'explicit-resource-management', 'decorators',
  'regexp-v-flag', 'regexp-modifiers', 'regexp-duplicate-named-groups', 'RegExp.escape', 'Error.isError',
]);
/** Globals of BEYOND_TARGET's features that some tests use without listing the feature. */
const BEYOND_TARGET_CODE = /\bError\.isError\b|\bIntl\.DurationFormat\b|\bSuppressedError\b|\bFloat16Array\b/;

/**
 * What does not apply to compiled code, whatever the compiler did: sloppy-mode-only tests (an app's modules are
 * strict), early errors (TypeScript's parser rejects the source before the compiler sees it), the host hooks of $262
 * (realms, agents, detaching), module tests' fixtures, and features the target library does not declare.
 */
const NOT_APPLICABLE: { reason: string; test: (meta: Meta, code: string) => boolean }[] = [
  { reason: 'sloppy mode only', test: (m) => m.flags.includes('noStrict') || m.flags.includes('raw') },
  { reason: 'early error', test: (m) => !!m.negative && m.negative.phase !== 'runtime' },
  { reason: 'host hooks ($262)', test: (m, code) => /\$262\b/.test(code) || m.features.includes('cross-realm') || m.includes.includes('detachArrayBuffer.js') },
  { reason: 'module fixtures', test: (m) => m.flags.includes('module') || m.flags.includes('CanBlockIsTrue') || m.flags.includes('CanBlockIsFalse') },
  { reason: 'not in the target library', test: (m, code) => m.features.some((f) => BEYOND_TARGET.has(f)) || BEYOND_TARGET_CODE.test(code) },
];

/** test262's code without its comments, for what it calls; the source as it is where TypeScript's emit fails on it. */
function codeOf(source: string): string {
  try {
    return ts.transpileModule(source, { compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext } }).outputText;
  } catch {
    return source;
  }
}

// ---- Harness ------------------------------------------------------------------------------------

/**
 * test262's harness includes as typed modules (harness/), with the names each defines.
 * assert.js and sta.js are every test's; doneprintHandle.js every async test's.
 */
const INCLUDES: Record<string, { module: string; names: string[] }[]> = {
  'assert.js': [{ module: 'assert', names: ['assert', 'compareArray', 'formatIdentityFreeValue', 'formatSimpleValue', 'isNegativeZero', 'isPrimitive'] }],
  'sta.js': [{ module: 'sta', names: ['Test262Error', '$DONOTEVALUATE'] }],
  'doneprintHandle.js': [{ module: 'doneprintHandle', names: ['$DONE'] }],
  'compareArray.js': [],
  'compareIterator.js': [],
  'asyncHelpers.js': [{ module: 'asyncHelpers', names: ['asyncTest'] }],
  'promiseHelper.js': [{ module: 'promiseHelper', names: ['checkSequence', 'checkSettledPromises'] }],
  'propertyHelper.js': [{ module: 'propertyHelper', names: ['verifyProperty', 'verifyPrimordialProperty', 'verifyEqualTo', 'verifyWritable', 'verifyNotWritable', 'verifyEnumerable', 'verifyNotEnumerable', 'verifyConfigurable', 'verifyNotConfigurable'] }],
  'tcoHelper.js': [{ module: 'misc', names: ['$MAX_ITERATIONS'] }],
  'dateConstants.js': [{ module: 'misc', names: ['date_1899_end', 'date_1900_start', 'date_1969_end', 'date_1970_start', 'date_1999_end', 'date_2000_start', 'date_2099_end', 'date_2100_start', 'start_of_time', 'end_of_time'] }],
  'assertRelativeDateMs.js': [{ module: 'misc', names: ['assertRelativeDateMs'] }],
  'decimalToHexString.js': [{ module: 'misc', names: ['decimalToHexString', 'decimalToPercentHexString'] }],
  'nans.js': [{ module: 'misc', names: ['NaNs'] }],
  'byteConversionValues.js': [{ module: 'byteConversionValues', names: ['byteConversionValues'] }],
  'testTypedArray.js': [{ module: 'testTypedArray', names: ['testTypedArrayCases', 'testTypedArrayConversionCases'] }],
};
const HARNESS_MODULES = [...new Set(Object.values(INCLUDES).flat().map((i) => i.module))];
/** What propertyHelper.js defines that harness/propertyHelper.ts does not port. */
const UNPORTED_NAMES = ['verifyCallableProperty', 'verifyAccessorProperty', 'verifyPrimordialCallableProperty', 'verifyPrimordialAccessorProperty'];

/**
 * The test as a module of the app: test262's source after an import of each harness name it uses from the include
 * that defines it, with `assert(…)` calls made `assert.ok(…)` and `assert.throws(TypeError, …)` given the constructor's name. A test is a script to test262; as a module it is
 * strict, which the tests not marked noStrict are written for.
 */
function adapt(t: Test, code: string, generic = false): string | { unported: string } {
  const includes = ['assert.js', 'sta.js', ...(t.meta.flags.includes('async') ? ['doneprintHandle.js'] : []), ...t.meta.includes];
  const unported = includes.find((i) => !INCLUDES[i]);
  if (unported) return { unported };
  const unportedName = t.meta.includes.includes('propertyHelper.js') && UNPORTED_NAMES.find((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(code));
  if (unportedName) return { unported: `propertyHelper.js ${unportedName}` };
  let source = assertCalls(t);
  if (t.meta.includes.includes('testTypedArray.js')) {
    const cases = typedArrayCases(t.id, source, generic);
    if (typeof cases !== 'string') return cases;
    source = cases;
    code = codeOf(source);
  }
  const byModule = new Map<string, string[]>();
  for (const i of new Set(includes)) for (const { module, names } of INCLUDES[i]) {
    for (const n of names) {
      const word = n.replace(/\$/g, '\\$');
      const used = new RegExp(`(?<![\\w$.])${word}(?![\\w$])`).test(code);
      const declared = new RegExp(`\\b(function\\*?|var|let|const|class)\\s+${word}(?![\\w$])`).test(code);
      if (used && !declared) byModule.set(module, [...(byModule.get(module) ?? []), n]);
    }
  }
  const imports = [...byModule].map(([m, names]) => `import { ${[...new Set(names)].join(', ')} } from './harness/${m}.ts';`).join(' ');
  // On the test's first line, so its line numbers stay test262's.
  return `${imports} export {};${source}`;
}

const FLOAT_ARRAYS = ['Float64Array', 'Float32Array'];
const NON_CLAMPED_INT_ARRAYS = ['Int32Array', 'Int16Array', 'Int8Array', 'Uint32Array', 'Uint16Array', 'Uint8Array'];
const TYPED_ARRAYS = [...FLOAT_ARRAYS, ...NON_CLAMPED_INT_ARRAYS, 'Uint8ClampedArray'];
const BIGINT_ARRAYS = ['BigInt64Array', 'BigUint64Array'];
/** testTypedArray.js's lists of constructors. */
const TYPED_ARRAY_LISTS: Record<string, string[]> = {
  floatArrayConstructors: FLOAT_ARRAYS,
  nonClampedIntArrayConstructors: NON_CLAMPED_INT_ARRAYS,
  intArrayConstructors: [...NON_CLAMPED_INT_ARRAYS, 'Uint8ClampedArray'],
  typedArrayConstructors: TYPED_ARRAYS,
  nonAtomicsFriendlyTypedArrayConstructors: [...FLOAT_ARRAYS, 'Uint8ClampedArray'],
};
/** testTypedArray.js's runners: the constructors each runs a test with, and whether a list of them is its second argument. */
const TYPED_ARRAY_RUNNERS: Record<string, { ctors: string[]; list: boolean }> = {
  testWithTypedArrayConstructors: { ctors: TYPED_ARRAYS, list: true },
  testWithAllTypedArrayConstructors: { ctors: [...TYPED_ARRAYS, ...BIGINT_ARRAYS], list: true },
  testWithBigIntTypedArrayConstructors: { ctors: BIGINT_ARRAYS, list: true },
  testWithNonAtomicsFriendlyTypedArrayConstructors: { ctors: TYPED_ARRAY_LISTS.nonAtomicsFriendlyTypedArrayConstructors, list: false },
  testWithAtomicsFriendlyTypedArrayConstructors: { ctors: NON_CLAMPED_INT_ARRAYS, list: false },
};
/** What testTypedArray.js defines that holds a constructor as a value, which only a call run.ts expands may use. */
const TYPED_ARRAY_VALUES = [...Object.keys(TYPED_ARRAY_RUNNERS), ...Object.keys(TYPED_ARRAY_LISTS), 'testTypedArrayConversions', 'TypedArray', 'isFloatTypedArrayConstructor', 'floatTypedArrayConstructorPrecision'];

/**
 * The test with each call of a testTypedArray.js runner made a list of cases, one per constructor, each the test's
 * function with its constructor parameter replaced by that constructor's name: what the test would be written as with
 * the constructor known, since one held as a value does not translate. The first case stays where the function was;
 * at the top level the others are function declarations after the test, so the test's line numbers stay test262's.
 * A test that still holds a constructor as a value afterwards is unported. `generic` casts each constructor to `any`,
 * as the test's untyped parameter was, so that what the test does with its arrays is not checked against one type.
 */
function typedArrayCases(id: string, source: string, generic = false): string | { unported: string } {
  const sf = ts.createSourceFile(id, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const edits: { at: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  const apply = (text: string, base: number, list: { at: number; end: number; text: string }[]) => {
    for (const e of [...list].sort((a, b) => b.at - a.at)) text = text.slice(0, e.at - base) + e.text + text.slice(e.end - base);
    return text;
  };
  /** The function with its first parameter bound to `ctor`, or null when the parameter is shadowed inside it. */
  const bind = (fn: ts.FunctionExpression | ts.ArrowFunction, ctor: string, arity: number): string | null => {
    const param = fn.parameters[0].name;
    if (!ts.isIdentifier(param)) return null;
    const name = param.text;
    const local: { at: number; end: number; text: string }[] = [];
    let shadowed = false;
    const visit = (n: ts.Node) => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name && n !== fn.parameters[0]) shadowed = true;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.length === 1 && ts.isIdentifier(n.arguments[0]) && n.arguments[0].text === name) {
        if (n.expression.text === 'isFloatTypedArrayConstructor') { local.push({ at: n.getStart(sf), end: n.end, text: String(FLOAT_ARRAYS.includes(ctor)) }); return; }
        if (n.expression.text === 'floatTypedArrayConstructorPrecision') { local.push({ at: n.getStart(sf), end: n.end, text: ctor === 'Float32Array' ? "'single'" : ctor === 'Float64Array' ? "'double'" : `floatTypedArrayConstructorPrecision(${ctor})` }); return; }
      }
      if (ts.isIdentifier(n) && n.text === name && n !== param) {
        const p = n.parent;
        const isName = (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === n;
        const value = generic ? `(${ctor} as any)` : ctor;
        if (ts.isShorthandPropertyAssignment(p)) local.push({ at: n.getStart(sf), end: n.end, text: `${name}: ${value}` });
        else if (!isName) local.push({ at: n.getStart(sf), end: n.end, text: value });
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn, visit);
    if (shadowed) return null;
    // The parameter list without the constructor's parameter.
    // The parameters the runner passes are all declared: a function of fewer is not one of its type in Swift.
    const kept = fn.parameters.slice(1).map((p) => p.getText(sf));
    const rest = [...kept, ...Array.from({ length: Math.max(0, arity - kept.length) }, (_, i) => `_unused${i}`)].join(', ');
    const parens = source.slice(fn.getStart(sf), fn.parameters.pos).trimEnd().endsWith('(');
    local.push({ at: fn.parameters.pos, end: fn.parameters.end, text: parens ? rest : `(${rest})` });
    return apply(source.slice(fn.getStart(sf), fn.end), fn.getStart(sf), local);
  };
  const declaration = (fn: ts.FunctionExpression | ts.ArrowFunction, bound: string, name: string): string => {
    if (ts.isFunctionExpression(fn)) return bound.replace(/^(async\s+)?function\s*(\*?)\s*[\w$]*\s*/, (_, a, star) => `${a ?? ''}function${star} ${name}`);
    // An arrow's parameters, then its body: a block as it is, an expression returned.
    const sub = ts.createSourceFile('f.js', bound, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const arrow = (sub.statements[0] as ts.ExpressionStatement).expression as ts.ArrowFunction;
    const params = arrow.parameters.map((p) => p.getText(sub)).join(', ');
    const body = ts.isBlock(arrow.body) ? arrow.body.getText(sub) : `{ return (${arrow.body.getText(sub)}); }`;
    return `${arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function ${name}(${params}) ${body}`;
  };
  let failed: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (Object.hasOwn(TYPED_ARRAY_RUNNERS, n.expression.text) || n.expression.text === 'testTypedArrayConversions')) {
      const conversions = n.expression.text === 'testTypedArrayConversions';
      const runner = conversions ? { ctors: TYPED_ARRAYS, list: false } : TYPED_ARRAY_RUNNERS[n.expression.text];
      const fn = n.arguments[conversions ? 1 : 0];
      if (!fn || !(ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) || !fn.parameters.length) return void (failed ??= `${n.expression.text} with a function it names`);
      let ctors = runner.ctors;
      const list = runner.list ? n.arguments[1] : undefined;
      if (list && !(list.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(list) && list.text === 'undefined'))) {
        if (ts.isIdentifier(list) && TYPED_ARRAY_LISTS[list.text]) ctors = TYPED_ARRAY_LISTS[list.text];
        else if (ts.isArrayLiteralExpression(list) && list.elements.every((e) => ts.isIdentifier(e) && [...TYPED_ARRAYS, ...BIGINT_ARRAYS].includes(e.text))) ctors = list.elements.map((e) => (e as ts.Identifier).text);
        else return void (failed ??= `${n.expression.text} with constructors it computes`);
      }
      const bound = ctors.map((c) => bind(fn, c, conversions ? 3 : 1));
      if (bound.some((b) => b === null)) return void (failed ??= `${n.expression.text} with its constructor parameter shadowed`);
      const topLevel = ts.isExpressionStatement(n.parent) && ts.isSourceFile(n.parent.parent);
      const entry = (c: string, test: string) => `{ name: '${c}', make: (a) => new ${c}(a), test: ${test} }`;
      const rest = bound.slice(1).map((b, i) => {
        if (!topLevel) return entry(ctors[i + 1], b!);
        const name = `__case${edits.length}_${ctors[i + 1]}`;
        appended.push(declaration(fn, b!, name));
        return entry(ctors[i + 1], name);
      });
      const extra = n.arguments.slice(conversions ? 2 : runner.list ? 2 : 1).map((a) => a.getText(sf));
      const target = conversions ? 'testTypedArrayConversionCases' : 'testTypedArrayCases';
      const before = conversions ? `${n.arguments[0].getText(sf)}, ` : '';
      edits.push({ at: n.getStart(sf), end: fn.getStart(sf), text: `${target}(${before}[${entry(ctors[0], '').slice(0, -2)}` });
      edits.push({ at: fn.getStart(sf), end: fn.end, text: bound[0]! + ' }' });
      edits.push({ at: fn.end, end: n.end, text: `${rest.map((r) => ', ' + r).join('')}]${extra.length ? ', ' + extra.join(', ') : ''})` });
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (failed) return { unported: `testTypedArray.js ${failed}` };
  const out = apply(source, 0, edits) + (appended.length ? '\n' + appended.join('\n') + '\n' : '');
  // What still holds a constructor as a value: a list, a runner the test calls another way, or %TypedArray%.
  const check = ts.createSourceFile(id, out, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  let left: string | null = null;
  const scan = (n: ts.Node) => {
    if (ts.isIdentifier(n) && TYPED_ARRAY_VALUES.includes(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) left ??= n.text;
    ts.forEachChild(n, scan);
  };
  scan(check);
  return left ? { unported: `testTypedArray.js ${left} (a constructor as a value)` } : out;
}

const ERROR_CONSTRUCTORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'Test262Error']);

/**
 * The test's source with each call of `assert` itself a call of `assert.ok`, and a built-in error constructor given to
 * `assert.throws` or `assert.throwsAsync` given by its name (harness/assert.ts).
 */
function assertCalls(t: Test): string {
  const sf = ts.createSourceFile(t.id, t.source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const edits: { at: number; end: number; text: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'assert') edits.push({ at: n.expression.end, end: n.expression.end, text: '.ok' });
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'assert'
      && ['throws', 'throwsAsync'].includes(n.expression.name.text) && n.arguments[0] && ts.isIdentifier(n.arguments[0]) && ERROR_CONSTRUCTORS.has(n.arguments[0].text)) {
      const a = n.arguments[0];
      edits.push({ at: a.getStart(sf), end: a.end, text: `'${a.text}'` });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  let out = t.source;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

// ---- Node: the adapted tests are valid ---------------------------------------------------------

/** Each adapted test run under Node as the bundler would build it: one that fails there is the adaptation's fault, not the compiler's. */
async function underNode(tests: Test[]): Promise<Map<string, Result>> {
  const dir = join(build, 'node');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'harness'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  const js = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } }).outputText;
  for (const f of readdirSync(join(here, 'harness'))) writeFileSync(join(dir, 'harness', f.replace(/\.ts$/, '.js')), js(readFileSync(join(here, 'harness', f), 'utf8')));
  writeFileSync(join(dir, 'main.js'), `let uncaught = null;
const describe = (e) => { try { return e !== null && typeof e === 'object' ? (e.name ?? e.constructor?.name) + ': ' + e.message : String(e); } catch { return '?'; } };
process.on('uncaughtException', (e) => { uncaught ??= describe(e); });
process.on('unhandledRejection', () => {});
process.on('exit', () => console.log(uncaught === null ? 'Test262:Completed' : 'Test262:Uncaught:' + uncaught));
await import('./' + process.argv[2] + '.js').catch((e) => { uncaught ??= describe(e); });
`);
  const out = new Map<string, Result>();
  const emitted = tests.filter((t) => {
    try {
      writeFileSync(join(dir, t.module + '.js'), js(t.adapted!));
      return true;
    } catch (e) {
      out.set(t.id, { status: 'fail', detail: `TypeScript's emit fails: ${firstLine((e as Error).message)}` });
      return false;
    }
  });
  await pool(emitted, async (t) => out.set(t.id, verdict(t, await run('node', [join(dir, 'main.js'), t.module], 20000))));
  if (!keep) rmSync(dir, { recursive: true, force: true });
  return out;
}

// ---- Native -------------------------------------------------------------------------------------

/** One test's outcome from what its program printed. */
function verdict(t: Test, r: { stdout: string; stderr: string; status: number | null; signal: string | null; timedOut: boolean }): Result {
  const line = (prefix: string) => r.stdout.split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const uncaught = line('Test262:Uncaught:');
  if (r.timedOut) return { status: 'fail', detail: 'timeout' };
  if (t.meta.negative) {
    if (uncaught === undefined) return { status: 'fail', detail: r.signal || r.status ? crash(r) : `expected ${t.meta.negative.type}, nothing thrown` };
    return uncaught.startsWith(t.meta.negative.type + ':') ? { status: 'pass' } : { status: 'fail', detail: `expected ${t.meta.negative.type}, threw ${uncaught}` };
  }
  if (uncaught !== undefined) return { status: 'fail', detail: `threw ${uncaught}` };
  if (line('Test262:Completed') === undefined) return { status: 'fail', detail: crash(r) };
  if (t.meta.flags.includes('async')) {
    const failure = line('Test262:AsyncTestFailure:');
    if (failure !== undefined) return { status: 'fail', detail: `async: ${failure}` };
    if (line('Test262:AsyncTestComplete') === undefined) return { status: 'fail', detail: 'async: $DONE not called' };
  }
  return { status: 'pass' };
}

function crash(r: { stderr: string; status: number | null; signal: string | null }): string {
  const why = r.stderr.split('\n').find((l) => /Fatal error|fatal error|Exception in thread|Error:/.test(l))?.trim().slice(0, 200);
  return `crashed (${r.signal ?? `exit ${r.status}`})${why ? ': ' + why : ''}`;
}

/** The Swift entry point: the harness modules' top level, then the one test its argument names, then the event loop. */
function swiftEntry(modules: { file: string; init: string | null }[], tests: Test[]): string {
  const byFile = new Map(tests.map((t) => [t.module, t]));
  const harness = modules.filter((m) => !byFile.has(basename(m.file, '.ts')) && m.init).map((m) => `${m.init}()`);
  const cases = modules.filter((m) => byFile.has(basename(m.file, '.ts'))).map((m) => `case "${basename(m.file, '.ts')}": ${m.init ? `${m.init}()` : 'break'}`);
  return `${SWIFT_HEADER}nonisolated(unsafe) var __uncaught: String? = nil
func __describe(_ value: Any?) -> String {
    if jsIsNullish(value) { return jsToString(value) }
    let message = (try? jsGet(value, "message")) ?? nil
    var name = (try? jsGet(value, "name")) ?? nil
    if jsIsNullish(name) { name = (try? jsGet((try? jsGet(value, "constructor")) ?? nil, "name")) ?? nil }
    if jsIsNullish(name) && jsIsNullish(message) { return jsToString(value) }
    return jsToString(name) + ": " + jsToString(message)
}
jsUncaughtHandler = { value in if __uncaught == nil { __uncaught = __describe(value) } }
${harness.join('\n')}
switch CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "" {
${cases.join('\n')}
default: print("Test262:NoSuchTest"); exit(2)
}
JSEventLoop.runUntilIdle()
print(__uncaught.map { "Test262:Uncaught:" + $0 } ?? "Test262:Completed")
`;
}

const PKG = 't262';
function kotlinEntry(modules: { file: string; init: string | null }[], tests: Test[]): string {
  const byFile = new Map(tests.map((t) => [t.module, t]));
  const harness = modules.filter((m) => !byFile.has(basename(m.file, '.ts')) && m.init).map((m) => `    ${m.init}()`);
  const cases = modules.filter((m) => byFile.has(basename(m.file, '.ts'))).map((m) => `            "${basename(m.file, '.ts')}" -> ${m.init ? `${m.init}()` : '{}'}`);
  return `package ${PKG}.entry

import org.nativescript.kit.*
import ${PKG}.*
import kotlin.system.exitProcess

private var uncaught: String? = null
private fun describe(value: Any?): String {
    if (jsIsNullish(value)) return jsToString(value)
    val message = runCatching { jsGet(value, "message") }.getOrNull()
    var name = runCatching { jsGet(value, "name") }.getOrNull()
    if (jsIsNullish(name)) name = runCatching { jsGet(jsGet(value, "constructor"), "name") }.getOrNull()
    if (jsIsNullish(name) && jsIsNullish(message)) return jsToString(value)
    return jsToString(name) + ": " + jsToString(message)
}

fun main(args: Array<String>) {
    jsUncaughtHandler = { value -> if (uncaught == null) uncaught = describe(value) }
${harness.join('\n')}
    try {
        when (args.firstOrNull() ?: "") {
${cases.join('\n')}
            else -> { println("Test262:NoSuchTest"); exitProcess(2) }
        }
    } catch (e: Throwable) { jsReportUncaught(jsCaught(e)) }
    try { JSEventLoop.runUntilIdle() } catch (e: Throwable) { jsReportUncaught(jsCaught(e)) }
    println(uncaught?.let { "Test262:Uncaught:" + it } ?: "Test262:Completed")
    System.out.flush()
}
`;
}

/** A batch of tests as one program: translated, compiled, and each test run in a process of its own. */
async function runBatch(backend: Backend, tests: Test[], dir: string, results: Map<string, Result>): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'harness'), { recursive: true });
  // Not strict, as an app of untyped code is configured: the build then checks it as its own build would.
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: false, target: 'ES2022' } }));
  for (const f of readdirSync(join(here, 'harness'))) copyFileSync(join(here, 'harness', f), join(dir, 'harness', f));
  for (const t of tests) writeFileSync(join(dir, t.module + '.ts'), t.adapted!);
  let pending = [...tests];
  const byModule = new Map(tests.map((t) => [t.module, t]));
  const retyped = new Set<Test>();
  const settle = (t: Test, r: Result) => { results.set(t.id, r); pending = pending.filter((p) => p !== t); };
  const solo: Test[] = [];

  // The type check, then translation: what either refuses is the test's alone.
  const started = Date.now();
  const out = join(dir, 'out');
  let modules: { file: string; name: string; init: string | null }[] = [];
  for (;;) {
    const refusedNow: string[] = [];
    try {
      const refused = (file: string, error: Error) => {
        const t = byModule.get(basename(file, '.ts'));
        if (!t) throw new HarnessRefused(`harness/${basename(file)}: ${firstLine(error.message).replace(/^\S*\/harness\/\w+\.ts:/, 'line ')}`);
        // A refusal names where in the test it is; an error that does not is the translator failing.
        const message = firstLine(error.message);
        settle(t, /^\S*\/t\d+\.ts:\d+:\d+: /.test(message) ? { status: 'refused', detail: 'translate: ' + message.replace(/^\S*\/t\d+\.ts:/, 'line ') } : { status: 'fail', detail: 'translator threw: ' + message });
      };
      const roots = pending.map((t) => join(dir, t.module + '.ts'));
      modules = backend === 'swift' ? translateSwift(roots, out, { appStrictness: true, refused }) : translateKotlin(roots, out, PKG, { appStrictness: true, refused });
      break;
    } catch (e) {
      // What the harness is refused for depends on what a test passes it: halving finds the tests.
      if (e instanceof HarnessRefused) {
        if (pending.length === 1) { settle(pending[0], { status: 'refused', detail: 'translate: ' + e.message }); break; }
        const half = Math.ceil(pending.length / 2);
        await runBatch(backend, pending.slice(0, half), dir + 'a', results);
        await runBatch(backend, pending.slice(half), dir + 'b', results);
        if (!keep) rmSync(dir, { recursive: true, force: true });
        return;
      }
      const text = (e as Error).message;
      if (!/does not type-check/.test(text)) throw e;
      for (const m of text.matchAll(/^(\S+?)\.ts\(\d+,\d+\): error (TS\d+: .*)$/gm)) {
        const t = byModule.get(basename(m[1]));
        if (!t) throw new Error(`the harness does not type-check:\n${text}`);
        if (!pending.includes(t) || refusedNow.includes(t.id)) continue;
        // A typed array test is checked again with its constructors untyped, as test262 wrote it.
        if (t.generic && !retyped.has(t)) { retyped.add(t); writeFileSync(join(dir, t.module + '.ts'), t.generic); refusedNow.push(t.id); continue; }
        settle(t, { status: 'refused', detail: 'type check: ' + m[2].slice(0, 200) });
        refusedNow.push(t.id);
      }
      if (!refusedNow.length) throw e;
    }
  }
  const translatedAt = Date.now();
  const translated = () => modules.filter((m) => !byModule.has(m.name) || pending.includes(byModule.get(m.name)!));

  // The compile: errors in a test's own file are the test's; others are found by halving the batch.
  const exe = join(dir, 'batch');
  let compiles = 0;
  const classes = join(dir, 'classes');
  const runtime = backend === 'kotlin' ? buildKotlinRuntime(build) : '';
  for (;;) {
    if (!pending.length) break;
    const live = translated();
    for (const f of readdirSync(out)) if (byModule.has(f.replace(/\.(swift|kt)$/, '')) && !pending.includes(byModule.get(f.replace(/\.(swift|kt)$/, ''))!)) rmSync(join(out, f));
    let errors: string[] | null;
    if (backend === 'swift') {
      writeFileSync(join(out, 'main.swift'), swiftEntry(live, pending));
      // Every file's errors in one compile, not only the first failing batch of files'.
      errors = swiftc(readdirSync(out).map((f) => join(out, f)), exe, build, optimize, ['-continue-building-after-errors']);
    } else {
      writeFileSync(join(out, '__Main.kt'), kotlinEntry(live, pending));
      errors = kotlinc(readdirSync(out).map((f) => join(out, f)), classes, [runtime]);
    }
    compiles++;
    if (!errors) break;
    const own = new Map<Test, string>();
    for (const e of errors) {
      // Swift reports a line of a test at the test's own source (#sourceLocation).
      const file = /([\w.-]+)\.(?:swift|kt|ts):\d+:\d+/.exec(e)?.[1];
      const t = file ? byModule.get(file) : undefined;
      if (t && pending.includes(t) && !own.has(t)) own.set(t, e.replace(/^.*?error:\s*/, ''));
    }
    const compiler = backend === 'swift' ? 'swiftc' : 'kotlinc';
    if (own.size) {
      for (const [t, e] of own) {
        // Top-level names the batch's other modules share: the test is compiled again alone, as its own app would be.
        if (tests.length > 1 && /conflicting declarations|overload resolution ambiguity|invalid redeclaration|ambiguous use of/.test(e)) { solo.push(t); pending = pending.filter((p) => p !== t); continue; }
        settle(t, { status: 'fail', detail: `${compiler}: ${e.slice(0, 200)}` });
      }
      continue;
    }
    // The harness's own errors fail every test of the batch: halving would only find them again.
    const inHarness = errors.find((e) => /(?:^|\/)harness\/\w+\.(?:swift|kt|ts):\d+/.test(e) || new RegExp(`^(?:.*/out/)?(?:${HARNESS_MODULES.join('|')})\\.(?:swift|kt):\\d+`).test(e));
    if (inHarness) { for (const t of [...pending]) settle(t, { status: 'fail', detail: `${compiler}: harness: ${inHarness.replace(/^.*\/(harness\/|out\/)/, '$1').slice(0, 200)}` }); break; }
    if (pending.length === 1) { settle(pending[0], { status: 'fail', detail: `${compiler}: ${errors[0].replace(/^.*?error:\s*/, '').slice(0, 200)}` }); break; }
    const half = Math.ceil(pending.length / 2);
    const [a, b] = [pending.slice(0, half), pending.slice(half)];
    await runBatch(backend, [...a, ...solo.splice(0)], dir + 'a', results);
    await runBatch(backend, b, dir + 'b', results);
    if (!keep) rmSync(dir, { recursive: true, force: true });
    return;
  }

  const compiled = Date.now();
  const command = (t: Test): [string, string[]] => backend === 'swift' ? [exe, [t.module]] : ['java', ['-Xss16m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-cp', [classes, runtime, kotlinStdlib()].join(':'), `${PKG}.entry.__MainKt`, t.module]];
  await pool(pending, async (t) => { const [cmd, args] = command(t); results.set(t.id, verdict(t, await run(cmd, args, 15000))); });
  for (const t of solo) {
    await runBatch(backend, [t], `${dir}-${t.module}`, results);
    soloRuns.push(`${t.id} (${backend})`);
  }
  if (process.env.NS_TEST262_TIMES) console.log(`  ${basename(dir)}: ${tests.length} tests, translate ${Math.round((translatedAt - started) / 1000)}s, compile ${Math.round((compiled - translatedAt) / 1000)}s (${compiles}), run ${pending.length} ${Math.round((Date.now() - compiled) / 1000)}s`);
  if (!keep) rmSync(dir, { recursive: true, force: true });
}

/** Tests that compiled only alone, their batch's other modules declaring names they declare. */
const soloRuns: string[] = [];

class HarnessRefused extends Error {}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.slice(0, 200) ?? s;

function run(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; status: number | null; signal: string | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { if (stdout.length < 1 << 20) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1 << 16) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ stdout, stderr, status, signal, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ stdout, stderr: String(e), status: -1, signal: null, timedOut }); });
  });
}

async function pool<T>(items: T[], each: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => { while (next < items.length) await each(items[next++]); }));
}

// ---- Report -------------------------------------------------------------------------------------

/** Where a run's results came from: the compiler's commit, whether its files differed from it, and the day. */
interface Provenance { compiler: string; date: string; partial: boolean }
function provenance(): Provenance {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: here, encoding: 'utf8' }).stdout.trim();
  // What the runner itself writes is not the compiler.
  const dirty = git('status', '--porcelain', '--', '../..', ':!baseline.json', ':!README.md') !== '';
  return { compiler: git('rev-parse', '--short=9', 'HEAD') + (dirty ? ' with local changes' : ''), date: new Date().toISOString().slice(0, 10), partial: only.length > 0 || areas.length > 0 };
}

const BACKEND_NAMES: Record<string, string> = { swift: 'Swift', kotlin: 'Kotlin' };

/** The results as markdown: one row per backend, then one per area and backend, with the counts' definitions. */
function summary(tests: { id: string; area: string }[], all: Record<string, Map<string, Result>>, from: Provenance): string {
  const percent = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
  const n = (x: number) => x.toLocaleString('en-US');
  const row = (label: string, backend: string, of: { id: string }[]) => {
    const c = Object.fromEntries(COLUMNS.map((s) => [s, 0])) as Record<Column, number>;
    for (const t of of) c[columnOf(all[backend].get(t.id)!)]++;
    const counted = c.pass + c.refused + c['type check rejected'] + c['compile error'] + c['wrong output'];
    const accepted = c.pass + c['compile error'] + c['wrong output'];
    return `| ${label}${BACKEND_NAMES[backend] ?? backend} | ${n(of.length)} | ${COLUMNS.slice(0, 3).map((s) => n(c[s])).join(' | ')} | ${n(counted)} | ${COLUMNS.slice(3).map((s) => n(c[s])).join(' | ')} | ${percent(c.pass, counted)} | ${percent(c.pass, accepted)} |`;
  };
  const head = (first: string) => [`| ${first} | Selected | Out of scope | Harness not ported | Fails under Node | Counted | Pass | Refused | Type check rejected | Compile error | Wrong output | Pass rate | Accepted pass rate |`, `|---|${'---:|'.repeat(12)}`];
  const backends = Object.keys(all);
  const wrongOutput = (backend: string, of: { id: string }[]) => {
    const kinds = new Map<string, number>(WRONG_OUTPUT_KINDS.map((k) => [k, 0]));
    for (const t of of) {
      const r = all[backend].get(t.id)!;
      if (columnOf(r) === 'wrong output') kinds.set(wrongOutputKind(r.detail ?? ''), kinds.get(wrongOutputKind(r.detail ?? ''))! + 1);
    }
    return `${BACKEND_NAMES[backend] ?? backend} ${[...kinds].map(([k, v]) => `${k} ${n(v)}`).join(', ')}`;
  };
  const areaNames = [...new Set(tests.map((t) => t.area))];
  return [
    `test262 \`${COMMIT.slice(0, 10)}\`, compiler \`${from.compiler}\`, run ${from.date}${from.partial ? ' (some tests only)' : ''}. Swift as macOS executables, Kotlin on the host JVM.`,
    '',
    ...head('Backend'),
    ...backends.map((b) => row('', b, tests)),
    '',
    'By area (`tests.txt` lists each area\'s directories):',
    '',
    ...head('Area'),
    ...areaNames.flatMap((a) => backends.map((b) => row(`${a}, `, b, tests.filter((t) => t.area === a)))),
    '',
    `Wrong output, by what the run showed: ${backends.map((b) => wrongOutput(b, tests)).join('; ')}.`,
    '',
    'Counted is pass + refused + type check rejected + compile error + wrong output. Pass rate is pass / counted.',
    'Accepted pass rate is pass / (pass + compile error + wrong output): of the tests the compiler accepted, the share that',
    'ran as JavaScript does.',
    '',
  ].join('\n');
}

/** Causes already tracked elsewhere, noted on the baseline's entries. */
const KNOWN_CAUSES: Record<string, string> = {
  'swift:language/statements/try/completion-values-fn-finally-normal.js': 'Swift 6: the finally flag is written from a nonisolated closure',
  'kotlin:built-ins/Array/prototype/indexOf/length-zero-returns-minus-one.js': 'an untyped argument to a number parameter is converted at the call, before the method checks the length',
  'kotlin:built-ins/Array/prototype/lastIndexOf/15.4.4.15-8-a-6.js': 'an untyped argument to a number parameter is converted at the call, before the method checks the length',
  'kotlin:built-ins/Array/prototype/lastIndexOf/length-zero-returns-minus-one.js': 'an untyped argument to a number parameter is converted at the call, before the method checks the length',
  'kotlin:built-ins/RegExp/prototype/exec/y-init-lastindex.js': 'a property read through the null check of a possibly-null match does not resolve: `(match ?: jsCannotReadNull("length")).length`',
};

/** A result's detail as the baseline keeps it: enough to tell its cause, without paths. */
const brief = (detail: string) => detail.replace(/\/\S*\/(?=[\w.-]+\.(?:ts|swift|kt)\b)/g, '').replace(/ is not supported in a release build yet: .*/, ' is not supported').slice(0, 120);

/**
 * The results against baseline.json, each backend's tests that do not pass (fail or refused) with why, and the
 * regressions: tests not listed there that do not pass. With --update-baseline, the baseline is rewritten from the
 * results; `partial` (a run of some tests) keeps the other tests' entries.
 */
function checkBaseline(tests: { id: string }[], all: Record<string, Map<string, Result>>, partial: boolean): number {
  const baselineFile = join(here, 'baseline.json');
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
  let regressions = 0;
  for (const backend of Object.keys(all)) {
    const known: Record<string, string> = baseline[backend] ?? {};
    const results = all[backend];
    const counted = tests.filter((t) => ['pass', 'fail', 'refused'].includes(results.get(t.id)!.status));
    const regressed = counted.filter((t) => results.get(t.id)!.status !== 'pass' && !(t.id in known));
    const improved = counted.filter((t) => results.get(t.id)!.status === 'pass' && t.id in known);
    if (!flag('--update-baseline')) for (const t of regressed) console.log(`✗ ${t.id} (${backend}): ${results.get(t.id)!.status}: ${results.get(t.id)!.detail}`);
    if (improved.length) console.log(`${improved.length} tests in baseline.json now pass on ${backend}${flag('--update-baseline') ? '' : ': run with --update-baseline to remove them'}`);
    regressions += regressed.length;
    if (flag('--update-baseline')) {
      const ran = new Set(counted.map((t) => t.id));
      const next = partial ? Object.fromEntries(Object.entries(known).filter(([id]) => !ran.has(id))) : {};
      for (const t of counted) {
        const r = results.get(t.id)!;
        const cause = KNOWN_CAUSES[`${backend}:${t.id}`];
        if (r.status !== 'pass') next[t.id] = `${r.status}: ${brief(r.detail ?? '')}${cause ? ` (${cause})` : ''}`;
      }
      baseline[backend] = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    }
  }
  if (flag('--update-baseline')) {
    const { $comment, commit, ...rest } = baseline;
    const comment = 'test262 tests that do not pass yet, by backend, with why: generated by run.ts --update-baseline. A test not listed that does not pass fails the run.';
    writeFileSync(baselineFile, JSON.stringify({ $comment: comment, commit: COMMIT, ...rest }, null, '\t') + '\n');
    console.log(`baseline.json updated (${relative(process.cwd(), baselineFile)})`);
    return 0;
  }
  if (regressions) console.log(`${regressions} regressions against baseline.json`);
  return regressions;
}

/**
 * The summary of the last run's results (results-<backend>.json in the build directory), checked against the baseline,
 * without running anything. With --readme it also replaces README.md's results, which only a full run of both backends
 * at one commit may give.
 */
function report(): never {
  const all: Record<string, Map<string, Result>> = {};
  let tests: { id: string; area: string }[] = [];
  const from: Provenance[] = [];
  for (const backend of backends) {
    const file = join(build, `results-${backend}.json`);
    if (!existsSync(file)) continue;
    const { results, provenance } = JSON.parse(readFileSync(file, 'utf8')) as { results: Record<string, Result & { area: string }>; provenance?: Provenance };
    all[backend] = new Map(Object.entries(results));
    from.push(provenance ?? { compiler: 'unknown', date: 'unknown', partial: true });
    if (!tests.length) tests = Object.entries(results).map(([id, r]) => ({ id, area: r.area }));
  }
  const table = summary(tests, all, from[0]);
  console.log(table);
  if (flag('--readme')) {
    const why = Object.keys(all).length < 2 ? 'results for both backends' : from.some((f) => f.partial) ? 'a full run' : from.some((f) => f.compiler !== from[0].compiler || f.compiler.includes(' ')) ? 'both backends run at one committed compiler' : '';
    if (why) { console.error(`README.md's results need ${why}`); process.exit(1); }
    const readme = join(here, 'README.md');
    const text = readFileSync(readme, 'utf8');
    const [start, end] = ['<!-- results: generated by run.ts --report --readme -->', '<!-- /results -->'];
    if (!text.includes(start) || !text.includes(end)) { console.error(`README.md has no ${start} … ${end}`); process.exit(1); }
    writeFileSync(readme, text.slice(0, text.indexOf(start) + start.length) + '\n' + table + text.slice(text.indexOf(end)));
    console.log('README.md results updated');
  }
  process.exit(checkBaseline(tests, all, false) ? 1 : 0);
}

// ---- Run ----------------------------------------------------------------------------------------

if (flag('--report')) report();
const { included, excluded } = selection();
const dir = test262([...new Set(included.map((i) => fixedPart(i.path)).filter((p) => !p.startsWith('self/')))]);
const exclusions = excluded.map(matcher);
const seen = new Set<string>();
const tests: Test[] = [];
for (const { path, area } of included) {
  for (const id of testFiles(dir, path)) {
    if (seen.has(id) || exclusions.some((x) => x(id))) continue;
    if (only.length && !only.some((o) => id.includes(o))) continue;
    if (areas.length && !areas.includes(area)) continue;
    seen.add(id);
    const source = readFileSync(join(baseOf(dir, id), id), 'utf8');
    tests.push({ id, area, module: 't' + String(tests.length).padStart(5, '0'), source, meta: metaOf(source) });
  }
}

for (const t of tests) {
  const code = codeOf(t.source);
  const scope = OUT_OF_SCOPE.find((o) => o.features?.some((f) => t.meta.features.includes(f)) || o.includes?.some((i) => t.meta.includes.includes(i)) || o.code?.test(code));
  const na = NOT_APPLICABLE.find((n) => n.test(t.meta, code));
  if (scope || na) { t.skip = { status: 'out-of-scope', detail: (scope ?? na)!.reason }; continue; }
  const adapted = adapt(t, code);
  if (typeof adapted !== 'string') { t.skip = { status: 'unported', detail: adapted.unported }; continue; }
  t.adapted = adapted;
  const generic = t.meta.includes.includes('testTypedArray.js') ? adapt(t, code, true) : adapted;
  if (typeof generic === 'string' && generic !== adapted) t.generic = generic;
}

if (flag('--list')) {
  const areas = [...new Set(tests.map((t) => t.area))];
  for (const a of areas) {
    const of = tests.filter((t) => t.area === a);
    console.log(`${a}: ${of.length} selected, ${of.filter((t) => !t.skip).length} to run; ${['out-of-scope', 'unported'].map((s) => `${s} ${of.filter((t) => t.skip?.status === s).length}`).join(', ')}`);
  }
  const reasons = new Map<string, number>();
  for (const t of tests) if (t.skip) reasons.set(`${t.skip.status}: ${t.skip.detail}`, (reasons.get(`${t.skip.status}: ${t.skip.detail}`) ?? 0) + 1);
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n} ${r}`);
  console.log(`${tests.length} selected, ${tests.filter((t) => !t.skip).length} to run`);
  process.exit(0);
}

mkdirSync(build, { recursive: true });
const runnable = tests.filter((t) => !t.skip);
console.log(`${tests.length} tests selected, ${runnable.length} to run (${tests.length - runnable.length} out of scope or unported)`);
const node = await underNode(runnable);
for (const t of runnable) {
  const r = node.get(t.id)!;
  if (r.status !== 'pass') t.skip = { status: 'invalid', detail: 'fails under Node: ' + r.detail };
}
const native = tests.filter((t) => !t.skip);
console.log(`${native.length} pass under Node; ${runnable.length - native.length} do not, and are not counted`);

const all: Record<string, Map<string, Result>> = {};
const ranFrom = provenance();
for (const backend of backends) {
  const started = Date.now();
  const results = new Map<string, Result>();
  for (const t of tests) if (t.skip) results.set(t.id, { status: t.skip.status, detail: t.skip.detail });
  if (backend === 'swift') buildSwiftRuntime(build, optimize);
  for (let i = 0; i < native.length; i += batchSize) {
    const batch = native.slice(i, i + batchSize);
    const free = statfsSync(build).bavail * statfsSync(build).bsize / 2 ** 30;
    if (free < minFree) throw new Error(`${free.toFixed(1)} GB free, under $NS_TEST262_MIN_FREE_GB (${minFree} GB): stopped before batch ${i / batchSize}`);
    await runBatch(backend, batch, join(build, backend, `batch-${i / batchSize}`), results);
    const done = native.slice(0, i + batch.length);
    console.log(`${backend}: ${done.length} of ${native.length} run, ${done.filter((t) => results.get(t.id)?.status === 'pass').length} pass (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  all[backend] = results;
  writeFileSync(join(build, `results-${backend}.json`), JSON.stringify({ commit: COMMIT, provenance: ranFrom, results: Object.fromEntries(tests.map((t) => [t.id, { area: t.area, ...results.get(t.id) }])) }, null, 1));
  if (!keep) rmSync(join(build, backend), { recursive: true, force: true });
}

if (soloRuns.length) writeFileSync(join(build, 'solo.txt'), soloRuns.join('\n') + '\n');
if (soloRuns.length) console.log(`${soloRuns.length} tests did not compile beside their batch's other modules (names they share), and were compiled alone: ${join(build, 'solo.txt')}`);
const table = summary(tests, all, ranFrom);
writeFileSync(join(build, 'summary.md'), table);
console.log('\n' + table);

process.exit(checkBaseline(tests, all, only.length > 0 || areas.length > 0) ? 1 : 0);
