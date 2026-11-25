#!/usr/bin/env node
// ns-compiled-retrace <android project | ios project | App.app.dSYM | App.xcarchive> [trace.txt | crash.ips]: a compiled release's stack trace in source lines
//   ns-compiled-retrace --compose-mapping <android project> [out.txt]: its R8 mapping in source lines, for crash reporters
import { existsSync } from 'node:fs';

if (existsSync(new URL('../dist/tools/retrace.js', import.meta.url))) {
  await import('../dist/tools/retrace.js');
} else {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 23 || (major === 23 && minor < 6)) {
    console.error(`ns-compiled-retrace needs Node.js 23.6 or newer to run its TypeScript sources (this is ${process.version}); run bin/build-dist.mjs first, or use a newer Node.`);
    process.exit(1);
  }
  await import('./strip-types.js');
  await import('../src/tools/retrace.ts');
}
