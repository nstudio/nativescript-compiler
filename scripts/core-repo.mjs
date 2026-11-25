// Resolves a NativeScript/NativeScript core checkout for kit generation and XML checks.
// Order: explicit path -> $NS_CORE_REPO -> ./core (CI) -> sibling ../../NativeScript/NativeScript.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function resolveCoreRepo(fromDir, explicit) {
  const candidates = [
    explicit,
    process.env.NS_CORE_REPO,
    resolve(fromDir, 'core'),
    resolve(fromDir, '..', '..', 'NativeScript', 'NativeScript'),
    resolve(fromDir, '..', 'NativeScript'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'packages', 'core', 'package.json'))) return resolve(dir);
  }
  return null;
}
