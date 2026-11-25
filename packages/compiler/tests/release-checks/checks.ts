// What a file of release checks shares, the compiler's (run.ts) or a framework adapter's suite's (tests/suite.ts): its
// report, programs and translators of a build with the suite's adapter, and the folder its native checks build host
// runtimes in.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Translator as SwiftBase } from '../../src/swift/translator.ts';
import { Translator as KotlinBase } from '../../src/kotlin/translator.ts';
import { createProgram as createBase } from '../../src/program/program.ts';
import { suiteAdapter, suiteBuild } from '../suite.ts';

export class SwiftTranslator extends SwiftBase {
  constructor(...[checker, infos, files, options = {}]: ConstructorParameters<typeof SwiftBase>) {
    super(checker, infos, files, { hooks: suiteAdapter?.swift, ...suiteBuild().translation(), ...options });
  }
}
export class KotlinTranslator extends KotlinBase {
  constructor(...[checker, infos, files, options = {}]: ConstructorParameters<typeof KotlinBase>) {
    super(checker, infos, files, { hooks: suiteAdapter?.kotlin, ...suiteBuild().translation(), ...options });
  }
}

/** The compiler's createProgram, in a build of the suite's (its adapter's module rules) unless one is given. */
export function createProgram(...[roots, virtual, platform, modulesDir, plugins, declarations, replacements, overrides, aliased, appLenient, build = suiteBuild()]: Parameters<typeof createBase>): ReturnType<typeof createBase> {
  return createBase(roots, virtual, platform, modulesDir, plugins, declarations, replacements, overrides, aliased, appLenient, build);
}

// A directory of this run's own unless given, as concurrent runs would rebuild a shared one under each other.
export const nativeBuild = process.env.NS_DIFF_BUILD ?? mkdtempSync(join(tmpdir(), 'ns-release-checks-build-'));
if (!process.env.NS_DIFF_BUILD) process.on('exit', () => rmSync(nativeBuild, { recursive: true, force: true }));

let failed = 0;
export function check(ok: boolean, what: string): void {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failed++;
}
/** Failures counted elsewhere (a run of checks in a process of its own). */
export function failedElsewhere(n: number): void {
  failed += n;
}
export function finish(what = 'release checks'): never {
  console.log(failed ? `${failed} ${what} failed` : `${what} pass`);
  process.exit(failed ? 1 : 0);
}
