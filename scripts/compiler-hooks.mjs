// node --import scripts/compiler-hooks.mjs: `@nstudio/nativescript-compiler/<path>` from the compiler $NS_COMPILER names (a
// NativeScript checkout's packages/compiler) rather than the one installed in the workspace, so a test runs on the
// compiler it is given without installing it.
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PREFIX = '@nstudio/nativescript-compiler/';
// Its real path: the compiler's own modules import each other by theirs, and one module loaded under two paths is two.
const compiler = process.env.NS_COMPILER && realpathSync(process.env.NS_COMPILER);
if (compiler) {
  registerHooks({
    resolve(specifier, context, next) {
      return specifier.startsWith(PREFIX) ? { url: pathToFileURL(join(compiler, specifier.slice(PREFIX.length))).href, shortCircuit: true } : next(specifier, context);
    },
  });
}
