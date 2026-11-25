// kotlinc for the tests that run kit-android's Kotlin on the host JVM: $KOTLINC,
// `kotlinc` on PATH, or the compiler Gradle cached for kit-android.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const KOTLIN_VERSION = '2.2.20';

/** How to run kotlinc, and the Kotlin standard library to compile and run against. */
export function kotlinToolchain(): { compile: (argv: string[]) => { status: number | null; stderr: string; stdout: string; error?: Error }; stdlib: string } {
  const gradle = join(homedir(), '.gradle/caches/modules-2/files-2.1');
  const jar = (group: string, name: string, version: string): string | null => {
    const dir = join(gradle, group, name, version);
    if (!existsSync(dir)) return null;
    for (const h of readdirSync(dir)) for (const f of readdirSync(join(dir, h))) if (f === `${name}-${version}.jar`) return join(dir, h, f);
    return null;
  };
  const parts = (v: string) => v.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const order = (a: string, b: string) => { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
  // `upTo`: kotlin-reflect newer than the compiler needs a newer stdlib than the one pinned here.
  const newest = (group: string, name: string, upTo?: string): string | null => {
    const dir = join(gradle, group, name);
    if (!existsSync(dir)) return null;
    for (const v of readdirSync(dir).filter((v) => !upTo || order(v, upTo) <= 0).sort(order).reverse()) { const j = jar(group, name, v); if (j) return j; }
    return null;
  };
  const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', KOTLIN_VERSION) ?? newest('org.jetbrains.kotlin', 'kotlin-stdlib');
  const kotlinc = process.env.KOTLINC ?? (spawnSync('which', ['kotlinc'], { encoding: 'utf8' }).stdout.trim() || null);
  if (kotlinc) {
    const home = resolve(dirname(kotlinc), '..');
    return { compile: (argv) => spawnSync(kotlinc, argv, { encoding: 'utf8' }), stdlib: existsSync(join(home, 'lib/kotlin-stdlib.jar')) ? join(home, 'lib/kotlin-stdlib.jar') : stdlib! };
  }
  const compiler = jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', KOTLIN_VERSION);
  const classpath = [compiler, stdlib, jar('org.jetbrains.kotlin', 'kotlin-script-runtime', KOTLIN_VERSION), newest('org.jetbrains.kotlin', 'kotlin-reflect', KOTLIN_VERSION),
    jar('org.jetbrains.kotlin', 'kotlin-daemon-embeddable', KOTLIN_VERSION), newest('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'), newest('org.jetbrains', 'annotations')];
  if (classpath.some((p) => !p)) throw new Error(`no kotlinc: install Kotlin ${KOTLIN_VERSION}, set $KOTLINC, or build kit-android once so Gradle caches its compiler`);
  const cp = classpath.join(':');
  return { compile: (argv) => spawnSync('java', ['-Xss8m', '-cp', cp, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', ...argv], { encoding: 'utf8', maxBuffer: 64 << 20 }), stdlib: stdlib! };
}
