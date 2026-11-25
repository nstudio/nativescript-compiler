import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterPackage } from '@nstudio/nativescript-compiler/adapter-api';

/** The adapter's package folder, the nearest holding a package.json: run as TypeScript or from its built dist/ alike. */
const ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
})();
const { name, version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** The package the adapter ships as. Its runtime is TypeScript, read from the package's own runtime/. */
export const PACKAGE: AdapterPackage = { name, version, root: ROOT };

/** The adapter's TypeScript compiled with an app: @angular/common's pipes and directives, @angular/forms, the Rx-based APIs. */
export const RUNTIME = join(ROOT, 'runtime');
