#!/usr/bin/env node
// ns-compiled-doctor [app folder] [--platform ios|android|both] [--json]: preflight check for native compilation
import { existsSync } from 'node:fs';

if (existsSync(new URL('../dist/tools/doctor.js', import.meta.url))) {
  await import('../dist/tools/doctor.js');
} else {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 23 || (major === 23 && minor < 6)) {
    console.error(`ns-compiled-doctor needs Node.js 23.6 or newer to run its TypeScript sources (this is ${process.version}); run bin/build-dist.mjs first, or use a newer Node.`);
    process.exit(1);
  }
  await import('./strip-types.js');
  await import('../src/tools/doctor.ts');
}
