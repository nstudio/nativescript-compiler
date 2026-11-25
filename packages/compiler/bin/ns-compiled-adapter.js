#!/usr/bin/env node
// ns-compiled-adapter <command>: what a framework adapter's own build runs.
//   build [<adapter package>]          compiles the adapter's TypeScript (default: the current folder's) to the JavaScript
//                                      its package.json's `exports['.'].default` names, in its dist/. An installed adapter
//                                      runs that: Node strips no types under node_modules. Its runtime/ is TypeScript the
//                                      compiler compiles with an app, and stays as it is.
//   kit-fragment <Swift folder> [--check]
//                                      writes beside the adapter's kit Swift what it adds to the iOS kit's index
//                                      (kit-index.json), against this compiler's generated kit; an app of the adapter's
//                                      framework reads the kit's index with it. --check exits 1 when the file there differs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDist } from './build-dist.mjs';

const USAGE = 'usage: ns-compiled-adapter build [<adapter package>] | kit-fragment <adapter kit-apple folder> [--check]';
const [command, ...args] = process.argv.slice(2);

if (command === 'build') {
  const root = resolve(args[0] ?? '.');
  const count = buildDist(root, join(root, 'dist'), { skip: (d) => ['dist', 'node_modules', 'runtime', 'tests'].includes(d) || d.startsWith('kit-') });
  console.log(`${count} modules compiled to ${join(root, 'dist')}`);
} else if (command === 'kit-fragment') {
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error(USAGE);
    process.exit(2);
  }
  const published = existsSync(new URL('../dist/kit/manifest.js', import.meta.url));
  if (!published) await import('./strip-types.js');
  const { adapterKitFragment, KIT_MANIFEST_FILE } = await import(published ? '../dist/kit/manifest.js' : '../src/kit/manifest.ts');
  const { KIT_APPLE_SOURCES } = await import(published ? '../dist/driver/paths.js' : '../src/driver/paths.ts');
  const file = join(resolve(dir), KIT_MANIFEST_FILE);
  const text = adapterKitFragment(KIT_APPLE_SOURCES, resolve(dir));
  if (args.includes('--check')) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      console.error(`${file} is not what this compiler's kit gives the adapter's Swift: run ns-compiled-adapter kit-fragment ${dir}`);
      process.exit(1);
    }
  } else {
    writeFileSync(file, text);
    console.log(`${file}`);
  }
} else {
  console.error(USAGE);
  process.exit(2);
}
