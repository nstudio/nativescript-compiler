#!/usr/bin/env node
// ns-compiled <app> --out <dir> [--name <Name>] [--bundle <id>] [--platform android] [--build]; --help lists every option
import { existsSync } from 'node:fs';

const published = existsSync(new URL('../dist/driver/cli.js', import.meta.url));
try {
  // The published package runs its JavaScript (dist/, compiled at pack time); a checkout runs its TypeScript.
  if (published) {
    await import('../dist/driver/cli.js');
  } else {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 23 || (major === 23 && minor < 6)) {
      console.error(`ns-compiled needs Node.js 23.6 or newer to run its TypeScript sources (this is ${process.version}); run bin/build-dist.mjs first, or use a newer Node.`);
      process.exit(1);
    }
    await import('./strip-types.js');
    await import('../src/driver/cli.ts');
  }
} catch (e) {
  // The compiler's own errors name the app's file and line; its stack is for reporting a bug in the compiler itself.
  const internal = e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError;
  if (process.env.NS_COMPILED_STACKS) console.error(e);
  else if (internal) console.error(`error: ns-compiled failed: ${e.message}\n${String(e.stack).split('\n').slice(1, 2).join('\n')}\nThis is a bug in @nstudio/nativescript-compiler: report it with the output of NS_COMPILED_STACKS=1.`);
  else console.error(`error: ${e?.message ?? e}`);
  process.exit(1);
}
