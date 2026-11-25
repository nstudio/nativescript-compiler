#!/usr/bin/env node
// tests/diff/WTFJS.md: which diff cases cover each example of wtfjs (github.com/denysdovhan/wtfjs) and what each case
// does on each backend. A case line holding an example ends `// wtfjs: <the example's heading>` (several joined by ` | `).
// A case's result is what a passing diff run makes it: refused where it declares `@refused` for the backend (the refusal's
// id is read by translating it), a known failure where known-failures.json lists it, otherwise a match with Node.
//   node tests/diff/wtfjs.ts [--check] [--results <file>…]
// --check fails when WTFJS.md is not what this writes. --results compares with `node tests/diff/run.ts --json <file>`
// output and fails where a run's result is another.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { kotlinOptions, refusalId, refusedWith, runsOn, swiftOptions } from './case-options.ts';
import { translateKotlin, translateSwift } from '../native-build.ts';
import { diffCases, knownFailuresFile } from '../suite.ts';

/** The wtfjs commit the examples are from, and their headings in its README's order. */
const COMMIT = 'a2c83226a15890004758971264211f116fff367a';
const EXAMPLES = [
  '`[]` is equal `![]`',
  '`true` is not equal `![]`, but not equal `[]` too',
  'true is false',
  'baNaNa',
  '`NaN` is not a `NaN`',
  '`Object.is()` and `===` weird cases',
  'It\'s a fail',
  '`[]` is truthy, but not `true`',
  '`null` is falsy, but not `false`',
  '`document.all` is an object, but it is undefined',
  'Minimal value is greater than zero',
  'function is not a function',
  'Adding arrays',
  'Trailing commas in array',
  'Array equality is a monster',
  '`undefined` and `Number`',
  '`parseInt` is a bad guy',
  'Math with `true` and `false`',
  'HTML comments are valid in JavaScript',
  '`NaN` is ~~not~~ a number',
  '`[]` and `null` are objects',
  'Magically increasing numbers',
  'Precision of `0.1 + 0.2`',
  'Patching numbers',
  'Comparison of three numbers',
  'Funny math',
  'Addition of RegExps',
  'Strings aren\'t instances of `String`',
  'Calling functions with backticks',
  'Call call call',
  'A `constructor` property',
  'Object as a key of object\'s property',
  'Accessing prototypes with `__proto__`',
  '`` `${{Object}}` ``',
  'Destructuring with default values',
  'Dots and spreading',
  'Labels',
  'Nested labels',
  'Insidious `try..catch`',
  'Is this multiple inheritance?',
  'A generator which yields itself',
  'A class of class',
  'Non-coercible objects',
  'Tricky arrow functions',
  'Arrow functions can not be a constructor',
  '`arguments` and arrow functions',
  'Tricky return',
  'Chaining assignments on object',
  'Accessing object properties with arrays',
  '`Number.toFixed()` display different numbers',
  '`Math.max()` less than `Math.min()`',
  'Comparing `null` to `0`',
  'Same variable redeclaration',
  'Default behavior Array.prototype.sort()',
  'resolve() won\'t return Promise instance',
  '`{}{}` is undefined',
  '`arguments` binding',
  'An `alert` from hell',
  'An infinite timeout',
  'A `setTimeout` object',
  'Double dot',
  'Extra Newness',
  'Why you should use semicolons',
  'Split a string by a space',
  'A stringified string',
  'Non-strict comparison of a number to `true`'
,
];
/** Examples with nothing a compiled module could run, and why. */
const NOT_APPLICABLE: Record<number, string> = {
  10: 'a DOM object; there is no document',
  19: 'Annex B HTML comments, which TypeScript does not parse',
  56: "a statement list's completion value, which only a REPL or eval shows",
  58: 'calls the Function constructor with text (function-constructor, a declared limit)',
  60: 'a string given to setTimeout is evaluated (eval, a declared limit)',
};
const TARGETS = ['swift', 'kotlin'] as const;
type Target = (typeof TARGETS)[number];
type Result = 'pass' | 'known' | 'refused' | 'fail';

const argv = process.argv.slice(2);
const out = join(import.meta.dirname, 'WTFJS.md');
const known = JSON.parse(readFileSync(knownFailuresFile, 'utf8'));
const files = readdirSync(diffCases).filter((f) => f.endsWith('.ts')).sort();

/** Per example (1-based), the cases holding it. */
const casesOf = new Map<number, string[]>();
for (const f of files) {
  for (const m of readFileSync(join(diffCases, f), 'utf8').matchAll(/\/\/ wtfjs: (.+)$/gm)) {
    for (const heading of m[1].split(' | ')) {
      const n = EXAMPLES.indexOf(heading.trim()) + 1;
      if (!n) throw new Error(`${f}: no wtfjs example is headed ${JSON.stringify(heading)}`);
      const name = basename(f, '.ts');
      if (!casesOf.get(n)?.includes(name)) casesOf.set(n, [...(casesOf.get(n) ?? []), name]);
    }
  }
}

/** A case's result on a backend, and the refusal's id when refused; null where it does not run there. */
const refusals = new Map<string, string>();
function resultOf(name: string, target: Target): Result | null {
  const file = join(diffCases, name + '.ts');
  if (!runsOn(file, target)) return null;
  if (refusedWith(file, target)) return 'refused';
  return known[target]?.[name] ? 'known' : 'pass';
}
function refusalOf(name: string, target: Target): string {
  const key = `${target}:${name}`;
  if (!refusals.has(key)) {
    const file = join(diffCases, name + '.ts');
    const dir = mkdtempSync(join(tmpdir(), 'wtfjs-'));
    let id = '?';
    try {
      if (target === 'swift') translateSwift([file], dir, swiftOptions(file));
      else translateKotlin([file], dir, 'wtfjs', kotlinOptions(file));
    } catch (err) {
      id = refusalId(err as Error) ?? '?';
    }
    rmSync(dir, { recursive: true, force: true });
    refusals.set(key, id);
  }
  return refusals.get(key)!;
}

const mismatches: string[] = [];
for (const file of argv.filter((_, k) => argv[k - 1] === '--results')) {
  const run: Record<string, Record<string, { result: Result }>> = JSON.parse(readFileSync(file, 'utf8'));
  for (const t of TARGETS) {
    for (const name of new Set([...casesOf.values()].flat())) {
      const got = run[t]?.[name]?.result;
      if (got && got !== resultOf(name, t)) mismatches.push(`${name} (${t}): ${got} in ${file}, ${resultOf(name, t)} here`);
    }
  }
}

const mark: Record<Result, string> = { pass: '✓', known: '✗', refused: 'R', fail: '✗' };
const num = (name: string) => name.split('-')[0];
const CLASSES = ['matches Node', 'matches Node, the rest refused', 'partly fails', 'fails', 'refused', 'not run'] as const;
type Class = (typeof CLASSES)[number];
function classOf(cases: string[], t: Target): Class {
  const results = cases.map((c) => resultOf(c, t)).filter((r) => r !== null);
  const passes = results.includes('pass'), fails = results.some((r) => r === 'known' || r === 'fail'), refused = results.includes('refused');
  if (!results.length) return 'not run';
  if (passes) return fails ? 'partly fails' : refused ? 'matches Node, the rest refused' : 'matches Node';
  return fails ? 'fails' : 'refused';
}

const rows: string[] = [];
const counts = Object.fromEntries(TARGETS.map((t) => [t, Object.fromEntries(CLASSES.map((c) => [c, 0]))])) as Record<Target, Record<Class, number>>;
let covered = 0, notApplicable = 0, notCovered = 0;
EXAMPLES.forEach((heading, k) => {
  const n = k + 1;
  const cases = casesOf.get(n) ?? [];
  const cell = (t: Target) => cases.map((c) => resultOf(c, t)).every((r) => r === null) ? '' : `${classOf(cases, t)}: ${cases.filter((c) => resultOf(c, t)).map((c) => `${num(c)} ${mark[resultOf(c, t)!]}`).join(', ')}`;
  const refused = [...new Set(TARGETS.flatMap((t) => cases.filter((c) => resultOf(c, t) === 'refused').map((c) => `${refusalOf(c, t)}${resultOf(c, t === 'swift' ? 'kotlin' : 'swift') === 'refused' ? '' : ` (${t === 'swift' ? 'Swift' : 'Kotlin'})`}`)))].join(', ');
  if (cases.length) {
    covered++;
    for (const t of TARGETS) counts[t][classOf(cases, t)]++;
  } else if (NOT_APPLICABLE[n]) notApplicable++;
  else notCovered++;
  rows.push(`| ${n} | ${heading.replace(/\|/g, '\\|')} | ${cell('swift')} | ${cell('kotlin')} | ${refused} | ${cases.length ? '' : NOT_APPLICABLE[n] ? `n/a: ${NOT_APPLICABLE[n]}` : 'not covered'} |`);
});

const text = `# wtfjs coverage

<!-- Generated by \`node tests/diff/wtfjs.ts\` from the diff cases' \`// wtfjs:\` tags and known-failures.json; do not edit. -->

The examples of [wtfjs](https://github.com/denysdovhan/wtfjs/blob/${COMMIT}/README.md) at commit \`${COMMIT.slice(0, 10)}\`,
each with the diff cases (\`tests/diff/cases\`) that hold it. A case either matches Node (✓), is a known failure listed in
\`known-failures.json\` with its cause (✗), or is refused at build time as it declares (R). An example *matches Node* when
every case holding it that runs does; *the rest refused* when the others are refused (the case that matches is often the
example rewritten as \`src/semantics/refusals.ts\` suggests, each of whose rewrites runs in cases 1580-1582); it *partly fails* when
some of its cases match Node and some are known failures.

The table is what a passing diff run gives (\`node tests/diff/run.ts\` fails on any other outcome), so it holds at every
commit where CI's differential and \`wtfjs.ts --check\` steps pass. To compare it with a run of your own:
\`node tests/diff/run.ts --json <file>\`, then \`node tests/diff/wtfjs.ts --results <file>\`.

| | Swift | Kotlin |
|---|---:|---:|
| Examples covered | ${covered} of ${EXAMPLES.length} | ${covered} of ${EXAMPLES.length} |
${CLASSES.filter((c) => c !== 'not run').map((c) => `| ${c[0].toUpperCase() + c.slice(1)} | ${counts.swift[c]} | ${counts.kotlin[c]} |`).join('\n')}
| Not applicable to compiled module code | ${notApplicable} | ${notApplicable} |
| Not covered | ${notCovered} | ${notCovered} |

| # | Example | Swift | Kotlin | Refused | |
|---:|---|---|---|---|---|
${rows.join('\n')}
`;

for (const m of mismatches) console.log(`✗ ${m}`);
if (argv.includes('--check')) {
  const same = readFileSync(out, 'utf8') === text;
  console.log(same ? 'wtfjs: WTFJS.md is current' : '✗ wtfjs: WTFJS.md is not what the cases say: run node tests/diff/wtfjs.ts');
  process.exit(same && !mismatches.length ? 0 : 1);
}
writeFileSync(out, text);
console.log(`wtfjs: wrote ${out}: ${covered} of ${EXAMPLES.length} examples covered`);
process.exit(mismatches.length ? 1 : 0);
