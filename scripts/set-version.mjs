#!/usr/bin/env node
// Syncs version across @nstudio/nativescript-compiler and all workspace adapter packages,
// keeping every adapter's peerDependencies["@nstudio/nativescript-compiler"] in lockstep.
//   node scripts/set-version.mjs <version> [--core-version <core-version>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const coreIdx = args.indexOf('--core-version');
const coreVersion = coreIdx >= 0 ? args[coreIdx + 1] : undefined;

if (!version) {
  console.error('usage: node scripts/set-version.mjs <version> [--core-version <core-version>]');
  process.exit(2);
}

const packagesDir = join(root, 'packages');
for (const dir of readdirSync(packagesDir).sort()) {
  const pkgPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  if (pkg.peerDependencies?.['@nstudio/nativescript-compiler']) {
    pkg.peerDependencies['@nstudio/nativescript-compiler'] = version;
  }
  if (dir === 'compiler' && coreVersion && pkg.peerDependencies?.['@nativescript/core']) {
    pkg.peerDependencies['@nativescript/core'] = coreVersion;
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${pkg.name}@${pkg.version}`);
}
