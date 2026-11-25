#!/usr/bin/env node
// npm run pack -- [out-dir] [--adapters-only | --compiler-only | --all]
// Packs @nstudio/nativescript-compiler and its public framework adapters into <out-dir> (default: ./packed)
// and prints each tarball's sha1.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const compilerOnly = args.includes('--compiler-only');
const adaptersOnly = args.includes('--adapters-only');
const includePrivate = args.includes('--all');
const out = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, 'packed'));

const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const compilerPkg = json(join(root, 'packages', 'compiler', 'package.json'));
const adapterDirs = readdirSync(join(root, 'packages'))
  .filter((d) => d !== 'compiler' && existsSync(join(root, 'packages', d, 'package.json')))
  .sort();

const selected = [];
if (!adaptersOnly) selected.push({ dir: 'compiler', pkg: compilerPkg });
if (!compilerOnly) {
  for (const d of adapterDirs) {
    const pkg = json(join(root, 'packages', d, 'package.json'));
    if (pkg.private && !includePrivate) continue;
    const wanted = pkg.peerDependencies?.['@nstudio/nativescript-compiler'];
    if (wanted && wanted !== compilerPkg.version) {
      console.error(`${pkg.name} expects @nstudio/nativescript-compiler ${wanted}, but packages/compiler is ${compilerPkg.version}. Run: npm run version:sync -- ${compilerPkg.version}`);
      process.exit(1);
    }
    selected.push({ dir: d, pkg });
  }
}

mkdirSync(out, { recursive: true });
for (const { dir, pkg } of selected) {
  const pkgDir = join(root, 'packages', dir);
  const r = spawnSync('npm', ['pack', '--pack-destination', out], { cwd: pkgDir, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const file = join(out, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
  if (!existsSync(file)) {
    console.error(`${file}: not written`);
    process.exit(1);
  }
  console.log(`${createHash('sha1').update(readFileSync(file)).digest('hex')}  ${file}`);
}
