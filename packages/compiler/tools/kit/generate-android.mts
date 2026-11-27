/**
 * Generates kit-android's Kotlin from core's TypeScript with the NativeScript compiler, one Kotlin
 * file per core file, plus a manifest of the sources each was generated from.
 *
 *   node tools/kit/generate-android.mts [--out <dir>] [--report] [--partial] [--json <file>]
 *     [--compiler <the compiler package>] [--declarations <published @nativescript/core>] [--types-android <@nativescript/types-android>]
 *
 * --report lists every construct the compiler does not translate yet, grouped by cause, and writes nothing.
 * --partial writes what translates, leaving out each construct --report would list (the report on stderr); it fails on
 * one tools/kit/omissions.json does not list, and on a listed one that no longer occurs.
 * --json writes the report's groups and every error to a file.
 * --gradle then compiles what was written with Gradle (kit-android) and lists Kotlin's errors by kind.
 * --out defaults to the compiler's kit-android/generated/kotlin (gitignored), which kit-android builds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { android } from './modules.mts';
import { omissionProblems } from './omissions.mts';

// The NativeScript repository: core, its built declarations and typings.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const args = process.argv.slice(2);
const option = <F extends string | undefined = undefined>(name: string, fallback?: F): string | F => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : (fallback as F);
};
const rootCandidates = [option('--core-repo'), process.env.NS_CORE_REPO, repoRoot, join(repoRoot, 'core'), resolve(repoRoot, '../../NativeScript/NativeScript')].filter((c): c is string => !!c);
const root = rootCandidates.find((c) => existsSync(join(c, 'packages/core/package.json'))) ?? repoRoot;
const core = resolve(option('--core', join(root, 'packages/core')));
const compiler = resolve(option('--compiler', process.env.NS_COMPILED_COMPILER ?? resolve(import.meta.dirname, '../..')));
const out = option('--out', join(compiler, 'kit-android/generated/kotlin/org/nativescript/kit'))!;
const report = args.includes('--report');
const partial = args.includes('--partial');
const json = option('--json');
const gradle = args.includes('--gradle');
const declarations = resolve(option('--declarations', join(root, 'dist/packages/core')));
const typesAndroid = option('--types-android', option('--declarations') ? undefined : join(root, 'packages/types-android/src'));
if (!existsSync(join(compiler, 'src/kotlin/kit-gen.ts'))) throw new Error(`${compiler}: not the NativeScript compiler (--compiler or NS_COMPILED_COMPILER)`);
if (!existsSync(join(declarations, 'index.d.ts'))) throw new Error(`${declarations}: no core declarations (build core, or --declarations)`);

const { generateKotlinKit, groupByCause } = await import(join(compiler, 'src/kotlin/kit-gen.ts'));
const { formatKotlin } = await import(join(compiler, 'src/kotlin/ktfmt.ts'));
const started = Date.now();
const result = generateKotlinKit({ format: report ? undefined : (codes: string[]) => formatKotlin(codes, true), core, declarations, typesAndroid, modules: android.compile, counterparts: android.counterparts, moot: android.moot, identities: android.identities, packages: android.packages, extra: android.extra, report: report || partial, overlay: !report });
const groups = groupByCause(result.errors) as { cause: string; count: number; examples: string[] }[];
const summary = [`${result.attempted} modules attempted, ${result.translated} translated whole, ${result.files.length} Kotlin files; ${result.errors.length} constructs left out, ${groups.length} causes (${((Date.now() - started) / 1000).toFixed(1)} s)`, ...groups.map((g) => `${String(g.count).padStart(5)}  ${g.cause}\n${g.examples.map((x) => `         ${x.slice(0, 220)}`).join('\n')}`)].join('\n');
if (json) writeFileSync(json, JSON.stringify({ attempted: result.attempted, translated: result.translated, groups, errors: result.errors }, null, '\t') + '\n');
if (report) {
	console.log(summary);
	process.exit(0);
}
if (partial && result.errors.length) console.error(summary);
const omissions = partial ? omissionProblems('android', result.errors) : [];
if (omissions.length) {
	console.error(omissions.join('\n'));
	process.exit(1);
}

const version = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const files = new Map<string, string>(result.files.map((f: { name: string; code: string }) => [f.name, f.code]));
const manifest = { core: version, commit, modules: android.compile, files: Object.fromEntries(result.files.map((f: { name: string; sources: Record<string, string> }) => [f.name, f.sources])) };
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out).sort()) if (!files.has(f)) rmSync(join(out, f));
for (const [name, code] of files) writeFileSync(join(out, name), code);
writeFileSync(join(out, '..', '..', '..', '..', 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
// Kit frames of a stack trace in core's lines (the compiler's retrace).
writeFileSync(join(out, '..', '..', '..', '..', 'source-lines.json'), JSON.stringify({ package: 'org.nativescript.kit', core: version, files: result.lines }) + '\n');
console.log(`${files.size} files in ${out}`);
// The XML-free overlay (kit-overlay.ts), outside the generated sources: only an app that qualifies compiles it.
const { XML_FREE_OVERLAY, OVERLAY_FILE } = await import(join(compiler, 'src/kit/overlay.ts'));
const overlayDir = join(compiler, 'kit-android/overlays', XML_FREE_OVERLAY);
rmSync(overlayDir, { recursive: true, force: true });
mkdirSync(join(overlayDir, 'kotlin/org/nativescript/kit'), { recursive: true });
for (const f of result.overlay.files) writeFileSync(join(overlayDir, 'kotlin/org/nativescript/kit', f.name), f.code);
writeFileSync(join(overlayDir, OVERLAY_FILE), JSON.stringify({ replaces: result.overlay.files.map((f: { name: string }) => f.name), unkept: result.overlay.unkept }, null, '\t') + '\n');
console.log(`${result.overlay.files.length} overlay files in ${overlayDir}`);

if (gradle) {
	// A project of its own around kit-android, as an app's build includes it.
	const kit = join(compiler, 'kit-android');
	const project = join(tmpdir(), 'ns-kit-android-check');
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, 'settings.gradle.kts'), `pluginManagement {\n    repositories {\n        google()\n        mavenCentral()\n        gradlePluginPortal()\n    }\n}\ndependencyResolutionManagement {\n    repositories {\n        google()\n        mavenCentral()\n    }\n}\nrootProject.name = "kit-check"\ninclude(":kit")\nproject(":kit").projectDir = file(${JSON.stringify(kit)})\n`);
	writeFileSync(join(project, 'build.gradle.kts'), `plugins {\n    id("com.android.library") version "8.12.1" apply false\n    id("org.jetbrains.kotlin.android") version "2.2.20" apply false\n}\n`);
	writeFileSync(join(project, 'gradle.properties'), `org.gradle.jvmargs=-Xmx6g -Dfile.encoding=UTF-8\nkotlin.daemon.jvmargs=-Xmx6g\nandroid.useAndroidX=true\nnativescriptWidgetsAar=${join(declarations, 'platforms/android/widgets-release.aar').replace(/\\/g, '/')}\n`);
	const started = Date.now();
	const r = spawnSync(join(kit, 'gradlew'), ['-p', project, ':kit:compileReleaseKotlin', '--console=plain'], { encoding: 'utf8', maxBuffer: 1 << 30 });
	const lines = (r.stdout + r.stderr).split('\n').filter((l) => /^e: /.test(l));
	const kinds = new Map<string, string[]>();
	for (const l of lines) {
		const what = l
			.replace(/^e: (file:\/\/)?\S+?:\d+:\d+ /, '')
			.replace(/'[^']*'/g, "'…'")
			.replace(/\b\d+\b/g, 'N')
			.slice(0, 140);
		(kinds.get(what) ?? kinds.set(what, []).get(what)!).push(l.replace(/^e: (file:\/\/)?/, '').replace(out + '/', ''));
	}
	console.log(`gradle: exit ${r.status} in ${((Date.now() - started) / 1000).toFixed(0)} s, ${lines.length} Kotlin errors, ${kinds.size} kinds`);
	for (const [what, list] of [...kinds].sort((a, b) => b[1].length - a[1].length).slice(0, 60))
		console.log(
			`${String(list.length).padStart(6)}  ${what}\n${list
				.slice(0, 2)
				.map((x) => `          ${x.slice(0, 200)}`)
				.join('\n')}`,
		);
	if (!lines.length && r.status)
		console.log(
			(r.stdout + r.stderr)
				.split('\n')
				.filter((l) => /error|FAIL|What went wrong/i.test(l))
				.slice(0, 30)
				.join('\n'),
		);
	if (r.status) process.exit(r.status);
}
