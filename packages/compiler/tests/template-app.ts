#!/usr/bin/env node
// Compiles an `ns create` template app's stock source (a fixture folder holding it, with its package-lock.json) as a
// user's first `--compiled` build does: translated with this tree's compiler and core for both platforms, the iOS app
// built (Release, simulator) and the Kotlin compiled (no dex or R8); with TEMPLATE_APP_TRANSLATE_ONLY=1, translated only.
// A framework's template needs its adapter, found as an app's is ($NS_COMPILER_ADAPTERS).
//   node tests/template-app.ts <fixture> <out> [gradle args…]
// Prints "<fixture> ios: built" and "<fixture> android: compiled" (or "translated"), or FAILED with the first errors,
// and exits 1 on a failure. Needs the kits generated and dist/packages/core built (nx run compiler:kit, compiler:kit-android).
// The fixture's node_modules are installed once per package-lock.json into ~/Library/Caches/ns-regress (macOS: cp -c).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const [fixtureArg, out, ...gradleArgs] = process.argv.slice(2);
const compiler = resolve(import.meta.dirname, '..');
const root = resolve(compiler, '../..');
const fixture = fixtureArg ? resolve(fixtureArg) : '';
const name = basename(fixture);
if (!fixture || !out || !existsSync(join(fixture, 'package-lock.json'))) {
	console.log('usage: template-app.ts <fixture> <out> [gradle args…]');
	process.exit(2);
}
if (!existsSync(join(root, 'dist/packages/core'))) {
	console.log(`${name}: dist/packages/core not built`);
	process.exit(1);
}

/** Runs a command; its exit status, its output in `log` when given. */
const run = (command: string, args: string[], cwd: string, log?: string): number => {
	const r = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: log ? 'pipe' : 'inherit' });
	if (log) writeLog(log, (r.stdout ?? '') + (r.stderr ?? ''));
	return r.status ?? 1;
};
const writeLog = (file: string, text: string) => {
	mkdirSync(resolve(file, '..'), { recursive: true });
	writeFileSync(file, text);
};
const tail = (file: string, n: number) => (existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n') : '');

const caches = join(homedir(), 'Library/Caches/ns-regress');
const lock = readFileSync(join(fixture, 'package-lock.json'));
const cache = join(caches, `${name}-${createHash('sha1').update(lock).digest('hex').slice(0, 12)}`);
if (!existsSync(cache)) {
	if (existsSync(caches)) for (const d of readdirSync(caches).filter((d) => d.startsWith(`${name}-`))) rmSync(join(caches, d), { recursive: true, force: true });
	const tmp = `${cache}.tmp`;
	mkdirSync(tmp, { recursive: true });
	for (const f of ['package.json', 'package-lock.json']) cpSync(join(fixture, f), join(tmp, f));
	if (run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], tmp, join(tmp, 'npm.log'))) {
		console.log(`${name}: npm ci FAILED\n${tail(join(tmp, 'npm.log'), 5)}`);
		process.exit(1);
	}
	renameSync(tmp, cache);
}

// $OUT is kept as given, unresolved: under $TMPDIR (/var links to /private/var) the Android project's kit path is
// checked against a symlinked output folder.
const app = join(out, name, 'app');
rmSync(join(out, name), { recursive: true, force: true });
mkdirSync(app, { recursive: true });
for (const f of readdirSync(fixture).filter((f) => !['node_modules', 'platforms', 'hooks'].includes(f))) run('cp', ['-c', '-R', join(fixture, f), `${app}/`], fixture);
run('cp', ['-c', '-R', join(cache, 'node_modules'), `${app}/`], app);
mkdirSync(join(app, 'node_modules/@nstudio'), { recursive: true });
rmSync(join(app, 'node_modules/@nstudio/nativescript-compiler'), { recursive: true, force: true });
symlinkSync(compiler, join(app, 'node_modules/@nstudio/nativescript-compiler'));
run('rsync', ['-a', '--delete', `${join(root, 'dist/packages/core')}/`, `${join(app, 'node_modules/@nativescript/core')}/`], app);
const id = /id: '([^']+)'/.exec(readFileSync(join(fixture, 'nativescript.config.ts'), 'utf8'))?.[1] ?? '';

const translateOnly = !!process.env.TEMPLATE_APP_TRANSLATE_ONLY;
let failed = false;
for (const platform of ['ios', 'android'] as const) {
	const log = join(out, `${name}-${platform}.log`);
	const compileLog = join(out, `${name}-android-compile.log`);
	const build = platform === 'ios' && !translateOnly ? ['--build'] : [];
	const cli = join(app, 'node_modules/@nstudio/nativescript-compiler/src/driver/cli.ts');
	const ok =
		run(process.execPath, [cli, app, '--platform', platform, '--out', join(out, name, platform), '--name', name.replace(/-/g, ''), '--bundle', id, ...build], app, log) === 0 &&
		(platform === 'ios' || translateOnly || run(join(compiler, 'kit-android/gradlew'), ['-p', join(out, name, 'android'), ':compileReleaseKotlin', '--console=plain', '--quiet', ...gradleArgs], app, compileLog) === 0);
	if (ok) {
		console.log(`${name} ${platform}: ${translateOnly ? 'translated' : platform === 'ios' ? 'built' : 'compiled'}`);
		continue;
	}
	console.log(`${name} ${platform}: FAILED`);
	failed = true;
	const lines = [log, compileLog].filter(existsSync).flatMap((f) => readFileSync(f, 'utf8').split('\n'));
	const unique = (xs: string[]) => [...new Set(xs)];
	let errors = unique(lines.filter((l) => /^[^ ]+:[0-9]+:[0-9]+: error:|^e: |SIL verification failed|^Undefined|^ld:|What went wrong/.test(l)).map((l) => l.replace(/.*\/Sources\//, '').replace(/.*\/src\/main\/kotlin\//, '').slice(0, 250))).slice(0, 8);
	if (!errors.length) errors = (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []).filter((l) => /^Error: /.test(l)).map((l) => l.replace(/.*\/app\/src\//, 'src/').slice(0, 250)).slice(0, 4);
	if (!errors.length) errors = unique((existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []).filter((l) => /not supported|[Ee]rror/.test(l) && !l.includes('the following command failed'))).map((l) => l.slice(0, 250)).slice(0, 8);
	console.log(errors.join('\n') || tail(log, 5));
}
if (!process.env.KEEP_BUILDS) rmSync(join(out, name), { recursive: true, force: true });
process.exit(failed ? 1 : 0);
