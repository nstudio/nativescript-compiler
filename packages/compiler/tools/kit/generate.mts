/**
 * Generates NativeScriptKit's Swift from core's TypeScript with the
 * NativeScript compiler, one Swift file per core file, plus a manifest of the
 * sources each was generated from, and beside each framework adapter's Swift
 * what it adds to the kit's index.
 *
 *   node tools/kit/generate.mts [--out <kit>/Sources/NativeScriptKit/Core] [--check] [--report]
 *     [--compiler <the compiler package>] [--declarations <published @nativescript/core>] [--types-ios <@nativescript/types-ios>]
 *
 * --check exits non-zero when the files in --out differ from what core generates (CI).
 * --report lists every construct the compiler does not translate yet, and writes nothing.
 * --partial writes what translates, leaving out each construct --report would list (listed on stderr); it fails on one
 * tools/kit/omissions.json does not list, and on a listed one that no longer occurs.
 * The compiler is $NS_COMPILED_COMPILER or the one this file is in, and --out its
 * kit-apple's Core; the declarations are core as built (dist/packages/core) unless given.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ios } from './modules.mts';
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
if (!process.env.NS_COMPILER_ADAPTERS && existsSync(join(compiler, '../angular/package.json'))) {
	process.env.NS_COMPILER_ADAPTERS = resolve(compiler, '..');
}
const out = option('--out', join(compiler, 'kit-apple/Sources/NativeScriptKit/Core'));
const check = args.includes('--check');
const report = args.includes('--report');
const partial = args.includes('--partial');
const declarations = resolve(option('--declarations', join(root, 'dist/packages/core')));
// This repository's iOS typings, unless the declarations come with their own (published core in an app's node_modules).
const typesIos = option('--types-ios', option('--declarations') ? undefined : join(root, 'packages/types-ios/src'));
if (!existsSync(join(compiler, 'src/swift/kit-gen.ts'))) throw new Error(`${compiler}: not the NativeScript compiler (--compiler or NS_COMPILED_COMPILER)`);
if (!existsSync(join(declarations, 'index.d.ts'))) throw new Error(`${declarations}: no core declarations (build core, or --declarations)`);

/** A generated file, as kit-gen.ts gives it. */
type KitFile = { name: string; code: string; sources: Record<string, string> };
const { generateKit } = await import(join(compiler, 'src/swift/kit-gen.ts'));
const { KIT_MANIFEST_FILE, adapterRuntimeFiles, manifestFragment, manifestJSON, mergedManifest, runtimeFiles, runtimeSurface } = await import(join(compiler, 'src/kit/manifest.ts'));
const result = generateKit({ core, declarations, typesIos, modules: ios.compile, counterparts: ios.counterparts, moot: ios.moot, identities: ios.identities, packages: ios.packages, extra: ios.extra, weak: ios.weak, report: report || partial, overlay: !report });
if (partial && result.errors.length) console.error(result.errors.join('\n'));
const omissions = partial ? omissionProblems('ios', result.errors) : [];
if (omissions.length) {
	console.error(omissions.join('\n'));
	process.exit(1);
}
if (report) {
	console.log(result.errors.join('\n') || 'every listed module translates');
	process.exit(0);
}

const version = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
// `graph`: each file's initializer and the files it imports, from which an app's build keeps only the modules it reaches.
const manifest = { core: version, commit, modules: ios.compile, files: Object.fromEntries(result.files.map((f: KitFile) => [f.name, f.sources])), graph: result.graph };
const files = new Map<string, string>(result.files.map((f: KitFile) => [f.name, f.code]));
formatSwift(files);
files.set('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');
// What the kit offers translated code, which app builds read instead of the Swift: the generated part as the compiler
// wrote it, the hand-written runtime's as its Swift declares it.
const kitSources = join(compiler, 'kit-apple/Sources/NativeScriptKit');
const kitRuntime = runtimeFiles(kitSources);
const kitManifest = mergedManifest(result.declarations, runtimeSurface(kitSources, kitRuntime));
files.set(KIT_MANIFEST_FILE, manifestJSON(kitManifest) + '\n');
// An adapter's Swift compiles into the kit's module with an app of its framework: what it adds to the index, read
// with the kit's own Swift, beside it. The adapters are those $NS_COMPILER_ADAPTERS holds (adapters.ts).
const { availableAdapters, loadAdapter } = await import(join(compiler, 'src/adapters/load.ts'));
const { adapterKitOf } = await import(join(compiler, 'src/adapters/active.ts'));
const fragments = new Map<string, string>();
for (const found of availableAdapters(compiler)) {
	const dir = adapterKitOf(await loadAdapter(found)).apple;
	if (!dir) continue;
	const full = mergedManifest(result.declarations, runtimeSurface(kitSources, [...kitRuntime, ...adapterRuntimeFiles(dir)]));
	fragments.set(join(dir, KIT_MANIFEST_FILE), manifestJSON(manifestFragment(full, kitManifest, version)) + '\n');
}

/** The generated Swift laid out by the toolchain's swift-format (`swift format`), configured by kit-apple/.swift-format. */
function formatSwift(code: Map<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), 'kit-format-'));
	try {
		const names = [...code.keys()].filter((n) => n.endsWith('.swift'));
		for (const n of names) writeFileSync(join(dir, n), code.get(n)!);
		execFileSync('swift', ['format', 'format', '--in-place', '--parallel', '--configuration', join(compiler, 'kit-apple', '.swift-format'), ...names], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
		for (const n of names) code.set(n, readFileSync(join(dir, n), 'utf8'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (check) {
	// The commit a kit was generated at differs from the one checking it: compare what the sources make.
	const stale = [...files].filter(([name, code]) => name !== 'manifest.json' && (!existsSync(join(out!, name)) || readFileSync(join(out!, name), 'utf8') !== code)).map(([name]) => name);
	const extra = existsSync(out!)
		? readdirSync(out!)
				.sort()
				.filter((f) => !files.has(f))
		: [];
	stale.push(...[...fragments].filter(([file, code]) => !existsSync(file) || readFileSync(file, 'utf8') !== code).map(([file]) => file));
	if (stale.length || extra.length) {
		console.error(`the kit is not what core generates: ${[...stale, ...extra].join(', ')}`);
		process.exit(1);
	}
	process.exit(0);
}
mkdirSync(out!, { recursive: true });
for (const f of readdirSync(out!).sort()) if (!files.has(f)) rmSync(join(out!, f));
for (const [name, code] of files) writeFileSync(join(out!, name), code);
console.log(`${files.size} files in ${out}`);
for (const [file, code] of fragments) writeFileSync(file, code);
if (fragments.size) console.log(`adapters' index fragments: ${[...fragments.keys()].join(', ')}`);
// The XML-free overlay (kit-overlay.ts), outside the kit's sources: only an app that qualifies compiles it.
const { XML_FREE_OVERLAY, OVERLAY_FILE } = await import(join(compiler, 'src/kit/overlay.ts'));
const overlayDir = join(compiler, 'kit-apple/Overlays', XML_FREE_OVERLAY);
rmSync(overlayDir, { recursive: true, force: true });
mkdirSync(join(overlayDir, 'Core'), { recursive: true });
const overlayCode = new Map<string, string>(result.overlay.files.map((f: KitFile) => [f.name, f.code]));
formatSwift(overlayCode);
for (const [name, code] of overlayCode) writeFileSync(join(overlayDir, 'Core', name), code);
writeFileSync(join(overlayDir, OVERLAY_FILE), JSON.stringify({ replaces: [...overlayCode.keys()].map((n) => `Core/${n}`), graph: result.overlay.graph }, null, '\t') + '\n');
console.log(`${overlayCode.size} overlay files in ${overlayDir}`);
