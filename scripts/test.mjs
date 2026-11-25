#!/usr/bin/env node
// npm test, and npm run test:<what> -- [args…]: the framework adapters' tests, run on packages/compiler's harness.
//   node scripts/test.mjs [all|diff|fuzz|release-checks|native-build|template] [args…]
// $SUITE=<package> runs one adapter suite (e.g. SUITE=angular npm run test:release-checks).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const [what = 'all', ...args] = process.argv.slice(2);
const compiler = realpathSync(process.env.NS_COMPILER ?? join(root, 'packages', 'compiler'));
if (!existsSync(join(compiler, 'tests', 'suite.ts'))) {
  console.error(`${compiler}: missing tests/suite.ts`);
  process.exit(2);
}
const suites = readdirSync(join(root, 'packages'))
  .filter((p) => p !== 'compiler' && existsSync(join(root, 'packages', p, 'tests', 'suite.json')) && (!process.env.SUITE || p === process.env.SUITE))
  .sort();
const env = (suite) => ({
  ...process.env,
  NS_COMPILER: compiler,
  NS_COMPILER_ADAPTERS: join(root, 'packages'),
  NS_TEST_SUITE: join(root, 'packages', suite, 'tests'),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(join(import.meta.dirname, 'compiler-hooks.mjs'))}`.trim(),
});

let failed = 0;
const hasCases = (suite) => existsSync(join(root, 'packages', suite, 'tests', 'diff', 'cases'));
const run = (suite, label, command, commandArgs) => {
  console.log(`\n== ${suite}: ${label}`);
  const r = spawnSync(command, commandArgs, { stdio: 'inherit', env: env(suite) });
  if (r.status !== 0) {
    failed++;
    console.log(`== ${suite}: ${label} FAILED`);
  }
};
const tests = {
  diff: (s, a = args) => hasCases(s) && run(s, `diff ${a.join(' ')}`, process.execPath, [join(compiler, 'tests', 'diff', 'run.ts'), ...a]),
  fuzz: (s, a = args) => hasCases(s) && run(s, `fuzz ${a.join(' ')}`, process.execPath, [join(compiler, 'tests', 'fuzz', 'run.ts'), ...a]),
  'release-checks': (s) => existsSync(join(root, 'packages', s, 'tests', 'release-checks', 'run.ts')) && run(s, 'release checks', process.execPath, [join(root, 'packages', s, 'tests', 'release-checks', 'run.ts')]),
  'native-build': (s) => existsSync(join(root, 'packages', s, 'tests', 'native-build-check.ts')) && run(s, 'native-build check', process.execPath, [join(root, 'packages', s, 'tests', 'native-build-check.ts')]),
  template: (s) => {
    const dir = join(root, 'packages', s, 'tests');
    for (const t of readdirSync(dir).filter((d) => d.startsWith('template-')).sort()) {
      const out = mkdtempSync(join(tmpdir(), `${s}-${t}-`));
      process.env.TEMPLATE_APP_TRANSLATE_ONLY = args.includes('--build') ? '' : '1';
      run(s, t, process.execPath, [join(compiler, 'tests', 'template-app.ts'), join(dir, t), out]);
      rmSync(out, { recursive: true, force: true });
    }
  },
};
for (const s of suites) {
  if (what === 'all') {
    if (platform() === 'darwin') tests.diff(s, ['--swift']);
    tests.diff(s, ['--kotlin']);
    tests['release-checks'](s);
    tests['native-build'](s);
  } else if (tests[what]) tests[what](s);
  else {
    console.error(`usage: node scripts/test.mjs [all|${Object.keys(tests).join('|')}] [args…]`);
    process.exit(2);
  }
}
if (!suites.length) console.log('no suite (packages/*/tests/suite.json)');
process.exit(failed ? 1 : 0);
