#!/usr/bin/env node
// The checks a compiled release runs before compiling, and the tools that map
// its native output back to TypeScript, on fixed inputs:
//   node tests/release-checks/run.ts
// - preflight: every line of cases/*.ts ending in `// expect: <text>` is reported with <text>, and no other line;
// - satisfies: version ranges as the contract reads package.json's peerDependencies;
// - Kotlin diagnostics: a Gradle error in a generated file maps to its TypeScript line through source-lines.json;
// - iOS stack traces: the app image's frames, in a trace or an .ips report, through atos's output;
// - Android crash reports: R8's mapping composed with the line tables (mapping/), through R8's retrace when the SDK has it;
// - a plugin's own Java classes (plugin-java/, compiled with javac) translate as native calls without typings declaring them;
// - an app's module graph (tsconfig paths and exclude, what its entry reaches), its plugins' ES module bundles, the
//   imports and prefix header of the generated project, and native calls into a module the build has no table for.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../../src/program/program.ts';
import { preflight } from '../../src/driver/preflight.ts';
import { allRefusals, ISSUES_URL, refusalOf, REPORT_HEADER, refusalReport, type RefusalId } from '../../src/semantics/refusals.ts';
import { satisfies } from '../../src/driver/contract.ts';
import { mapKotlinDiagnostics } from '../../src/kotlin/diagnostics.ts';
import { atosBlocks, iosDebugSymbols, ipsReport, symbolicated, traceLines, TRACEABLE_SWIFT_FLAGS } from '../../src/targets/ios/retrace.ts';
import { COMPOSED, composeMapping, r8Retrace } from '../../src/targets/android/compose-mapping.ts';
import { createHash } from 'node:crypto';
import { pathAliases } from '../../src/program/app-paths.ts';
import { appImports, reachedFrom, tsconfigIncluded } from '../../src/program/app-modules.ts';
import { foldPlatform } from '../../src/program/platform.ts';
import { runtimeFile } from '../../src/plugins/resolve.ts';
import { PluginSources, verify, verifyBundle } from '../../src/plugins/source.ts';
import { unboundEnginePlugins } from '../../src/plugins/bindings.ts';
import { localFilePackages } from '../../src/targets/resources.ts';
import { reachability } from '../../src/program/reach.ts';
import { manifest, ownTypings, pluginNative, scopedImports, usedImports, xcodegenLines, type ModuleTypes } from '../../src/plugins/native-ios.ts';
import { translateModules } from '../../src/swift/app-modules.ts';
import { programClassName } from '../../src/semantics/top-names.ts';
import { componentMembersOf } from '../../src/template/plan.ts';
import { conformsTo, iosTarget, lookupMember, nativeTable, registerDeclarationModule, setEmptyTable } from '../../src/swift/native/sdk.ts';
import { SourceLines } from '../../src/program/source-lines.ts';
import { CoreKotlin } from '../../src/kotlin/core-api.ts';
import type { KotlinCore } from '../../src/kotlin/translator.ts';
import { translateKotlinModules } from '../../src/kotlin/app-modules.ts';
import { AndroidNativeAPI } from '../../src/kotlin/native/api.ts';
import { androidClassPath } from '../../src/kotlin/native/classpath.ts';
import { builtModules, iosDependencies, packageLines, productLines, type SwiftPackage } from '../../src/targets/ios/dependencies.ts';
import { corePatchRefusal } from '../../src/program/core-patches.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { kitProjectDir } from '../../src/targets/android/build.ts';
import { KIT_ANDROID } from '../../src/driver/paths.ts';
import { check, finish, KotlinTranslator as Translator, nativeBuild, SwiftTranslator } from './checks.ts';
import { buildKotlinRuntime, buildSwiftRuntime, kotlinc, kotlinStdlib, modulesDir, swiftc, swiftMain, translateKotlin, translateSwift } from '../native-build.ts';
import ts from 'typescript';
import { BuildContext } from '../../src/program/build-context.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Each section runs in a function of its own, never a bare block: this module's frame lives for the whole run and keeps
// every top-level block's locals (each a program of several hundred MB) reachable until it ends.

// ---- preflight ----
const cases = readdirSync(join(here, 'cases')).filter((f) => f.endsWith('.ts')).map((f) => join(here, 'cases', f));
for (const platform of ['ios', 'android'] as const) (() => {
  const { checker, files } = createProgram(cases, new Map(), platform, modulesDir);
  const findings = preflight(checker, files);
  for (const file of cases) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const expected = new Map(lines.flatMap((l, k) => {
      const m = /\/\/ expect: (.+)$/.exec(l);
      return m ? [[k + 1, m[1].trim()] as const] : [];
    }));
    const got = findings.filter((f) => f.file === file);
    for (const [line, text] of expected) {
      const hit = got.find((f) => f.line === line);
      check(!!hit && hit.what.includes(text) && hit.hint.length > 0, `preflight (${platform}) ${file.split('/').pop()}:${line} reports ${text}${hit ? '' : ' (not reported)'}`);
    }
    for (const f of got.filter((f) => !expected.has(f.line))) check(false, `preflight (${platform}) ${file.split('/').pop()}:${f.line} reports nothing (reported: ${f.what})`);
  }
})();

// ---- the refusal report: each refusal kind's header and suggestion ----
(() => {
  check(REPORT_HEADER === 'Constructs a compiled release does not run, with a rewrite for each:', 'the report header is the exact text');
  check(refusalReport([]) === '', 'a build with no refusals prints no refusal report');
  for (const [id, r] of Object.entries(allRefusals()) as [RefusalId, ReturnType<typeof refusalOf>][]) {
    const text = refusalReport([{ id, at: 'app/a.ts:3:7', code: 'x()' }]);
    const ok = text.includes(REPORT_HEADER) && text.includes(`${r.title} [${id}]`) && text.includes(r.suggestion) && text.includes('at app/a.ts:3:7: x()') && text.includes(ISSUES_URL) === (r.class === 'gap');
    check(ok, `the refusal report of ${id} prints the header, its title, its suggestion and its site${r.class === 'gap' ? ', and that it is a compiler gap' : ''}`);
  }
  const twice = refusalReport([{ id: 'array-hole', at: 'a.ts:1:1', code: '[, 1]' }, { id: 'proxy', at: 'b.ts:2:1', code: 'new Proxy' }, { id: 'array-hole', at: 'c.ts:3:1', code: '[1, ,]' }]);
  check(twice.split(REPORT_HEADER).length === 2 && twice.split('[array-hole]').length === 2 && twice.indexOf('c.ts:3:1') < twice.indexOf('[proxy]'), 'the refusal report prints its header once and groups the sites by kind');
  const dir = mkdtempSync(join(tmpdir(), 'wtf-'));
  try {
    const snippets: Record<string, [string, RefusalId]> = {
      hole: ['export const xs = [1, , 3];', 'array-hole'],
      args: ['export const f = function () { return arguments; };', 'function-arguments'],
      member: ["export const s = 'a'.normalize();", 'library-member'],
      proxy: ['export const p = new Proxy({}, {});', 'proxy'],
      value: ['export const L = JSON.stringify;', 'function-value'],
      klass: ['export function f(v: number) { return new (class { x = v; })(); }', 'class-expression'],
      object: ['export const c = Object(5);', 'object-call'],
      base: ['class N extends null {} export const n = N;', 'unsupported-base'],
    };
    for (const platform of ['ios', 'android'] as const) for (const [name, [code, id]] of Object.entries(snippets)) {
      const f = join(dir, `${name}.ts`);
      writeFileSync(f, code + '\n');
      const p = createProgram([f], new Map(), platform, modulesDir);
      let errors: string[];
      const build = new BuildContext();
      if (platform === 'ios') {
        const sw = new SwiftTranslator(p.checker, new Map(), p.files, { ...build.translation(), errors: [] });
        translateModules(sw, p.program, [f]);
        errors = sw.errors!;
      } else {
        const kt = new Translator(p.checker, new Map(), p.files, { ...build.translation(), core: (t) => new CoreKotlin(t), errors: [] });
        translateKotlinModules(kt, p.program, [f]);
        errors = kt.errors!;
      }
      const ids = build.refusals.sitesOf(errors.join('\n')).map((s) => s.id);
      check(ids.length === 1 && ids[0] === id && refusalReport(build.refusals.sitesOf(errors.join('\n'))).includes(refusalOf(id).suggestion), `a refusal of ${name} names its kind ${id} in the refusal report (${platform}${ids.join(',') === id ? '' : `: ${ids.join(',') || 'none'}; ${errors.join(' ').slice(0, 200)}`})`);
    }
    // A Kotlin string holds a lone surrogate; a Swift string cannot.
    const lone = join(dir, 'lone.ts');
    writeFileSync(lone, "export const s = 'a\\uD83D';\n");
    for (const platform of ['ios', 'android'] as const) {
      const p = createProgram([lone], new Map(), platform, modulesDir);
      const errors: string[] = [];
      const t = platform === 'ios' ? new SwiftTranslator(p.checker, new Map(), p.files, { errors }) : new Translator(p.checker, new Map(), p.files, { core: (k) => new CoreKotlin(k), errors });
      if (t instanceof SwiftTranslator) translateModules(t, p.program, [lone]);
      else translateKotlinModules(t, p.program, [lone]);
      const ids = t.config.refusals.sitesOf(errors.join('\n')).map((s) => s.id);
      const want = platform === 'ios' ? 'lone-surrogate' : '';
      check(ids.join(',') === want, `a string literal with a lone surrogate is ${want ? 'the declared limit lone-surrogate' : 'translated'} (${platform}${ids.join(',') === want ? '' : `: ${errors.join(' ').slice(0, 200)}`})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { checker, files } = createProgram(cases, new Map(), 'ios', modulesDir);
  const findings = preflight(checker, files);
  check(findings.length > 0 && findings.every((f) => (f.hint === refusalOf(f.id).suggestion || f.id === 'process-env' || f.id === 'undefined-constant')), 'every preflight finding names its kind, whose suggestion is its hint');
})();

// ---- version ranges ----
const ranges: [string, string, boolean][] = [
  ['3.1.2', '>=3.1.0 <4.0.0', true], ['4.0.0', '>=3.1.0 <4.0.0', false], ['4.0.0-rc.1', '>=3.1.0 <4.0.0', true],
  ['22.0.1-dev.0', '>=22.0.0 <23.0.0', true], ['2.0.0-rc.0', '>=2.0.0-rc.0 <3.0.0', true], ['2.0.0-beta.3', '>=2.0.0-rc.0 <3.0.0', false],
  ['5.55.2', '>=4.2.0 <5.0.0 || >=5.50.0 <6.0.0', true], ['5.10.0', '>=4.2.0 <5.0.0 || >=5.50.0 <6.0.0', false],
  ['0.2.5', '^0.2.4', true], ['0.3.0', '^0.2.4', false], ['9.1.9', '~9.1.3', true], ['9.2.0', '~9.1.3', false], ['9.1.3', '9.1.3', true], ['1.0.0', '*', true],
];
for (const [v, r, want] of ranges) check(satisfies(v, r) === want, `satisfies(${v}, ${r}) is ${want}`);

// ---- Kotlin diagnostics ----
const project = mkdtempSync(join(tmpdir(), 'ns-release-checks-'));
try {
  writeFileSync(join(project, 'source-lines.json'), JSON.stringify({ package: 'org.example.app', files: { 'Home.kt': [[1, '', 0], [10, '/app/src/home.ts', 7], [20, '/app/src/home.ts', 12]] } }));
  const log = [
    `e: file://${project}/src/main/kotlin/org/example/app/Home.kt:14:9 Unresolved reference 'x'.`,
    `e: file://${project}/src/main/kotlin/org/example/app/Home.kt:3:1 Syntax error.`,
    'w: file:///elsewhere/Other.kt:1:1 Unused.',
    '> Task :compileReleaseKotlin FAILED',
  ].join('\n');
  const mapped = mapKotlinDiagnostics(log, project).split('\n');
  check(mapped[0].startsWith('e: /app/src/home.ts:7: ') && mapped[0].includes('Home.kt:14:9') && mapped[0].includes("Unresolved reference 'x'."), 'a Kotlin error in a translated statement names its TypeScript line');
  check(mapped[1] === log.split('\n')[1], 'a Kotlin error in generated code with no source line is left as it is');
  check(mapped[2] === log.split('\n')[2] && mapped[3] === log.split('\n')[3], 'other lines are left as they are');
} finally {
  rmSync(project, { recursive: true, force: true });
}

// ---- Android crash reports: R8's mapping composed with the line tables ----
(() => {
  const dir = join(here, 'mapping');
  const original = readFileSync(join(dir, 'mapping.txt'), 'utf8');
  const tables = [JSON.parse(readFileSync(join(dir, 'source-lines.json'), 'utf8')), JSON.parse(readFileSync(join(dir, 'kit-source-lines.json'), 'utf8'))];
  const composed = composeMapping(original, tables);
  const lines = composed.split('\n');
  const block = (text: string, cls: string) => { const ls = text.split('\n'); const k = ls.findIndex((l) => l.startsWith(cls + ' -> ')); let e = k + 1; while (e < ls.length && /^\s|^#/.test(ls[e])) e++; return ls.slice(k, e).join('\n'); };
  const hash = /^# pg_map_hash: SHA-256 (\w+)\n/m.exec(composed)!;
  check(composed.includes(/^# pg_map_id: \w+$/m.exec(original)![0]) && hash[1] === createHash('sha256').update(composed.slice(hash.index + hash[0].length)).digest('hex') && lines.includes(COMPOSED),
    "a composed mapping keeps R8's pg_map_id, which the dex's source files carry, with its own pg_map_hash and the composed mark");
  check(['org.nativescript.kit.ErrorsKt', 'org.nativescript.kit.JSArray', 'org.nativescript.kit.JSEventLoopState', 'J.DocumentsContractApi19$$ExternalSyntheticAutoCloseableDispatcher0', 'org.nativescript.crashng.AppComponent$$ExternalSyntheticLambda0'].every((c) => block(composed, c) === block(original, c)),
    "classes no line table covers (the kit's runtime, R8's outlines and synthetic classes) are left as R8 wrote them");
  const want = [
    '# {"id":"sourceFile","fileName":"crash-demo.ts"}',
    '    6:29:java.lang.String hostInitials(org.nativescript.crashng.DemoMeeting):8:8 -> hostInitials',
    '    53:53:void kotlin.KotlinNothingValueException.<init>():127:127 -> hostInitials',
    '    53:53:java.lang.String hostInitials(org.nativescript.crashng.DemoMeeting):8 -> hostInitials',
    '    58:58:java.lang.String org.nativescript.crashng.Crash_demoKt.hostInitials(org.nativescript.crashng.DemoMeeting):8:8 -> logMeetingHosts',
    '    58:58:void logMeetingHosts():19 -> logMeetingHosts',
    '    59:59:java.lang.String org.nativescript.crashng.Crash_demoKt.hostInitials(org.nativescript.crashng.DemoMeeting):15:15 -> logMeetingHosts',
    '    59:59:void logMeetingHosts():19 -> logMeetingHosts',
  ];
  check(want.every((l) => lines.includes(l)), 'member ranges take their source lines, an inlined frame and its caller split together where either changes');
  check(block(composed, 'org.nativescript.crashng.Home') === 'org.nativescript.crashng.Home -> org.nativescript.crashng.Home:\n# {"id":"sourceFile","fileName":"home.ts"}\n    1:2:void render():4:4 -> render\n    3:4:void render():6:6 -> render',
    'a class R8 gave no source file is given one, and a range of lines is split where its source line changes');
  check(lines.includes('# {"id":"sourceFile","fileName":"person-detail.component.ts"}') && lines.includes('    1:3:void <init>():22:22 -> <init>') && lines.includes('    4:6:void <init>():0:0 -> <init>') && lines.includes('    1:3:boolean _b0$crashng_release():0:0 -> _b0$crashng_release'),
    "a class made from two files names the one most of its lines come from; generated code and the other file's lines read line 0");
  check(lines.includes('# {"id":"sourceFile","fileName":"validators.ts"}') && lines.includes('    1:4:boolean isValid(java.lang.Object):5:5 -> a'), "the kit generated from core takes core's lines from the kit's table");
  check(composeMapping(composed, tables) === composed, 'composing a composed mapping changes nothing');

  const retrace = r8Retrace();
  if (!retrace) { console.log("  (R8's retrace not found in the Android SDK: the composed mapping was checked line by line, not retraced)"); return; }
  const scratch = mkdtempSync(join(tmpdir(), 'ns-release-checks-mapping-'));
  try {
    const run = (mapping: string, trace: string) => {
      writeFileSync(join(scratch, 'mapping.txt'), mapping);
      writeFileSync(join(scratch, 'trace.txt'), trace);
      return execFileSync(retrace, [join(scratch, 'mapping.txt'), join(scratch, 'trace.txt')], { encoding: 'utf8' }).trimEnd().split('\n');
    };
    const trace = readFileSync(join(dir, 'trace.txt'), 'utf8');
    const before = run(original, trace), after = run(composed, trace);
    const frames = after.filter((l) => /^\s+at /.test(l)).map((l) => l.trim());
    check(JSON.stringify(frames) === JSON.stringify([
      'at org.nativescript.kit.ErrorsKt.jsCannotRead(Errors.kt:175)',
      'at org.nativescript.crashng.Crash_demoKt.hostInitials(crash-demo.ts:8)',
      'at org.nativescript.crashng.Crash_demoKt$logMeetingHosts$1.invoke(crash-demo.ts:19)',
      'at org.nativescript.crashng.Crash_demoKt$logMeetingHosts$1.invoke(crash-demo.ts:19)',
      'at org.nativescript.kit.JSArray.map(Array.kt:445)',
      'at org.nativescript.crashng.Crash_demoKt.logMeetingHosts(crash-demo.ts:19)',
      'at org.nativescript.crashng.AppComponent._init_$lambda$0(app.component.ts:13)',
      'at org.nativescript.kit.JSEventLoopState.listOnTimeout(Timers.kt:131)',
    ]), `R8's retrace with the composed mapping names the app's frames by .ts file and line (${frames.join(' | ')})`);
    check(before.filter((l) => /\((Errors|Array|Timers)\.kt:/.test(l)).join() === after.filter((l) => /\((Errors|Array|Timers)\.kt:/.test(l)).join() && before.length === after.length, "R8's retrace gives the kit runtime's frames as with R8's own mapping");
    const id = /^# pg_map_id: (\w+)$/m.exec(original)![1];
    const more = ['org.nativescript.crashng.Crash_demoKt.logMeetingHosts:58', 'org.nativescript.crashng.Crash_demoKt.logMeetingHosts:59', 'org.nativescript.crashng.PersonDetailComponent._b0$crashng_release:1', 'org.nativescript.kit.a.a:2']
      .map((f) => `    at ${f.replace(/:(\d+)$/, `(r8-map-id-${id}:$1)`)}`).join('\n');
    check(JSON.stringify(run(composed, `java.lang.Error\n${more}\n`).slice(1).map((l) => l.trim())) === JSON.stringify([
      'at org.nativescript.crashng.Crash_demoKt.hostInitials(crash-demo.ts:8)', 'at org.nativescript.crashng.Crash_demoKt.logMeetingHosts(crash-demo.ts:19)',
      'at org.nativescript.crashng.Crash_demoKt.hostInitials(crash-demo.ts:15)', 'at org.nativescript.crashng.Crash_demoKt.logMeetingHosts(crash-demo.ts:19)',
      'at org.nativescript.crashng.PersonDetailComponent._b0$crashng_release(person-detail.component.ts)',
      'at org.nativescript.kit.Core_types_validatorsKt.isValid(validators.ts:5)',
    ]), "R8's retrace expands a split inlined frame, and gives a line 0 frame its file alone");

    // In place, as the release build runs it after R8; ns-compiled-retrace then reads R8's own and gives what it gave before.
    const project = join(scratch, 'android'), out = join(project, 'build', 'outputs', 'mapping', 'release');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(project, 'source-lines.json'), JSON.stringify(tables[0]));
    writeFileSync(join(out, 'mapping.txt'), original);
    const bin = join(here, '..', '..', 'bin', 'ns-compiled-retrace.js');
    const retraced = () => execFileSync(process.execPath, [bin, project, join(dir, 'trace.txt')], { encoding: 'utf8' });
    const plain = retraced();
    execFileSync(process.execPath, [bin, '--compose-mapping', project]);
    const first = readFileSync(join(out, 'mapping.txt'), 'utf8');
    execFileSync(process.execPath, [bin, '--compose-mapping', project]);
    check(readFileSync(join(out, 'mapping-kotlin.txt'), 'utf8') === original && first.includes(COMPOSED) && readFileSync(join(out, 'mapping.txt'), 'utf8') === first,
      "ns-compiled-retrace --compose-mapping keeps R8's own as mapping-kotlin.txt and composes mapping.txt, once");
    check(retraced() === plain && plain.includes('(src/app/core/utils/crash-demo.ts:8)'), "ns-compiled-retrace on a composed build retraces with R8's own mapping, as before");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})();

// ---- iOS stack traces: the app image's frames through atos ----
(() => {
  const trace = [
    'Uncaught TypeError: Cannot read properties of undefined',
    '    at crashdemo.logMeetingHosts() throws -> () (crashdemo+0x119220)',
    '    at <compiled> (crashdemo+0x3a8c70)',
    '    at <compiled> (crashdemo+0x10)',
    '    at <compiled> (UIKitCore+0x1f00)',
  ].join('\n');
  const asked: number[][] = [];
  const atosOut = 'hostInitials(_:) (in crashdemo) (crash-demo.ts:8)\nlogMeetingHosts() (in crashdemo) (crash-demo.ts:19)\n\nNativeScriptKit.jsCall(_:) (in crashdemo) + 40\n\n\n\n';
  const blocks = atosBlocks(atosOut, 3);
  check(JSON.stringify(blocks) === JSON.stringify([['hostInitials(_:) (in crashdemo) (crash-demo.ts:8)', 'logMeetingHosts() (in crashdemo) (crash-demo.ts:19)'], ['NativeScriptKit.jsCall(_:) (in crashdemo) + 40'], []]), "atos -i's output splits into one block per address, an unresolved one empty");
  check(atosBlocks(atosOut, 4) === null, "atos -i's blocks that don't come out one per address are refused");
  const out = symbolicated(traceLines(trace), 'crashdemo', (addresses) => { asked.push(addresses); return blocks!; }).split('\n');
  check(asked.length === 1 && asked[0].join() === [0x10011921f, 0x1003a8c6f, 0x10000000f].join(), 'every frame of the app image goes to atos in one call, as a return address less one');
  check(out[0] === trace.split('\n')[0] && out[1] === '    at hostInitials(_:) (crash-demo.ts:8)' && out[2] === '    at logMeetingHosts() (crash-demo.ts:19)', 'a frame becomes its inlined frames with their .ts lines, innermost first');
  check(out[3] === '    at NativeScriptKit.jsCall(_:) (crashdemo+0x3a8c70)', 'a frame atos names without a line keeps its offset');
  check(out[4] === '    at <compiled> (crashdemo+0x10)' && out[5] === '    at <compiled> (UIKitCore+0x1f00)' && out.length === 6, "an unresolved frame and other images' frames are left as they are");
  const ips = ipsReport(`{"bug_type":"309"}\n${JSON.stringify({
    exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
    exceptionReason: { composed_message: `*** Terminating app due to uncaught exception 'NativeScriptFatalJSException', reason: '${trace}'` },
    usedImages: [{ name: 'crashdemo', arch: 'arm64', uuid: 'A' }, { name: 'CoreFoundation', arch: 'arm64e' }],
    lastExceptionBacktrace: [{ imageOffset: 100, imageIndex: 1, symbol: '__exceptionPreprocess' }, { imageOffset: 0x200, imageIndex: 0 }],
    faultingThread: 0, threads: [{ triggered: true, frames: [{ imageOffset: 0x300, imageIndex: 0, inline: true }, { imageOffset: 0x300, imageIndex: 0 }, { imageOffset: 0x400, imageIndex: 0 }] }],
  })}`);
  const frames = ips?.lines.filter((l) => typeof l !== 'string') ?? [];
  check(!!ips && ips.images[0].arch === 'arm64' && frames.filter((f) => f.image === 'crashdemo').map((f) => `${f.offset.toString(16)}${f.pc ? '!' : ''}`).join() === '119220,3a8c70,10,200,300!,400', "an .ips report's frames: the exception reason's, the last exception backtrace's and the crashed thread's, its first a PC, inlined ones once");
  check(ipsReport(trace) === null, 'a plain trace is not an .ips report');
  const project = mkdtempSync(join(tmpdir(), 'dsym-'));
  mkdirSync(join(project, 'App.xcodeproj'));
  for (const out of ['DerivedData/Build/Products/Debug-iphonesimulator', 'DerivedData/Build/Products/Release-iphonesimulator', 'DerivedData/Index.noindex/Release-iphonesimulator']) mkdirSync(join(project, out, 'App.app.dSYM'), { recursive: true });
  check(iosDebugSymbols(project) === join(project, 'DerivedData/Build/Products/Release-iphonesimulator/App.app.dSYM'), "a simulator build's dSYM is found under the project's DerivedData/, the Release one");
  rmSync(project, { recursive: true, force: true });
  const dir = mkdtempSync(join(tmpdir(), 'merged-'));
  try {
    const near = (n: string) => `@inline(never) public func ${n}(_ b: AnyObject) { let box = b as! Box; box.items.append("${n}"); box.items.append(String(box.items.count)); print(box.items.joined(separator: ",")) }`;
    writeFileSync(join(dir, 'main.swift'), ['final class Box { var items: [String] = [] }', near('first'), near('second'), 'first(Box()); second(Box())', ''].join('\n'));
    const merged = (flags: string[]) => {
      const built = spawnSync('xcrun', ['swiftc', '-Osize', '-lto=llvm-full', ...flags, '-o', join(dir, 'main'), join(dir, 'main.swift')], { encoding: 'utf8' });
      if (built.status !== 0) return `swiftc: ${built.stderr.slice(0, 500)}`;
      return spawnSync('nm', [join(dir, 'main')], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /Tm$/.test(l)).length;
    };
    const control = merged([]);
    const traceable = merged(TRACEABLE_SWIFT_FLAGS);
    check(control !== 0 && traceable === 0, `the app's Release Swift flags leave near-identical functions unmerged, each with its own lines (${control} merged without them, ${traceable} with)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Swift source locations ----
(() => {
  const sf = ts.createSourceFile('/app/src/home.ts', 'function f() {\n  if (ok) {\n    a();\n  }\n}\n', ts.ScriptTarget.Latest, true);
  const branch = (sf.statements[0] as ts.FunctionDeclaration).body!.statements[0] as ts.IfStatement;
  const inner = (branch.thenStatement as ts.Block).statements[0];
  const lines = new SourceLines(new Map());
  for (const outer of [SourceLines.end, lines.mark(branch)]) {
    const swift = lines.swift(`${outer}        ${lines.mark(inner)}a()`).split('\n');
    check(swift[0] === '        #sourceLocation(file: "/app/src/home.ts", line: 3)' && swift[1] === '        a()', `a statement a flattened block begins with names its own line (outer ${outer})`);
  }

  // Code on a line of its own inside a statement: a concise arrow's body, an awaited statement's continuation, a parameter's default.
  const dir = mkdtempSync(join(tmpdir(), 'ns-source-lines-'));
  try {
    const file = join(dir, 'lines.ts');
    writeFileSync(file, [
      'function f(): void {}',
      'function twice(n: number): number { return n * 2; }',
      'export function run(): void {',
      '  setTimeout(() => f(), 0);',
      '  const xs = [1].map((n) =>',
      '    twice(n));',
      '  const ys = [2].map((n) => twice(n));',
      '  console.log(xs, ys);',
      '}',
      'async function load(): Promise<number> { return 1; }',
      'export async function later(): Promise<void> {',
      "  console.log('start');",
      '',
      '  await load();',
      '  const h = async () =>',
      '    load();',
      '  h();',
      '}',
      'function scaled(n: number,',
      '  by: number = twice(n)): number {',
      '  return n * by;',
      '}',
      'run(); later(); console.log(scaled(1));',
      '',
    ].join('\n'));
    const want: [code: RegExp, line: number][] = [[/^f\(\)$/, 4], [/^return twice\(n\)$|^twice\(n\)$/, 6], [/^return twice\(n\)$|^twice\(n\)$/, 7], [/^jsAwait\(load\(\)/, 14], [/\.returnPromise\(load\(\)\)$/, 16], [/= by (\?\?|\?:) try twice\(n\)$|= by (\?\?|\?:) twice\(n\)$/, 20]];
    // The line each wanted statement is given, in the order they are written.
    const given = (lines: { code: string; line: number | null }[]) => {
      let from = 0;
      return want.map(([code]) => { const k = lines.findIndex((l, j) => j >= from && code.test(l.code.trim())); from = k + 1; return k < 0 ? null : lines[k].line; });
    };
    const expected = want.map(([, line]) => line).join();

    const swiftOut = join(dir, 'swift');
    translateSwift([file], swiftOut);
    const swift = readFileSync(join(swiftOut, readdirSync(swiftOut).find((f) => f !== '__Objects.swift')!), 'utf8').split('\n');
    const counted: { code: string; line: number | null }[] = [];
    let at: number | null = null;
    for (const l of swift) {
      const d = /^\s*#sourceLocation\((?:file: "[^"]*", line: (\d+))?\)$/.exec(l);
      if (d) { at = d[1] ? +d[1] : null; continue; }
      counted.push({ code: l, line: at });
      if (at !== null) at++;
    }
    check(given(counted).join() === expected, `Swift names the source line of code a statement puts on a line of its own (${given(counted).join()})`);
    const xs = swift.findIndex((l) => /^\s*return twice\(n\)$/.test(l));
    check(xs > 0 && !swift[xs - 1].includes('#sourceLocation'), 'Swift writes no directive where the lines since the last one already count to the line');

    const lines = new SourceLines(new Map());
    const modules = translateKotlin([file], join(dir, 'kotlin'), 'org.example.app', { sourceLines: lines });
    const table = modules.flatMap((m) => { const r = lines.kotlin(m.code); return r.code.split('\n').map((code, k) => ({ code, line: r.lines[k]?.line ?? null })); });
    check(given(table).join() === expected, `Kotlin's line table names the source line of code a statement puts on a line of its own (${given(table).join()})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- An app's own module graph ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-app-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    w('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'], '@fixtures': ['./src/fixtures/index'], '@outside/*': ['../outside/*'] } }, exclude: ['**/*.spec.ts'] }));
    const main = w('src/main.ts', "import { routes } from './app.routes';\nimport { App } from '~/app/app';\nbootstrapApplication(App, { providers: [provideRouter(routes)] });\n");
    const routes = w('src/app.routes.ts', "export const routes = [{ path: 'a', loadComponent: () => import('~/app/lazy').then((m) => m.Lazy) }, { path: 'b', loadChildren: () => import('~/app/child.routes').then((m) => m.childRoutes) }];\n");
    const child = w('src/app/child.routes.ts', "import { Lazy } from '~/app/lazy';\nexport const childRoutes = [{ path: 'c', component: Lazy }];\n");
    const app = w('src/app/app.ts', "import { helper } from './helper';\nexport class App {}\n");
    const helper = w('src/app/helper.ios.ts', 'export const helper = 2;\n');
    const lazy = w('src/app/lazy.ts', 'export class Lazy {}\n');
    const spec = w('src/app/app.spec.ts', "import { App } from './app';\nimport { stub } from '@fixtures';\n");
    const fixtures = w('src/fixtures/index.ts', 'export const stub = 0;\n');
    const test = w('src/test.ts', "import './app/app.spec';\n");
    const aliased = pathAliases(dir);
    check(aliased('~/app/app') === join(dir, 'src/app/app') && aliased('@fixtures') === fixtures.replace(/\.ts$/, '') && aliased('~/app/missing') === undefined && aliased('@outside/x') === undefined, "tsconfig paths name the app's own files, and only those");
    const files = [main, routes, child, app, helper, lazy, spec, fixtures, test];
    const reached = reachedFrom([main], appImports(files, aliased, '.ios.ts').importsOf);
    check([routes, child, app, helper, lazy].every((f) => reached.has(f)) && ![spec, fixtures, test].some((f) => reached.has(f)), "an entry reaches its modules through relative and aliased imports, lazy ones too, and no test's");
    const included = tsconfigIncluded(dir, join(dir, 'src'))!;
    check(!included.has(spec) && included.has(test) && included.has(app), "a file the app's tsconfig excludes is not one of its modules");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Imports a release build's folding leaves unused ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-side-effects-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    const pkg = (name: string, json: object, files: string[] = ['index.js']) => { w(`node_modules/${name}/package.json`, JSON.stringify({ name, ...json })); for (const f of files) w(`node_modules/${name}/${f}`, 'globalThis.ran = true;\n'); };
    pkg('@dev/inspector', { sideEffects: false });
    pkg('dev-plain', {});
    pkg('dev-listed', { main: './lib/index.js', sideEffects: ['./lib/polyfill.js', '*.css'] }, ['lib/index.js', 'lib/polyfill.js']);
    pkg('dev-entry-listed', { exports: { '.': { import: './index.mjs', require: './index.js' } }, sideEffects: ['index.mjs'] }, ['index.js', 'index.mjs']);
    const main = w('src/main.ts', [
      "import { startInspector } from '@dev/inspector';",
      "import * as plain from 'dev-plain';",
      "import listed from 'dev-listed';",
      "import { entry } from 'dev-entry-listed';",
      "import { polyfill } from 'dev-listed/lib/polyfill';",
      "import { stillUsed } from 'dev-plain/used';",
      'if (__DEV__) { startInspector(); plain.start(); listed(); entry(); polyfill(); }',
      'stillUsed();',
      '',
    ].join('\n'));
    const out = foldPlatform(readFileSync(main, 'utf8'), main, 'ios');
    const kept = (m: string) => out.includes(`'${m}'`);
    check(!kept('@dev/inspector') && !kept('dev-listed'), 'an import folding leaves unused goes where its package declares no side effects (sideEffects false, or a list missing its entry)');
    check(kept('dev-plain') && kept('dev-entry-listed') && kept('dev-listed/lib/polyfill') && kept('dev-plain/used'), 'an import folding leaves unused stays where its package may have side effects (no sideEffects, or a list naming the file), and so does a used one');
    check(out.split('\n').length === readFileSync(main, 'utf8').split('\n').length, 'dropped imports keep every line in place');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Plugins published as ES modules, and the generated project ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-esm-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    const modules = join(dir, 'node_modules');
    const pkg = join(modules, '@hk/esm');
    w('node_modules/@hk/esm/package.json', JSON.stringify({ name: '@hk/esm', version: '1.0.0', module: 'fesm2022/hk-esm.mjs', exports: { './package.json': { default: './package.json' }, '.': { types: './types/hk-esm.d.ts', default: './fesm2022/hk-esm.mjs' }, './testing': { types: './types/testing.d.ts', default: './fesm2022/hk-esm-testing.mjs' } } }));
    const sources = { a: 'export const a = 1;\n', index: "export * from './src/a';\n", generated: "/**\n * Generated bundle index. Do not edit.\n */\n\nexport * from './index';\n" };
    const bundle = w('node_modules/@hk/esm/fesm2022/hk-esm.mjs', 'const a = 1;\nexport { a };\n');
    w('node_modules/@hk/esm/fesm2022/hk-esm.mjs.map', JSON.stringify({ version: 3, file: 'hk-esm.mjs', sources: ['../../../../modules/esm/src/a.ts', '../../../../modules/esm/index.ts', '../../../../modules/esm/hk-esm.ts'], sourcesContent: [sources.a, sources.index, sources.generated], mappings: '' }));
    const testing = w('node_modules/@hk/esm/fesm2022/hk-esm-testing.mjs', 'export {};\n');
    w('checkout/modules/esm/package.json', JSON.stringify({ name: '@hk/esm' }));
    const a = w('checkout/modules/esm/src/a.ts', sources.a);
    const entry = w('checkout/modules/esm/index.ts', sources.index);
    check(runtimeFile('@hk/esm', modules, 'ios')?.file === bundle && runtimeFile('@hk/esm/testing', modules, 'ios')?.file === testing, "a package with only ES modules resolves to the file its exports name");
    const plugins = new PluginSources({ app: dir, platform: 'ios', overrides: { '@hk/esm': join(dir, 'checkout') } });
    const source = plugins.get(pkg);
    check(plugins.sourceOf(bundle) === entry, "a bundle is compiled from the entry its generated index re-exports");
    let verified = '';
    try { verifyBundle(source.name, bundle, source.bundles.get(bundle)!); } catch (e) { verified = String(e); }
    writeFileSync(a, 'export const a = 2;\n');
    let changed = '';
    try { verifyBundle(source.name, bundle, source.bundles.get(bundle)!); } catch (e) { changed = String(e); }
    check(!verified && changed.includes('was not built from its source') && changed.includes('src/a.ts'), "a bundle is checked against the sources its map embeds");
    let missing = '';
    try { plugins.sourceOf(testing); } catch (e) { missing = String(e); }
    check(missing.includes('has no TypeScript source'), "a bundle file without sources says so");

    // A plugin published as ES5 CommonJS is checked against its source lowered the same way.
    const cjsSource = 'export class Counter {\n  constructor(private start: number) {}\n  next(step = 1): number { return this.start + step; }\n}\nexport const label = (n: number) => `n${n}`;\n';
    const cjsSrc = w('cjs/src/index.ios.ts', cjsSource);
    const cjsOut = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5 } }).outputText;
    const cjsJs = w('node_modules/@hk/cjs/index.ios.js', cjsOut(cjsSource));
    let cjs = '';
    try { verify('@hk/cjs', cjsJs, cjsSrc); } catch (e) { cjs = String(e); }
    writeFileSync(cjsJs, cjsOut(cjsSource.replace('this.start + step', 'this.start - step')));
    w('patches/@hk+cjs+1.0.0.patch', '');
    let cjsChanged = '';
    try { verify('@hk/cjs', cjsJs, cjsSrc, dir, '1.0.0'); } catch (e) { cjsChanged = String(e); }
    check(!cjs && cjsChanged.includes('does not match the published') && cjsChanged.includes('patched by patches/@hk+cjs+1.0.0.patch'), `an ES5 CommonJS plugin is verified against its source, and a mismatch names the app's patch of it${cjs ? `: ${cjs.split('\n').slice(0, 4).join(' ')}` : ''}`);

    // A plugin augmenting another's module in the declarations beside its source, as firebase-messaging augments firebase-core.
    symlinkSync(join(modulesDir, '@nativescript'), join(modules, '@nativescript'));
    for (const [name, text] of [['hub', 'export class Hub { name = "hub"; }\nexport function hub() { return new Hub(); }\n'], ['ext', "import '@hk/hub';\nexport const ext = 1;\n"]]) {
      w(`node_modules/@hk/${name}/package.json`, JSON.stringify({ name: `@hk/${name}`, version: '1.0.0', main: 'index' }));
      w(`node_modules/@hk/${name}/index.ios.js`, '');
      w(`${name}/package.json`, JSON.stringify({ name: `@hk/${name}` }));
      w(`${name}/index.ios.ts`, text);
    }
    w('ext/index.d.ts', "declare module '@hk/hub' {\n  interface Hub { extended(): number }\n}\nexport declare const ext: number;\n");
    const user = w('src/hub-user.ts', "import '@hk/ext';\nimport { hub } from '@hk/hub';\nexport const n: () => number = () => hub().extended();\n");
    let augmented = '';
    try { createProgram([user], new Map(), 'ios', modules, new PluginSources({ app: dir, platform: 'ios', overrides: { '@hk/hub': join(dir, 'hub'), '@hk/ext': join(dir, 'ext') } })); } catch (e) { augmented = String(e); }
    check(!augmented, `a plugin's augmentation of another plugin's module applies to that module's source${augmented ? `: ${augmented.split('\n')[1]}` : ''}`);

    // A plugin whose platform file exports less than the declarations beside it.
    w('node_modules/@hk/decl/package.json', JSON.stringify({ name: '@hk/decl', version: '1.0.0', main: 'index' }));
    w('node_modules/@hk/decl/index.ios.js', '');
    w('node_modules/@hk/decl/index.android.js', '');
    w('decl/package.json', JSON.stringify({ name: '@hk/decl' }));
    w('decl/common.ts', "import { View } from '@nativescript/core';\nimport { Holder } from '.';\nexport interface Options { n: number }\nexport function twice(n: number) { return 2 * n; }\nexport const kind = 'decl';\nexport function attach(view: View & Holder) { view.attachHolder(1); }\nexport class Indicator { holder: View & Holder; hold(view: View) { if (view?.['attachHolder']) { this.holder = view as View & Holder; this.holder.attachHolder(2); } } }\n");
    w('decl/shapes.ts', 'export class Square { side = 1; }\n');
    w('decl/index.ios.ts', "import { Options, twice } from './common';\nfunction scale(o: Options) { return twice(o.n); }\nexport class Decl { run(o: Options): number { return scale(o); } }\nexport { attach } from './common';\n");
    w('decl/index.android.ts', "import { Options, twice } from './common';\nfunction scale(o: Options) { return twice(o.n); }\nexport class Decl { run(o: Options): number { return scale(o); } }\nexport { attach } from './common';\n");
    w('decl/index.d.ts', "import { Options } from './common';\nexport { Options };\nexport * from './shapes';\nexport { kind } from './common';\nexport interface Result { ok: boolean }\nexport interface Holder { attachHolder(n: number): void }\nexport declare function scale(o: Options): number;\nexport declare function missing(): void;\nexport declare class Decl { run(o: Options): number; }\n");
    const declUser = w('src/decl-user.ts', "import { Decl, Options, Result, Square, kind, scale, attach } from '@hk/decl';\nconst o: Options = { n: 2 };\nexport const attachTo = attach;\nexport const r: Result = { ok: new Decl().run(o) === scale(o) && new Square().side === 1 && kind === 'decl' };\n");
    let declared = '';
    try {
      const { program, checker, files } = createProgram([declUser], new Map(), 'ios', modules, new PluginSources({ app: dir, platform: 'ios', overrides: { '@hk/decl': join(dir, 'decl') } }));
      const entry = files.find((f) => f.fileName.endsWith('decl/index.ios.ts'))!;
      const names = checker.getExportsOfModule(checker.getSymbolAtLocation(entry)!).map((s) => s.name).sort().join();
      if (names !== 'Decl,Holder,Options,Result,Square,attach,kind,scale') declared = `exports ${names}`;
      const translator = new SwiftTranslator(checker, new Map(), files, { errors: [] });
      translateModules(translator, program, files.map((f) => f.fileName));
      if (translator.errors!.length) declared = translator.errors!.join('; ');
      const android = createProgram([declUser], new Map(), 'android', modules, new PluginSources({ app: dir, platform: 'android', overrides: { '@hk/decl': join(dir, 'decl') } }));
      const kotlin = new Translator(android.checker, new Map(), android.files, { core: (t) => new CoreKotlin(t), errors: [] });
      translateKotlinModules(kotlin, android.program, android.files.map((f) => f.fileName));
      if (kotlin.errors!.length) declared = kotlin.errors!.join('; ');
    } catch (e) { declared = String(e); }
    check(!declared, `a plugin's platform file exports what the declarations beside it export, values only where it has them${declared ? `: ${declared.split('\n').slice(0, 3).join(' ')}` : ''}`);

    const names = new Map<string, Set<string> | null>([['PlugA', new Set(['PlugA', 'PAView'])], ['PlugB', new Set(['PlugB', 'PBThing'])], ['Empty', new Set(['Empty'])], ['Untabled', null]]);
    const imported = usedImports('import Foundation\nimport PlugA\nimport PlugB\nimport Empty\nimport Untabled\n\nlet v = PAView()\n', names);
    check(imported === 'import Foundation\nimport PlugA\nimport Untabled\n\nlet v = PAView()\n', "a generated file imports the plugin modules it names, and those no table describes");
    const types = new Map<string, ModuleTypes>([
      ['NativeScriptKit', { types: { ImageAsset: 'class' as const, Utils: 'enum' as const }, named: new Set(['ImageAsset', 'Utils']) }],
      ['Lottie', { types: { ImageAsset: 'class' as const }, named: new Set<string>() }],
      ['RevenueCat', { types: { SubscriptionInfo: 'class' as const }, named: new Set(['SubscriptionInfo']) }],
      ['StoreKit', { types: { SubscriptionInfo: 'struct' as const, Product: 'struct' as const }, named: new Set<string>() }],
    ]);
    const scoped = scopedImports('import NativeScriptKit\nimport Lottie\nimport RevenueCat\nimport StoreKit\n\nvar a: ImageAsset? = nil\nvar s: SubscriptionInfo? = nil\nvar u = Utils.self\n', types, 'NativeScriptKit', () => false);
    check(scoped.includes('import StoreKit\nimport class NativeScriptKit.ImageAsset\nimport class RevenueCat.SubscriptionInfo\n\n') && !scoped.includes('Utils\n'), "a type name two imported modules declare is the kit's, else the one its typings name, by a scoped import");
    const reexported = scopedImports('import NativeScriptKit\nimport RevenueCat\n\n// SubscriptionInfo\nvar s: SubscriptionInfo? = nil\nlet t = s.toString()\n', types, 'NativeScriptKit', () => false);
    check(reexported.includes('import RevenueCat\nimport class RevenueCat.SubscriptionInfo\n\n'), "a type name a module the file does not import declares too (StoreKit, which RevenueCat re-exports) is named by a scoped import");
    const own = { files: new Map([[join(pkg, 'index.ios.js'), join(dir, 'checkout/packages/review/index.ios.ts')]]) } as unknown as Parameters<typeof ownTypings>[0];
    check(ownTypings(own, [join(dir, 'checkout/packages/review/types/objc!NSCReview.d.ts'), join(dir, 'checkout/packages/other/types/objc!X.d.ts')]).join() === join(dir, 'checkout/packages/review/types/objc!NSCReview.d.ts'), "a plugin's typings beside its source are its own native code's");
    const clang = { kind: 'clang', name: 'Raster', module: 'Raster', path: 'Sources/Raster', publicHeaders: 'include' } as unknown as Parameters<typeof manifest>[0][0];
    check(manifest([clang], '/out/Plugins/NSPluginsPrefix.h').includes('cSettings: [.unsafeFlags(["-include", "/out/Plugins/NSPluginsPrefix.h"])]'), "a plugin's Objective-C is compiled with the prefix header an app's own build gives it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Plugins' iOS code: Swift beside Objective-C, and the tables of their modules ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-mixed-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  const tableCache = process.env.NS_COMPILED_TABLE_CACHE;
  try {
    // As firebase-messaging-core: a module map over Objective-C, and Swift importing it.
    w('mixed/platforms/ios/src/module.modulemap', 'module HKMixedObjC {\n  umbrella header "HKMixedObjC.h"\n  export *\n}\n');
    w('mixed/platforms/ios/src/HKMixedObjC.h', '#import <Foundation/Foundation.h>\ntypedef NSString *HKMixedEvent NS_TYPED_ENUM;\ntypedef NSString *HKMixedSound NS_TYPED_EXTENSIBLE_ENUM;\nFOUNDATION_EXPORT HKMixedEvent _Nonnull const HKMixedEventStart;\n@interface HKMixedLoader : NSObject\n+ (NSString *)greeting;\n+ (NSString *)track:(HKMixedEvent)event;\n+ (NSString *)play:(HKMixedSound)sound;\n@end\n');
    w('mixed/platforms/ios/src/HKMixedLoader.m', '#import "HKMixedObjC.h"\nHKMixedEvent const HKMixedEventStart = @"start";\n@implementation HKMixedLoader\n+ (NSString *)greeting { return @"hi"; }\n+ (NSString *)track:(HKMixedEvent)event { return event; }\n+ (NSString *)play:(HKMixedSound)sound { return sound; }\n@end\n');
    w('mixed/platforms/ios/src/HKMixedHelper.swift', [
      'import UIKit', 'import HKMixedObjC', '',
      '@objc public enum HKMixedMode: Int {', '  case quiet, loud', '}', '',
      '@objc(HKMixedHelper)', 'public class HKMixedHelper: NSObject {',
      '  @objc public static func greet(_ mode: HKMixedMode) -> String { HKMixedLoader.greeting() }',
      '  @objc public static func count(_ entries: NSDictionary) -> Int { entries.count }',
      '  @objc public static func span(_ count: UInt, _ scale: Float) -> Int { Int(count) }',
      '  @_spi(Testing) @objc public static func hidden() {}', '}', '',
      '@objc public protocol HKMixedPinging {', '  func hkPing() -> Int', '}', '',
      'extension UIView: HKMixedPinging {', '  public func hkPing() -> Int { 1 }', '}', ''].join('\n'));
    w('mixed/platforms/ios/typings/objc!HKMixed.d.ts', 'declare class HKMixedHelper extends NSObject { static greet(mode: HKMixedMode): string; }\n');
    const typings = w('mixed/typings/objc!HKMixed.d.ts', 'declare const enum HKMixedMode { Quiet = 0, Loud = 1 }\ndeclare class HKMixedHelper extends NSObject { static greet(mode: HKMixedMode): string; static count(entries: NSDictionary<any, any>): number; static span(count: number, scale: number): number; }\ninterface HKMixedPinging { hkPing(): number; }\ndeclare namespace HKMixedLoader { function greeting(): string; function track(event: string): string; function play(sound: string): string; }\n');
    const constants = w('mixed/typings/objc!HKMixedObjC.d.ts', 'declare var HKMixedEventStart: string;\n');
    // Without a module map, the Objective-C module is named apart from the Swift one.
    w('nomap/platforms/ios/src/HKNoMap.h', '#import <Foundation/Foundation.h>\n@interface HKNoMap : NSObject\n@end\n');
    w('nomap/platforms/ios/src/HKNoMap.m', '#import "HKNoMap.h"\n@implementation HKNoMap\n@end\n');
    w('nomap/platforms/ios/src/HKNoMapSwift.swift', 'import Foundation\n@objc public class HKNoMapSwift: NSObject {}\n');
    // As firebase-messaging: an empty umbrella header beside Swift that imports another plugin's Objective-C.
    w('umbrella/platforms/ios/src/module.modulemap', 'module HKUmbrella {\n  umbrella header "HKUmbrella.h"\n  export *\n}\n');
    w('umbrella/platforms/ios/src/HKUmbrella.h', '');
    w('umbrella/platforms/ios/src/HKUmbrellaDelegate.swift', 'import Foundation\nimport HKMixedObjC\n@objc public class HKUmbrellaDelegate: NSObject {\n  @objc public static func greeting() -> String { HKMixedLoader.greeting() }\n}\n');
    // As ui-webview: a module map of the CLI's own framework beside Swift alone.
    w('stale/platforms/ios/src/module.modulemap', 'framework module HKStale {\n  umbrella header "HKStale.h"\n}\n');
    w('stale/platforms/ios/src/HKStale.swift', 'import Foundation\n@objc public class HKStale: NSObject {}\n');

    process.env.NS_COMPILED_TABLE_CACHE = join(dir, 'tables');
    const unread = nativeTable('NSPlugin_hk_mixed');
    if (tableCache === undefined) delete process.env.NS_COMPILED_TABLE_CACHE; else process.env.NS_COMPILED_TABLE_CACHE = tableCache;
    const cachedEmpty = (existsSync(join(dir, 'tables')) ? readdirSync(join(dir, 'tables'), { recursive: true }) as string[] : []).filter((f) => f.endsWith('.json'));
    check(!Object.keys(unread.classes).length && !cachedEmpty.length, `an SDK module the extractor cannot read is not cached as empty${cachedEmpty.length ? `: ${cachedEmpty.join()}` : ''}`);

    const source = (name: string, at: string, typings: string[] = []) => ({ name, version: '1.0.0', dir: join(dir, at), typings, files: new Map() }) as unknown as Parameters<typeof pluginNative>[0][0];
    const out = join(dir, 'project');
    let native: ReturnType<typeof pluginNative> | null = null;
    let failure = '';
    try {
      native = pluginNative([source('@hk/mixed', 'mixed', [typings, constants]), source('@hk/nomap', 'nomap'), source('@hk/umbrella', 'umbrella'), source('@hk/stale', 'stale')], out,
        { deps: { modules: [], searchArgs: () => [], classes: {}, clangModules: [], dispose: () => {} }, packages: [], declarations: [typings, constants], bindings: [], say: () => {} });
    } catch (e) { failure = String(e); }
    check(!!native && native.modules.join() === 'HKMixedObjC,NSPlugin_hk_mixed,NSPlugin_hk_nomap_ObjC,NSPlugin_hk_nomap,NSPlugin_hk_stale,NSPlugin_hk_umbrella'
      && native.package?.products.join() === 'HKMixedObjC,NSPlugin_hk_nomap_ObjC',
      `a plugin's Swift and Objective-C are modules of their own; an empty umbrella header, a module map beside Swift alone and typings are none${failure ? `: ${failure.split('\n').slice(0, 3).join(' ')}` : native ? ` (${native.modules.join()})` : ''}`);
    if (native) {
      const swift = Object.fromEntries(native.swift.map((t) => [t.name, t.products.join()]));
      check(swift.NSPlugin_hk_mixed === 'HKMixedObjC' && swift.NSPlugin_hk_umbrella === 'HKMixedObjC' && swift.NSPlugin_hk_nomap === '', `a plugin's Swift depends on the Objective-C modules it imports, another plugin's too (${JSON.stringify(swift)})`);
      const lines = xcodegenLines(native, out).targets;
      check(/ {2}NSPlugin_hk_umbrella:\n(?: {4}.*\n)*? {4}dependencies:\n {6}- package: NSPlugins\n {8}product: HKMixedObjC\n {8}link: false\n(?: {4,}.*\n)*? {8}SWIFT_INCLUDE_PATHS: "\$\(inherited\) \$\(SRCROOT\)\/Plugins\/Sources\/HKMixedObjC"\n/.test(lines),
        "the Swift module's target depends on the local package's product it imports, and finds its module map");
      const table = nativeTable('NSPlugin_hk_mixed');
      const mode = table.enums.HKMixedMode;
      check(mode?.kind === 'enum' && mode.raw === 'Int' && mode.cases.Loud?.swift === 'loud', `a Swift @objc enum is in its module's table as Objective-C names it (${JSON.stringify(mode)})`);
      check(!!table.classes.HKMixedHelper?.static.greet && !table.classes.HKMixedHelper.static.hidden, "a declaration of a Swift module's SPI is not in its table");
      check(conformsTo('UIKit', 'UIView', 'HKMixedPinging') && lookupMember('UIKit', 'UIView', 'hkPing', false)?.swift === 'hkPing', "a protocol a plugin's extension adopts is one of the extended class's");
      let longName: unknown = 'threw';
      try { longName = lookupMember('UIKit', 'UIView', 'setLongPressHK', false); } catch { /* reported below */ }
      check(longName === null, 'a member a class lacks, its name spelling `Long` as a word, is not found');
      const use = w('src/use.ios.ts', 'export const loud = HKMixedHelper.greet(HKMixedMode.Loud);\nexport const hello = HKMixedLoader.greeting();\nexport const started: string = HKMixedEventStart;\nexport const tracked = HKMixedLoader.track(HKMixedEventStart);\nexport const custom = HKMixedLoader.track(\'custom\');\nexport const played = HKMixedLoader.play(\'chime\');\nexport function counted(o: { a: number }) { return HKMixedHelper.count(o as any); }\nexport function spanned(n?: number, f?: number) { return HKMixedHelper.span(n as number, f as number); }\n');
      const { checker, program, files } = createProgram([use], new Map(), 'ios', modulesDir, undefined, [typings, constants]);
      const translator = new SwiftTranslator(checker, new Map(), files, { errors: [] });
      const code = translateModules(translator, program, [use]).map((m) => m.code).join('\n');
      check(!translator.errors!.length && /HKMixedHelper\.greet\(HKMixedMode\.loud\)/.test(code), `a Swift @objc enum's case is named as Swift names it${translator.errors!.length ? `: ${translator.errors![0]}` : ''}`);
      check(!translator.errors!.length && /hello = \(?HKMixedLoader\.greeting\(\)/.test(code), `a class method typings declare as a namespace's function is the class's${translator.errors!.length ? `: ${translator.errors![0]}` : ` (${/hello = .*/.exec(code)?.[0]})`}`);
      const [started, tracked, custom] = ['started', 'tracked', 'custom'].map((n) => new RegExp(`${n} = .*`).exec(code)?.[0]);
      check(/= HKMixedEvent\.start\.rawValue$/.test(started ?? '') && /track\(HKMixedEvent\.start\)/.test(tracked ?? '') && /track\(HKMixedEvent\(rawValue: "custom"\)\)/.test(custom ?? ''),
        `a typed string constant of a plugin's own header is the string it holds, and the constant where its type is asked (${started}; ${tracked}; ${custom})`);
      const bridgedRows = [/played = .*/, /return .*HKMixedHelper\.count\(.*/, /return .*HKMixedHelper\.span\(.*/].map((r) => r.exec(code)?.[0]);
      check(/play\(HKMixedSound\(rawValue: "chime"\)\)/.test(bridgedRows[0] ?? '') && /count\(\(jsToNativeDictionary\(o\) as NSDictionary\)\)/.test(bridgedRows[1] ?? '')
        && /span\(jsNativeInteger\(\(n \?\? \.nan\), UInt\.self\), Float\(jsNativeNumber\(\(f \?\? \.nan\)\)\)\)/.test(bridgedRows[2] ?? ''),
        `a string where a type of constants the header declares none of is taken, a script object where Swift takes NSDictionary, and numbers that may be undefined where it takes UInt and Float, as the runtime marshals them (${bridgedRows.join('; ')})`);
      // As gesturehandler: typings its native table matches also declare the plugin's own option interfaces.
      const own = w('mixed/own/hk-mixed.d.ts', 'declare class HKMixedHelper extends NSObject { static greet(mode: number): string; }\ninterface HKMixedOptions { loud?: boolean; times?: number; }\n');
      registerDeclarationModule(own, 'NSPlugin_hk_mixed');
      const opts = w('src/opts.ios.ts', 'export function options(times: number): HKMixedOptions { return { loud: true, times }; }\nexport const greeted = HKMixedHelper.greet(1);\nconsole.log(JSON.stringify(options(2)));\n');
      const p2 = createProgram([opts], new Map(), 'ios', modulesDir, undefined, [own]);
      const t2 = new SwiftTranslator(p2.checker, new Map(), p2.files, { errors: [] });
      const optsCode = translateModules(t2, p2.program, [opts]).map((m) => m.code).join('\n');
      check(!t2.errors!.length && !/HKMixedOptions\(/.test(optsCode) && /HKMixedHelper\.greet\(/.test(optsCode),
        `an interface a plugin's typings declare beside its native classes is a plain object, and the classes stay native${t2.errors!.length ? `: ${t2.errors![0]}` : ` (${/options\(.*\n.*\n/.exec(optsCode)?.[0]?.trim()})`}`);
    }
  } finally {
    if (tableCache === undefined) delete process.env.NS_COMPILED_TABLE_CACHE; else process.env.NS_COMPILED_TABLE_CACHE = tableCache;
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Swift that names another set's declarations, compiled in the app's module ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-joined-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  const tableCache = process.env.NS_COMPILED_TABLE_CACHE;
  process.env.NS_COMPILED_TABLE_CACHE = join(dir, 'tables');
  try {
    // As firebase-messaging: an empty umbrella header's module map beside Swift, which another set tests with canImport.
    w('shared/platforms/ios/src/module.modulemap', 'module HKSharedMap {\n  umbrella header "HKSharedMap.h"\n  export *\n}\n');
    w('shared/platforms/ios/src/HKSharedMap.h', '');
    w('shared/platforms/ios/src/HKShared.swift', 'import Foundation\n@objc public class HKShared: NSObject {\n  @objc static var shared = HKShared()\n}\n');
    w('tests/platforms/ios/src/HKTests.swift', 'import Foundation\n#if canImport(HKSharedMap)\nlet tested = HKShared.shared\n#endif\n@objc public class HKTests: NSObject {}\n');
    w('names/platforms/ios/src/HKNames.swift', 'import Foundation\n@objc public class HKNames: NSObject {\n  @objc public static func one() -> HKShared { HKShared.shared }\n}\n');
    w('app/App_Resources/iOS/src/HKApp.swift', 'import Foundation\nlet posted = Notification.Name("hk")\n');
    const source = (name: string, at: string) => ({ name, version: '1.0.0', dir: join(dir, at), typings: [], files: new Map() }) as unknown as Parameters<typeof pluginNative>[0][0];
    let native: ReturnType<typeof pluginNative> | null = null;
    let failure = '';
    try {
      native = pluginNative([source('@hk/shared', 'shared'), source('@hk/tests', 'tests'), source('@hk/names', 'names')], join(dir, 'project'), {
        deps: { modules: [], searchArgs: () => [], classes: {}, clangModules: [], dispose: () => {} }, packages: [], declarations: [], bindings: [], say: () => {},
        app: { module: 'HKApp', src: join(dir, 'app/App_Resources/iOS/src'), declarations: [] },
      });
    } catch (e) { failure = String(e); }
    check(!!native && native.modules.join() === 'NSPlugin_hk_tests' && !!native.appSwift,
      `Swift naming another set's declaration joins it in the app's module; Swift testing a module of that set's package with canImport keeps its own${failure ? `: ${failure.split('\n').slice(0, 3).join(' ')}` : native ? ` (${native.modules.join()})` : ''}`);
    check(!!native?.appNames.has('Notification') && !!native.appNames.has('HKShared'), "the names the app module's Swift spells are the translator's");
    const file = join(dir, 'note.ios.ts');
    writeFileSync(file, "export interface Notification {\n  title: string;\n}\nexport const note: Notification = { title: 'a' };\nexport const title = note.title;\nexport class Path {\n  render(): string { return 'own'; }\n}\n");
    const p = createProgram([file], new Map(), 'ios', modulesDir);
    const translator = new SwiftTranslator(p.checker, new Map(), p.files, { appSwiftNames: ['Notification', 'Path'], errors: [] });
    const code = translateModules(translator, p.program, [file]).map((m) => m.code).join('\n');
    check(!translator.errors!.length && /\bNotification__note_ios\b/.test(code) && !/\b(?:class|protocol|struct) Notification\b/.test(code), `a program type named as one the app module's Swift spells takes its module's name${translator.errors!.length ? `: ${translator.errors![0]}` : ''}`);
    check(programClassName(translator, 'Path') === 'Path__note_ios' && /\bclass Path__note_ios\b/.test(code), `a class templates or routes name by its TypeScript name (a component, a registered element) is built under the same rename (${programClassName(translator, 'Path')})`);
    const nav = join(dir, 'nav.d.ts');
    writeFileSync(nav, 'export declare function $navigateTo(component: any): void;\nexport declare function $showModal(component: any): Promise<unknown>;\n');
    const go = join(dir, 'go.ios.ts');
    writeFileSync(go, "import { $navigateTo, $showModal } from './nav';\nimport { Path } from './note.ios';\nexport function go(): void {\n  $navigateTo(Path);\n}\nexport function show(): void {\n  $showModal(Path);\n}\n");
    const withComponent = createProgram([file, go], new Map(), 'ios', modulesDir);
    const pathClass = withComponent.program.getSourceFile(file)!.statements.find(ts.isClassDeclaration)!;
    const navigating = new SwiftTranslator(withComponent.checker, new Map([['Path', { name: 'Path', props: [], members: componentMembersOf(pathClass, withComponent.checker) }]]), withComponent.files, { appSwiftNames: ['Notification', 'Path'], errors: [] });
    const goCode = translateModules(navigating, withComponent.program, [go]).map((m) => m.code).join('\n');
    const shown = goCode.split('\n').filter((l) => /kitNavigate|Modal\.show/.test(l)).map((l) => l.trim());
    check(shown.length === 2 && shown.every((l) => /\{ try Path__note_ios\(\)\.render_\(\) \}/.test(l)), `a navigation or a modal names a component by its class's rename and renders it through its render member, named clear of the class's own${navigating.errors!.length ? `: ${navigating.errors![0]}` : `: ${shown.join(' | ')}`}`);
  } finally {
    if (tableCache === undefined) delete process.env.NS_COMPILED_TABLE_CACHE; else process.env.NS_COMPILED_TABLE_CACHE = tableCache;
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A plugin's Swift built on its own Swift package's Clang module ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-spm-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  const tableCache = process.env.NS_COMPILED_TABLE_CACHE;
  process.env.NS_COMPILED_TABLE_CACHE = join(dir, 'tables');
  let deps: ReturnType<typeof iosDependencies> | null = null;
  try {
    // As image-cache-it over SDWebImage: everything the plugin declares is under `#if canImport` of its package's Objective-C module.
    w('package.json', JSON.stringify({ name: 'spm-app', version: '1.0.0' }));
    w('cached/pkg/Package.swift', '// swift-tools-version:5.7\nimport PackageDescription\nlet package = Package(name: "HKCPkg", platforms: [.iOS(.v13)], products: [.library(name: "HKCPkg", targets: ["HKCPkg"])], targets: [.target(name: "HKCPkg", path: "Sources/HKCPkg")])\n');
    w('cached/pkg/Sources/HKCPkg/include/HKCLoader.h', '#import <Foundation/Foundation.h>\n@interface HKCLoader : NSObject\n+ (NSInteger)answer;\n@end\n');
    w('cached/pkg/Sources/HKCPkg/HKCLoader.m', '#import "HKCLoader.h"\n@implementation HKCLoader\n+ (NSInteger)answer { return 42; }\n@end\n');
    w('cached/platforms/ios/src/HKCachedView.swift', ['import UIKit', '#if canImport(HKCPkg)', 'import HKCPkg', '',
      '@objc(HKCachedStretch)', 'public enum HKCachedStretch: Int {', '  case none, aspectFill', '}', '',
      '@objcMembers', '@objc(HKCachedView)', 'public class HKCachedView: UIView {', '  public var stretch: HKCachedStretch = .none',
      '  public static func answer() -> Int { HKCLoader.answer() }', '}', '#endif', ''].join('\n'));
    const packages: SwiftPackage[] = [{ name: 'HKCPkg', libs: ['HKCPkg'], targets: [], path: join(dir, 'cached/pkg'), plugin: '@hk/cached', pluginDir: join(dir, 'cached') }];
    deps = iosDependencies({ app: dir, packages, deploymentTarget: '17.0', say: () => {} });
    const source = { name: '@hk/cached', version: '1.0.0', dir: join(dir, 'cached'), typings: [], files: new Map() } as unknown as Parameters<typeof pluginNative>[0][0];
    // The app's project as cli.ts writes it, its Swift naming what the plugin declares as translated code does.
    const build = (owner: string | null) => {
      const out = join(dir, `project-${owner ? 'plugin' : 'app'}`);
      const declared = packages.map((p) => ({ ...p, plugin: owner }));
      const native = pluginNative([source], out, { deps: deps!, packages: declared, declarations: [], bindings: [], say: () => {} });
      const lines = xcodegenLines(native, out);
      w(`${out.slice(dir.length + 1)}/App/main.swift`, 'import UIKit\nimport NSPlugin_hk_cached\nlet view = HKCachedView()\nview.stretch = HKCachedStretch.aspectFill\nprint(HKCachedView.answer())\n');
      writeFileSync(join(out, 'project.yml'), `name: SPMCheck\noptions:\n  deploymentTarget:\n    iOS: "17.0"\npackages:\n${lines.packages}${packageLines(declared, out)}targets:\n${lines.targets}  SPMCheck:\n    type: application\n    platform: iOS\n    sources: [App]\n    dependencies:\n${lines.dependencies}${productLines(declared)}    settings:\n      base:\n        GENERATE_INFOPLIST_FILE: YES\n        CODE_SIGNING_ALLOWED: NO\n        PRODUCT_BUNDLE_IDENTIFIER: org.nativescript.spmcheck\n`);
      execFileSync('xcodegen', ['generate', '--quiet'], { cwd: out, stdio: 'ignore' });
      const r = spawnSync('xcodebuild', ['-project', 'SPMCheck.xcodeproj', '-scheme', 'SPMCheck', '-configuration', 'Release', '-destination', 'generic/platform=iOS Simulator',
        '-derivedDataPath', join(out, 'dd'), '-quiet', 'build'], { cwd: out, encoding: 'utf8', maxBuffer: 1 << 28 });
      const app = join(out, 'dd/Build/Products/Release-iphonesimulator/SPMCheck.app/SPMCheck');
      const classes = existsSync(app) ? spawnSync('nm', ['-gUj', app], { encoding: 'utf8' }).stdout : '';
      rmSync(join(out, 'dd'), { recursive: true, force: true });
      return { status: r.status, output: `${r.stdout}${r.stderr}`, classes };
    };
    const built = build('@hk/cached');
    const table = nativeTable('NSPlugin_hk_cached');
    check(!!table.classes.HKCachedView?.static.answer && table.enums.HKCachedStretch?.cases.AspectFill?.swift === 'aspectFill', "a plugin's Swift under `canImport` of its Swift package's Objective-C module is in its table");
    check(built.status === 0 && built.classes.includes('_OBJC_CLASS_$_HKCachedView') && built.classes.includes('_OBJC_CLASS_$_HKCLoader'), `a plugin's Swift on its package's Objective-C module builds what its table describes, the package linked once${built.status ? `: ${built.output.split('\n').find((l) => /error:/.test(l)) ?? ''}` : ''}`);
    // The app declaring the package too, it is the app's: the plugin's Swift stays a static library, which cannot see the module.
    const blind = build(null);
    check(blind.status !== 0 && blind.output.includes('@hk/cached: its Swift tests canImport(HKCPkg), which the build translated against, and its target cannot import HKCPkg'), "a plugin target that cannot see a module its table was extracted with fails to build, naming the module");
  } catch (e) {
    check(false, `a plugin's Swift built on its own Swift package's Clang module: ${String(e).split('\n').slice(0, 3).join(' ')}`);
  } finally {
    deps?.dispose();
    if (tableCache === undefined) delete process.env.NS_COMPILED_TABLE_CACHE; else process.env.NS_COMPILED_TABLE_CACHE = tableCache;
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- The modules a build of the Swift packages and pods leaves ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-built-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    const products = 'Build/Products/Debug-iphonesimulator';
    const maps = 'Build/Intermediates.noindex/GeneratedModuleMaps-iphonesimulator';
    w(`${maps}/CNested.modulemap`, `module CNested {\n  umbrella header "${join(dir, 'SourcePackages/checkouts/nested/Sources/CNested/include/CNested/CNested.h')}"\n  export *\n}\n`);
    w('SourcePackages/checkouts/nested/Sources/CNested/include/CNested/CNested.h', '');
    w(`${products}/CNested.o`, '');
    const own = w('SourcePackages/checkouts/hud/Sources/CHud/include/module.modulemap', 'module CHud {\n  header "CHud.h"\n  export *\n}\n');
    w(`${products}/CHud.o`, '');
    w('SourcePackages/checkouts/hud/Tests/CHudTests/module.modulemap', 'module CHudTests {}\n');
    w('SourcePackages/checkouts/unused/Sources/CUnused/include/module.modulemap', 'module CUnused {}\n');
    w(`${products}/XCFrameworkIntermediates/vendor/Vendor.framework/Modules/module.modulemap`, 'framework module Vendor {}\n');
    w(`${products}/Swifty.swiftmodule/arm64.swiftmodule`, '');
    const built = builtModules(dir);
    const arg = (a: string) => built.args.includes(a);
    check(built.clangModules.join() === 'CHud,CNested', `a build's Clang modules are known, with maps of their own or generated (${built.clangModules.join()})`);
    check(built.modules.join() === 'CHud,CNested,Swifty,Vendor', `a build's modules include a C target's with a module map of its own and a framework below the products, and no other package's (${built.modules.join()})`);
    check(arg(`-I${join(dir, 'SourcePackages/checkouts/nested/Sources/CNested/include')}`) && arg(`-fmodule-map-file=${own}`) && arg(join(dir, products, 'XCFrameworkIntermediates/vendor')),
      "a C target's public headers, a package's own module map and a nested framework's directory are visible as Xcode makes them");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Swift emission ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-native-'));
  try {
    const dts = join(dir, 'objc!HKFakeKit.d.ts');
    writeFileSync(dts, 'declare class HKThing extends NSObject { static alloc(): HKThing; initWithName(name: string): HKThing; }\n');
    const file = join(dir, 'use.ios.ts');
    writeFileSync(file, "export const thing = HKThing.alloc().initWithName('x');\n");
    setEmptyTable('HKFakeKit', 'release-checks');
    const { checker, program, files } = createProgram([file], new Map(), 'ios', modulesDir, undefined, [dts]);
    const translator = new SwiftTranslator(checker, new Map(), files, { errors: [] });
    translateModules(translator, program, [file]);
    check(translator.errors!.some((e) => e.includes('HKThing.alloc().initWithName() (HKFakeKit is a module of neither')), 'a class of a module the build has no table for is reported where it is allocated');
    const setter = join(dir, 'offset.ts');
    writeFileSync(setter, 'export class Offset {\n  x = 0;\n  get at() { return { x: this.x }; }\n  set at({ x }: { x: number }) { this.x = x; }\n}\nnew Offset().at = { x: 2 };\n');
    const typed = createProgram([setter], new Map(), 'ios', modulesDir);
    const setters = new SwiftTranslator(typed.checker, new Map(), typed.files, { errors: [] });
    const setterCode = translateModules(setters, typed.program, [setter]).map((m) => m.code).join('\n');
    check(!setters.errors!.length && /let __p0\b/.test(setterCode), `a setter destructuring its value takes it apart${setters.errors!.length ? `: ${setters.errors![0]}` : ''}`);
    const holes = join(dir, 'holes.ts');
    writeFileSync(holes, "class Card { name = 'c'; }\nconst c = new Card();\n// @ts-ignore\nexport const cards: Card[] = [c, undefined, null];\n");
    const loose = createProgram([holes], new Map(), 'ios', modulesDir);
    const looseApp = new SwiftTranslator(loose.checker, new Map(), loose.files, { lenientApp: true, errors: [] });
    translateModules(looseApp, loose.program, [holes]);
    check(looseApp.errors!.length === 1 && looseApp.errors![0].includes('null or undefined in an array of Card, whose type leaves both out'), "a non-strict app's null or undefined in an array of objects is reported, as Swift's array of them holds neither");
    // Each in a file of its own: a module's first refusal ends its translation.
    const resultCases = { found: 'export const found = [find("z")];', awaited: 'export async function main() { return [await later("z")]; }' };
    const resultFiles = Object.entries(resultCases).map(([name, line]) => {
      const f = join(dir, `results-${name}.ts`);
      writeFileSync(f, [
        "class Card { name = 'c'; }",
        "function find(name: string): Card { if (name === 'a') return new Card(); return null; }",
        "async function later(name: string): Promise<Card> { if (name === 'a') return new Card(); return null; }",
        line,
        '',
      ].join('\n'));
      return f;
    });
    const refusals = (platform: 'ios' | 'android', f: string) => {
      const p = createProgram([f], new Map(), platform, modulesDir, undefined, [], {}, { strict: false });
      if (platform === 'ios') {
        const sw = new SwiftTranslator(p.checker, new Map(), p.files, { lenientApp: true, errors: [] });
        translateModules(sw, p.program, [f]);
        return sw.errors!;
      }
      const kt = new Translator(p.checker, new Map(), p.files, { lenientApp: true, core: (t) => new CoreKotlin(t), errors: [] });
      translateKotlinModules(kt, p.program, [f]);
      return kt.errors!;
    };
    const refused = (platform: 'ios' | 'android', what: string) => {
      const errs = resultFiles.map((f) => refusals(platform, f));
      return errs.every((e) => e.length === 1 && e[0].includes(`${what} is not supported in a release build yet`)) ? '' : `: ${errs.map((e) => e.join('; ') || 'none').join(' | ')}`;
    };
    const swiftRefused = refused('ios', 'a value a non-strict function may give as null or undefined, in an array of Card');
    check(!swiftRefused, `a non-strict function's result Swift holds optional is reported in an array of objects, sync or awaited${swiftRefused}`);
    const kotlinRefused = refused('android', 'the null a non-strict function may give, in an array of Card');
    check(!kotlinRefused, `a non-strict function's null-only result is reported in a Kotlin array of objects, which reads its null as undefined, sync or awaited${kotlinRefused}`);
    const named = join(dir, 'named.ios.ts');
    writeFileSync(named, "export class ProcessInfo {\n  name = 'mine';\n}\nexport const processName = NSProcessInfo.processInfo.processName;\nexport const own = new ProcessInfo().name;\n");
    const clash = createProgram([named], new Map(), 'ios', modulesDir);
    const clashes = new SwiftTranslator(clash.checker, new Map(), clash.files);
    const clashCode = translateModules(clashes, clash.program, [named]).map((m) => m.code).join('\n');
    check(/= ProcessInfo\.processInfo\.processName/.test(clashCode) && /= ProcessInfo__named_ios\(\)\.name/.test(clashCode) && /class ProcessInfo__named_ios\b/.test(clashCode), "a program class named as a native class takes its module's name, and the native one keeps its own (ProcessInfo__named_ios beside ProcessInfo)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- SDK names Swift leaves out: their values, Swift's equivalent, or a build error naming them ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-unavailable-'));
  try {
    const file = join(dir, 'use.ios.ts');
    writeFileSync(file, [
      'export const none = UNAuthorizationOptionNone;',
      'export const actionNone = UNNotificationActionOptionNone;',
      'export const space = CGColorSpaceCreateWithName(kCGColorSpaceGenericRGB);',
      'export const color = UITextAttributeTextColor;',
      'export const dot = NSUnderlinePatternDot;',
      'export const same = CGAffineTransformEqualToTransform(CGAffineTransformIdentity, CGAffineTransformMakeScale(2, 2));',
      'export const lines = CGPathEqualToPath(CGPathCreateMutable(), CGPathCreateMutable());', ''].join('\n'));
    const { checker, program, files } = createProgram([file], new Map(), 'ios', modulesDir);
    const translator = new SwiftTranslator(checker, new Map(), files, { errors: [] });
    const code = translateModules(translator, program, [file]).map((m) => m.code).join('\n');
    const assigned = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(code)?.[1] ?? '';
    const expected: Record<string, string> = {
      none: 'UNAuthorizationOptions([])', actionNone: 'UNNotificationActionOptions([])', space: 'CGColorSpace(name: ("kCGColorSpaceGenericRGB" as CFString))',
      color: '"NSColor"', same: '(CGAffineTransform.identity == CGAffineTransform(scaleX: 2, y: 2))',
    };
    for (const [name, want] of Object.entries(expected)) check(assigned(name) === want, `an SDK name Swift leaves out is given as ${want} (${name} = ${assigned(name) || translator.errors!.join(' ')})`);
    check(/NSUnderlineStyle\(rawValue: 256\)/.test(assigned('dot')) && /__equalTo\(/.test(assigned('lines')), `a constant Swift leaves out of an option set is its value; a function Swift imports as a member stays one (${assigned('dot')}; ${assigned('lines')})`);
    const exprs = Object.keys(expected).concat('dot').map((n) => `_ = ${assigned(n)}`);
    writeFileSync(join(dir, 'check.swift'), ['import UIKit', 'import UserNotifications', ...exprs, ''].join('\n'));
    const { target, sdk } = iosTarget();
    const typed = spawnSync('xcrun', ['swiftc', '-typecheck', '-target', target, '-sdk', sdk, join(dir, 'check.swift')], { encoding: 'utf8' });
    check(typed.status === 0, `the Swift given for SDK names Swift leaves out compiles${typed.status ? `: ${typed.stderr.split('\n').find((l) => l.includes('error')) ?? typed.stderr}` : ''}`);
    const refused = join(dir, 'refused.ios.ts');
    writeFileSync(refused, 'export const callbacks = NSIntMapKeyCallBacks;\n');
    const other = createProgram([refused], new Map(), 'ios', modulesDir);
    const refusing = new SwiftTranslator(other.checker, new Map(), other.files, { errors: [] });
    translateModules(refusing, other.program, [refused]);
    check(refusing.errors!.length === 1 && refusing.errors![0].includes('NSIntMapKeyCallBacks (deprecated in iOS 2.0; APIs deprecated as of iOS 7 and earlier are unavailable in Swift, in Foundation)'),
      `an SDK constant Swift leaves out with no value to give is a build error naming it and why (${refusing.errors!.join(' ')})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Native bridging: a value of one class where an SDK API takes another, as the runtime marshals it ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-bridging-'));
  try {
    const file = join(dir, 'use.ios.ts');
    writeFileSync(file, [
      'const none: any = null;',
      "export function views(v: any, rec: Record<string, any>, a: UIView) { const d = NSDictionary.dictionaryWithObjectsForKeys([a], ['a']);",
      "  NSLayoutConstraint.constraintsWithVisualFormatOptionsMetricsViews('H:|[a]|', 0, none, v); NSLayoutConstraint.constraintsWithVisualFormatOptionsMetricsViews('H:|[a]|', 0, none, rec as any);",
      "  NSLayoutConstraint.constraintsWithVisualFormatOptionsMetricsViews('H:|[a]|', 0, none, d); }",
      'export function badge(c: UNMutableNotificationContent, n: number) { c.badge = n; c.badge = UIViewContentMode.ScaleAspectFit; }',
      "export function key(s: NSMutableAttributedString, name: any, value: any) { s.addAttributeValueRange(name, value, s.mutableString.rangeOfString('a')); }",
      "export function data(m: NSMutableData) { NSFileManager.defaultManager.createFileAtPathContentsAttributes('/tmp/x', m, none); }",
      'export function observed(name: any) { NSNotificationCenter.defaultCenter.postNotificationNameObject(name, none); }', ''].join('\n'));
    const { checker, program, files } = createProgram([file], new Map(), 'ios', modulesDir);
    const translator = new SwiftTranslator(checker, new Map(), files, { errors: [] });
    const code = translateModules(translator, program, [file]).map((m) => m.code).join('\n');
    const args = (label: string) => [...code.matchAll(new RegExp(`${label}: (.+?)(?:, \\w+: |\\)$)`, 'gm'))].map((m) => m[1]);
    const assigned = [...code.matchAll(/^\s*c\.badge = (.+)$/gm)].map((m) => m[1]);
    const want = {
      views: ['jsEntries(jsToNativeDictionary(v), String.self, Any.self)', 'jsEntries(jsToNativeDictionary(rec), String.self, Any.self)', 'jsEntries(d, String.self, Any.self)'],
      metrics: 'jsUnlessNullish(none, { jsEntries(jsToNativeDictionary($0), String.self, Any.self) })',
      badge: ['NSNumber(value: n)', 'NSNumber(value: UIView.ContentMode.scaleAspectFit.rawValue)'],
      key: 'NSAttributedString.Key(rawValue: jsToString(name))', contents: '(m as Data?)', name: 'NSNotification.Name(rawValue: jsToString(name))',
    };
    const got = { views: args('views'), metrics: args('metrics')[0], badge: assigned, key: /addAttribute\((.+?), value:/.exec(code)?.[1], contents: args('contents')[0], name: /post\(name: (.+?), object:/.exec(code)?.[1] };
    check(JSON.stringify(got) === JSON.stringify(want), `a script object, an untyped value, a number or numeric enum, a string, a mutable data are bridged where the SDK takes a typed dictionary, NSNumber, a string-backed type or Data (${JSON.stringify(got)} ${translator.errors!.join(' ')})`);
    writeFileSync(join(dir, 'check.swift'), ['import UIKit', 'import UserNotifications',
      'func jsToNativeDictionary(_ value: Any?) -> [AnyHashable: Any] { [:] }', 'func jsEntries<K: Hashable, V>(_ value: Any?, _: K.Type, _: V.Type) -> [K: V] { [:] }',
      'func jsUnlessNullish<T>(_ value: Any?, _ convert: (Any?) throws -> T) rethrows -> T? { nil }', 'func jsToString(_ v: Any?) -> String { "" }', 'func jsNativeString(_ v: Any?) -> String? { nil }',
      'let v: Any? = nil, rec: Any? = nil, none: Any? = nil, name: Any? = nil, n = 1.0, d: [AnyHashable: Any] = [:], m = NSMutableData(), c = UNMutableNotificationContent(), s = NSMutableAttributedString()',
      ...want.views.map((x) => `_ = NSLayoutConstraint.constraints(withVisualFormat: "", options: [], metrics: ${want.metrics}, views: ${x})`),
      ...want.badge.map((x) => `c.badge = ${x}`), `s.addAttribute(${want.key}, value: 1, range: NSRange())`,
      `_ = FileManager.default.createFile(atPath: "", contents: ${want.contents})`, `NotificationCenter.default.post(name: ${want.name}, object: nil)`, ''].join('\n'));
    const { target, sdk } = iosTarget();
    const typed = spawnSync('xcrun', ['swiftc', '-typecheck', '-target', target, '-sdk', sdk, join(dir, 'check.swift')], { encoding: 'utf8' });
    check(typed.status === 0, `the Swift given for native bridging compiles${typed.status ? `: ${typed.stderr.split('\n').find((l) => l.includes('error')) ?? typed.stderr}` : ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- An app patch of @nativescript/core: refused on iOS by name, switches on Android ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-core-patch-'));
  try {
    mkdirSync(join(dir, 'node_modules/@nativescript/core'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/@nativescript/core/package.json'), '{"version":"9.9.9"}');
    mkdirSync(join(dir, 'patches'));
    const patch = (file: string) => writeFileSync(join(dir, 'patches/@nativescript+core+9.9.9.patch'), `diff --git a/node_modules/@nativescript/core/${file} b/node_modules/@nativescript/core/${file}
--- a/node_modules/@nativescript/core/${file}
+++ b/node_modules/@nativescript/core/${file}
@@ -1,1 +1,1 @@
-const stops = gradient.colorStops;
+const stops = resolveGradientStopOffsets(gradient.colorStops);
`);
    patch('ui/styling/linear-gradient.js');
    const modules = join(dir, 'node_modules');
    const refusal = corePatchRefusal(dir, modules, 'ios');
    check(refusal === 'an app patch of @nativescript/core is not supported in an iOS release build yet: patches/@nativescript+core+9.9.9.patch (resolvedGradientStops)', `an app patch of core stops the iOS build, naming it (${refusal})`);
    const android = corePatchRefusal(dir, modules, 'android');
    check(android === 'an app patch of @nativescript/core is not supported in an Android release build yet: patches/@nativescript+core+9.9.9.patch (resolvedGradientStops)', `the same patch stops the Android build, naming it (${android})`);
    patch('ui/styling/background.android.js');
    check(corePatchRefusal(dir, modules, 'ios') === null, 'an Android-only hunk does not stop the iOS build');
    check(corePatchRefusal(dir, modules, 'android') !== null, 'and stops the Android build');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Top-level names the kit declares too ----
(() => {
  // ui-chart's `Utils` namespace in the app's one package would hide kit-android's `Utils` from every file.
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-names-'));
  try {
    writeFileSync(join(dir, 'charting.ts'), 'export namespace Utils {\n  export function scaled(n: number): number {\n    return n * 2;\n  }\n}\nexport enum Trace {\n  Off,\n  On,\n}\n');
    writeFileSync(join(dir, 'theme.ts'), 'export interface Page {\n  title: string;\n}\n');
    const app = join(dir, 'app.ts');
    writeFileSync(app, "import { Trace, Utils } from './charting';\nimport { Page } from './theme';\nconst page: Page = { title: 'home' };\nconsole.log(Utils.scaled(2), Trace.On, page.title);\n");
    const { checker, program } = createProgram([app], new Map(), 'android', modulesDir);
    const all = program.getSourceFiles().filter((f) => !f.isDeclarationFile);
    const kit = new Set(['Utils', 'Trace', 'Page']);
    const core = { has: (n: string) => kit.has(n), isKitView: () => false, kitMember: () => null, isKitMethod: () => false, nativeClassOf: () => null, type: () => null, property: () => null, lvalue: () => null, call: () => null, construct: () => null, assign: () => null, augmentedRead: () => null } as unknown as KotlinCore;
    const translator = new Translator(checker, new Map(), all, { pluginFiles: [join(dir, 'charting.ts')], appModule: 'org.example.app', core: () => core });
    const code = translateKotlinModules(translator, program, all.map((f) => f.fileName)).map((m) => m.code).join('\n') + translator.interfacesOf(join(dir, 'theme.ts'));
    check(/^object Utils__charting \{/m.test(code) && /^object Trace__charting \{/m.test(code) && /Utils__charting\.scaled\(2\.0\), Trace__charting\.On/.test(code) && !/^object (Utils|Trace) /m.test(code), "a plugin's namespace and enum named as kit-android's take their module's name (Kotlin)");
    check(/^class Page__theme\(/m.test(code) && /val page: Page__theme = Page__theme\(title = "home"\)/.test(code), "an app's interface named as a kit-android class takes its module's name, its literals too (Kotlin)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A plugin's own Java classes ----
(() => {
  const dir = join(here, 'plugin-java');
  const out = mkdtempSync(join(tmpdir(), 'ns-release-checks-java-'));
  try {
    const javac = spawnSync('javac', ['-d', join(out, 'classes'), join(dir, 'com/example/peek/Peeker.java')], { encoding: 'utf8' });
    const jar = spawnSync('jar', ['cf', join(out, 'plugin.jar'), '-C', join(out, 'classes'), '.'], { encoding: 'utf8' });
    if (javac.status !== 0 || jar.status !== 0) throw new Error(`javac: ${javac.stderr}${jar.stderr}`);
    const file = join(dir, 'index.android.ts');
    // Type-checked as a plugin's source is: not as strictly as the app's.
    const plugin = { all: () => [{ root: dir }] } as unknown as Parameters<typeof createProgram>[4];
    const { checker, program, files } = createProgram([file], new Map(), 'android', modulesDir, plugin);
    const translator = new Translator(checker, new Map(), files, { pluginFiles: [file], appModule: 'org.example.app', native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [join(out, 'plugin.jar')], dependencies: [] })) });
    const code = translateKotlinModules(translator, program, [file]).map((m) => m.code).join('\n');
    check(/= com\.example\.peek\.Peeker\(\)/.test(code) && !/jsGet\(com\b/.test(code), "a plugin's Java class its typings lack is made with its constructor, found on the classpath");
    check(/com\.example\.peek\.Peeker\.twice\(/.test(code), "a plugin's Java class its typings lack has its static methods called directly");
    // Native bridging's number rows, as Java takes an int, a long and a float.
    const numbers = join(out, 'numbers.android.ts');
    writeFileSync(numbers, 'export function hex(n?: number, v?: any, f?: number) {\n  return java.lang.Integer.toHexString(n as number) + java.lang.Long.toHexString(v) + java.lang.Float.floatToIntBits(f as number);\n}\n');
    const p2 = createProgram([numbers], new Map(), 'android', modulesDir);
    const t2 = new Translator(p2.checker, new Map(), p2.files, { appModule: 'org.example.app', native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [], dependencies: [] })) });
    const hex = /return (.*)/.exec(translateKotlinModules(t2, p2.program, [numbers]).map((m) => m.code).join('\n'))?.[1] ?? '';
    check(hex === 'java.lang.Integer.toHexString((n ?: Double.NaN).toLong().toInt()) + java.lang.Long.toHexString(jsToNumber(v).toLong()) + js(java.lang.Float.floatToIntBits((f ?: Double.NaN).toFloat()).toDouble())', `a number that may be undefined or untyped where Java takes an int, a long or a float: ToNumber of it, an integer through a Long (${hex})`);
    // A function value implementing a Java method that returns an int: its result as Java takes it.
    const values = join(out, 'values.android.ts');
    writeFileSync(values, 'export function rank(): number {\n  const typed = (other: string): number => other.length;\n  const untyped = (other: string): any => other.length;\n  return new java.lang.Comparable<string>({ compareTo: typed }).compareTo("ab") + new java.lang.Comparable<string>({ compareTo: untyped }).compareTo("abc");\n}\n');
    const p3 = createProgram([values], new Map(), 'android', modulesDir);
    const t3 = new Translator(p3.checker, new Map(), p3.files, { appModule: 'org.example.app', native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [], dependencies: [] })) });
    const returns = [...translateKotlinModules(t3, p3.program, [values]).map((m) => m.code).join('\n').matchAll(/return (\S*__result\S*)/g)].map((m) => m[1]);
    // `android` in Kotlin: a type's qualifier is always the package; an expression's is a member named `android` first.
    const rooted = join(out, 'rooted.android.ts');
    writeFileSync(rooted, "export function spec(size: number): number {\n  return android.view.View.MeasureSpec.makeMeasureSpec(size, android.view.View.MeasureSpec.EXACTLY);\n}\nexport class Box {\n  android = 'box';\n  label: android.widget.TextView | null = null;\n  make(context: android.content.Context): android.widget.TextView {\n    return new android.widget.TextView(context);\n  }\n}\n");
    const p4 = createProgram([rooted], new Map(), 'android', modulesDir);
    const t4 = new Translator(p4.checker, new Map(), p4.files, { appModule: 'org.example.app', native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [], dependencies: [] })) });
    const rootedCode = translateKotlinModules(t4, p4.program, [rooted]).map((m) => m.code).join('\n');
    check(/return android\.view\.View\.MeasureSpec\.makeMeasureSpec\(/.test(rootedCode) && /: android\.widget\.TextView\?/.test(rootedCode) && /_root_ide_package_\.android\.widget\.TextView\(/.test(rootedCode),
      `a Java class of package android: plain outside a class with an android member and as a type, rooted in an expression inside one (${rootedCode.match(/.*android\.widget\.TextView\(.*/)?.[0]?.trim()})`);
    check(returns.join(' ') === '__result.toLong().toInt() jsToNumber(__result).toLong().toInt()',`a function value implementing a Java method returning an int: its number, or ToNumber of its untyped result, as an int (${returns.join(' ')})`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
})();

// ---- An own value for a class's method (Kotlin) ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-own-method-'));
  try {
    const translate = (source: string) => {
      const file = join(dir, 'store.ts');
      writeFileSync(file, source);
      const kt = createProgram([file], new Map(), 'android', modulesDir);
      const ktTranslator = new Translator(kt.checker, new Map(), kt.files, { appModule: 'org.example.app' });
      try { translateKotlinModules(ktTranslator, kt.program, [file]); return ''; } catch (e) { return String(e); }
    };
    const store = 'export class Store { dispatch(a: string): number { return a.length; } static make(): Store { return new Store(); } }\nexport const s = new Store();\n';
    check(!translate(store + 's.dispatch = (a: string) => -1;\n'), "an instance is given its own function for a class method on Android");
    check(translate(store + 'Store.make = () => s;\n').includes("giving Store.make a value in place of the class's static method is not supported in a release build yet"), "a class given its own function for a static method stops the Android build");
    check(!translate(store + "export const o = { f(): number { return 1; } };\no.f = () => 2;\n"), "an object literal's method is replaced on Android");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A module variable a directory's typings declare (`ui/core/view/index.d.ts`) and one of its modules defines ----
{
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-directory-member-'));
  try {
    const file = join(dir, 'enabled.ts');
    writeFileSync(file, `import { isEnabledProperty } from '@nativescript/core/ui/core/view';\nexport const enabledName = isEnabledProperty.name;\n`);
    const sw = createProgram([file], new Map(), 'ios', modulesDir);
    const swift = new SwiftTranslator(sw.checker, new Map(), sw.files, { errors: [] });
    const code = translateModules(swift, sw.program, [file]).map((m) => m.code).join('\n');
    check(!swift.errors!.length && code.includes('Core_ui_core_view_view_common.isEnabledProperty'), `a variable ui/core/view's typings declare is view-common's in the kit${swift.errors!.length || !code.includes('Core_ui_core_view_view_common') ? `: ${swift.errors!.join(' ') || code.split('\n').find((l) => l.includes('isEnabledProperty'))}` : ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Core members a kit class leaves to each object; a kit method called past its overrides ----
{
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-own-members-'));
  try {
    const file = join(dir, 'custom.ts');
    writeFileSync(file, `
import { EventData, Observable, PageTransition, Transition, View } from '@nativescript/core';

export class StepTransition extends Transition {
  remember(controller: any, from: any, to: any): any {
    this.transitionController = controller;
    this.presented = to;
    this.presenting = from;
    return this.transitionController;
  }
}

export function tag(t: PageTransition, other: Transition): string {
  t.name = 'launch';
  return t.name + (other.name ?? '');
}

export class Plot extends View {
  addEventListener(name: string, callback: (data: EventData) => void, thisArg?: any) {
    if (name === 'tap') Observable.prototype.addEventListener.call(this, name, callback, thisArg);
    else super.addEventListener(name, callback, thisArg);
  }
  removeEventListener(name: string, callback?: (data: EventData) => void, thisArg?: any) {
    Observable.prototype.removeEventListener.apply(this, [name, callback, thisArg]);
  }
}
`);
    const sw = createProgram([file], new Map(), 'ios', modulesDir);
    const swift = new SwiftTranslator(sw.checker, new Map(), sw.files, { errors: [] });
    const swCode = translateModules(swift, sw.program, [file]).map((m) => m.code).join('\n');
    const kt = createProgram([file], new Map(), 'android', modulesDir);
    const kotlin = new Translator(kt.checker, new Map(), kt.files, { core: (t) => new CoreKotlin(t), appModule: 'org.example.app', errors: [] });
    const ktCode = translateKotlinModules(kotlin, kt.program, [file]).map((m) => m.code).join('\n');
    check(!swift.errors!.length && swCode.includes('self[jsKey: "presented"] = to') && swCode.includes('return self[jsKey: "transitionController"]') && swCode.includes('t[jsKey: "name"] = "launch"'),
      `a property core's typings declare and the kit's class leaves to each object is the object's own (Swift)${swift.errors!.length ? `: ${swift.errors![0]}` : ''}`);
    check(!kotlin.errors!.length && ktCode.includes('this.jsSet("presented", to)') && ktCode.includes('this.jsGet("transitionController")') && ktCode.includes('t.jsSet("name", "launch")'),
      `a property core's typings declare and the kit's class leaves to each object is the object's own (Kotlin)${kotlin.errors!.length ? `: ${kotlin.errors![0]}` : ''}`);
    check(/self\.addEventListener__Observable\(name, /.test(swCode) && /self\.removeEventListener__Observable\(name, /.test(swCode), "Observable.prototype.m.call(this, …) in a view calls Observable's own m, past View's override (Swift)");
    check(/this\.addEventListener__Observable\(name, /.test(ktCode) && /this\.removeEventListener__Observable\(name, /.test(ktCode), "Observable.prototype.m.call(this, …) in a view calls Observable's own m, past View's override (Kotlin)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- A constant object core exports (`Dialogs`, `Device`), called and read through ----
{
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-held-object-'));
  try {
    const file = join(dir, 'agenda.ts');
    writeFileSync(file, `
import { Device, Dialogs } from '@nativescript/core';

export async function raise(): Promise<string> {
  const result = await Dialogs.prompt({ title: 'Raise it', message: 'm', okButtonText: 'Draft', cancelButtonText: 'Cancel', defaultText: '' });
  const named = await Dialogs.prompt('Name?', 'anon');
  const ok = await Dialogs.confirm({ title: 't', message: 'm', okButtonText: 'ok' });
  const title = result.result && result.text?.trim();
  return (title || named.text) + ok + Device.model;
}
`);
    const sw = createProgram([file], new Map(), 'ios', modulesDir);
    const swift = new SwiftTranslator(sw.checker, new Map(), sw.files, { errors: [] });
    const swCode = translateModules(swift, sw.program, [file]).map((m) => m.code).join('\n');
    const kt = createProgram([file], new Map(), 'android', modulesDir);
    const kotlin = new Translator(kt.checker, new Map(), kt.files, { core: (t) => new CoreKotlin(t), appModule: 'org.example.app', errors: [] });
    const ktCode = translateKotlinModules(kotlin, kt.program, [file]).map((m) => m.code).join('\n');
    check(!swift.errors!.length && swCode.includes('jsCallable(Dialogs.prompt, "Dialogs.prompt")(JSArray<Any?>([JSObject(') && swCode.includes('jsCallable(Dialogs.prompt, "Dialogs.prompt")(JSArray<Any?>(["Name?", "anon"]))')
      && swCode.includes('jsCallable(Dialogs.confirm, "Dialogs.confirm")(JSObject(') && swCode.includes('jsUnwrap(Device, "model").model') && !/jsCallMethod\(Dialogs|jsGet\(Device/.test(swCode),
      `a function or value of an object core exports is the kit's object's own, called with its rest parameter's arguments as one array (Swift)${swift.errors!.length ? `: ${swift.errors![0]}` : ''}`);
    check(!kotlin.errors!.length && ktCode.includes('Core_ui_dialogs_index.prompt(jsArrayOf<Any?>(jsObjectOf(') && ktCode.includes('Device.model') && !/jsCallMethod\(Dialogs|jsGet\(Device/.test(ktCode),
      `a function or value of an object core exports is the kit's own (Kotlin)${kotlin.errors!.length ? `: ${kotlin.errors![0]}` : ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Core's result interfaces (`PromptResult`, `Size`): the kit's classes, read by member ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-result-shapes-'));
  try {
    const file = join(dir, 'agenda.ts');
    writeFileSync(file, `
import { Dialogs, PromptResult, View } from '@nativescript/core';

export async function raise(view: View, given: any): Promise<string> {
  const result = await Dialogs.prompt({ title: 'Raise it', message: 'm', okButtonText: 'Draft', cancelButtonText: 'Cancel', defaultText: '' });
  const login = await Dialogs.login({ title: 't', message: 'm', okButtonText: 'ok', cancelButtonText: 'c', userName: '', password: '' });
  const { width, height } = view.getActualSize();
  const at = view.getLocationInWindow();
  const own: PromptResult = { result: true, text: 'x' };
  const held: PromptResult = given;
  const title = result.result && result.text?.trim();
  return title + login.userName + width + height + view.getActualSize().width + at.x + own.text + held.text;
}
`);
    const sw = createProgram([file], new Map(), 'ios', modulesDir);
    const swift = new SwiftTranslator(sw.checker, new Map(), sw.files, { errors: [] });
    const swCode = translateModules(swift, sw.program, [file]).map((m) => m.code).join('\n');
    const kt = createProgram([file], new Map(), 'android', modulesDir);
    const kotlin = new Translator(kt.checker, new Map(), kt.files, { core: (t) => new CoreKotlin(t), appModule: 'org.example.app', errors: [] });
    const ktCode = translateKotlinModules(kotlin, kt.program, [file]).map((m) => m.code).join('\n');
    check(!swift.errors!.length && ['(__t_1: PromptResult)', 'let __v_1 = result.result', 'jsTrim(result.text)', '(__t_2: LoginResult)', 'login.userName', 'try jsDestructured(view.getActualSize(), "width")',
      'jsUnwrap(view.getActualSize(), "width").width', 'let at: Point? =', 'jsUnwrap(at, "x").x', 'PromptResult(result: true, text: "x")', '(jsFlat($0) as? PromptResult) ?? PromptResult.jsView($0)'].every((x) => swCode.includes(x))
      && /__d_\d+\.width/.test(swCode) && !/jsGet\(|jsCallMethod\(/.test(swCode),
      `what core's result interfaces give back is the kit's class, its fields read by member; an untyped object of one is viewed as it (Swift)${swift.errors!.length ? `: ${swift.errors![0]}` : ''}`);
    check(!kotlin.errors!.length && ['(__t_1: PromptResult)', 'jsAnd(result.result)', 'jsTrim(result.text)', '(__t_2: LoginResult)', 'login.userName', '(view.getActualSize() ?: jsObjectRequired())',
      '(view.getActualSize() ?: jsCannotRead("width")).width', 'val at: Point? =', '(at ?: jsCannotRead("x")).x', 'PromptResult(result = true, text = "x")', 'PromptResult.jsView(given)'].every((x) => ktCode.includes(x))
      && /__d_\d+\.width/.test(ktCode) && !/jsGet\(|jsCallMethod\(/.test(ktCode),
      `what core's result interfaces give back is the kit's class, its fields read by member; an untyped object of one is viewed as it (Kotlin)${kotlin.errors!.length ? `: ${kotlin.errors![0]}` : ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- The kit's classes of core's result interfaces, as script's objects: keys, JSON, `in`, spread, added keys, views ----
(() => {
  // The classes as the kit generates them; app code reads them as the translator writes it.
  const classOf = (file: string, head: RegExp) => {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const at = text.search(head);
    return at < 0 ? null : text.slice(at, text.indexOf('\n}\n', at) + 3);
  };
  const swiftKit = join(here, '../../kit-apple/Sources/NativeScriptKit/Core');
  const kotlinKit = join(KIT_ANDROID, 'generated/kotlin/org/nativescript/kit');
  const swiftClasses = [classOf(join(swiftKit, 'ui.dialogs.dialogs-common.swift'), /^public final class PromptResult\b/m), classOf(join(swiftKit, 'ui.core.view.view-interfaces.swift'), /^public final class Size\b/m)];
  const kotlinClasses = [classOf(join(kotlinKit, 'ui_dialogs_dialogs_common.kt'), /^class PromptResult\b/m), classOf(join(kotlinKit, 'ui_core_view_view_interfaces.kt'), /^class Size\b/m)];
  if (swiftClasses.includes(null) || kotlinClasses.includes(null)) {
    check(false, "the kit generated from core has classes of its result interfaces (PromptResult, Size): generate the kits first");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-result-objects-'));
  const file = join(dir, 'show.ts');
  writeFileSync(file, `
import type { PromptResult, Size } from '@nativescript/core';

export function show(r: PromptResult, s: Size, raw: any): void {
  console.log(Object.keys(r).join(','), JSON.stringify(r), 'result' in r, String(r.result), r.text);
  const { result, text } = r;
  console.log(result === undefined, r.result === undefined, text, Object.entries(s).join(';'));
  const copy = { ...s, depth: 1 };
  console.log(JSON.stringify(copy), Object.keys(s).join(','));
  (s as any).extra = 7;
  console.log(JSON.stringify(s), Object.keys(s).join(','));
  const v: Size = raw;
  v.width = 9;
  console.log(raw.width, v === raw, v.height);
  const own: PromptResult = { result: false, text: 'own' };
  console.log(JSON.stringify(own), Object.keys(own).join(','));
}
`);
  const expected = ['result,text {"text":"a"} true undefined a', 'true true a width,2;height,3', '{"width":2,"height":3,"depth":1} width,height', '{"width":2,"height":3,"extra":7} width,height,extra', '9 true 2', '{"result":false,"text":"own"} result,text'].join('\n');
  let got: string;
  try {
    buildSwiftRuntime(nativeBuild, '-Onone');
    const out = join(dir, 'swift');
    translateSwift([file], out);
    writeFileSync(join(out, 'Kit.swift'), `import Foundation\nimport NativeScriptKit\n\n${swiftClasses.join('\n')}`);
    writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
try show(PromptResult(result: nil, text: "a", jsUnset: ["result"]), Size(width: 2, height: 3), JSObject([("width", 1.0), ("height", 2.0)]))
`);
    const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
    got = errors ? errors[0] : spawnSync(join(dir, 'main'), { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  }
  check(got === expected, "an object of the kit's class of a result interface of core's is a script object: its keys (an undefined one's too), JSON, `in`, spread and added keys; an untyped object read as one is that object (Swift)");
  if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  try {
    const out = join(dir, 'kotlin');
    translateKotlin([file], out, 'org.example.app', { generatedKit: true });
    writeFileSync(join(out, 'Kit.kt'), `package org.nativescript.kit\n\n${kotlinClasses.join('\n')}`);
    writeFileSync(join(out, 'Main.kt'), `import org.nativescript.kit.*
import org.example.app.*
fun main() {
    show(PromptResult(result = null, text = "a").also { it.jsUnset = mutableSetOf("result") }, Size(width = 2.0, height = 3.0), jsObjectOf("width" to 1.0, "height" to 2.0))
}
`);
    const runtime = buildKotlinRuntime(nativeBuild);
    const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
    got = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  check(got === expected, "an object of the kit's class of a result interface of core's is a script object: its keys (an undefined one's too), JSON, `in`, spread and added keys; an untyped object read as one is that object (Kotlin)");
  if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
})();

// ---- The kit's Gradle path from an output folder under a symlink ----
(() => {
  // The link sits at a different depth from its target, as $TMPDIR's /var does from /private/var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ns-release-checks-symlinked-out-')));
  try {
    mkdirSync(join(dir, 'a', 'b', 'real', 'out'), { recursive: true });
    symlinkSync(join(dir, 'a', 'b', 'real'), join(dir, 'link'), 'dir');
    const out = join(dir, 'link', 'out');
    const resolved = resolve(realpathSync(out), kitProjectDir(out));
    check(existsSync(resolved) && realpathSync(resolved) === realpathSync(KIT_ANDROID), `settings.gradle.kts names the kit from an --out under a symlink (resolved to ${resolved})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Mixins defining one method: composed as applyMixins wraps them ----
(() => {
  // No diff case can run this: Node cannot load @nativescript/core, and the hosts the cases run on have no View.
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-mixins-'));
  try {
    const applyMixins = "export function applyMixins(derivedCtor: any, baseCtors: any[]) {\n  baseCtors.forEach((baseCtor) => {\n    Object.getOwnPropertyNames(baseCtor.prototype).forEach((name) => {\n      if (name === 'constructor') return;\n      const descriptor = Object.getOwnPropertyDescriptor(baseCtor.prototype, name);\n      if (descriptor && (descriptor.get || descriptor.set)) {\n        Object.defineProperty(derivedCtor.prototype, name, descriptor);\n      } else {\n        const oldImpl = derivedCtor.prototype[name];\n        if (!oldImpl) {\n          derivedCtor.prototype[name] = baseCtor.prototype[name];\n        } else {\n          derivedCtor.prototype[name] = function (...args: any[]) {\n            baseCtor.prototype[name].apply(this, args);\n            return oldImpl.apply(this, args);\n          };\n        }\n      }\n    });\n  });\n}\n";
    writeFileSync(join(dir, 'mixin.ts'), applyMixins);
    const translate = (plugin: string, platform: 'ios' | 'android') => {
      writeFileSync(join(dir, 'panel.ts'), "import { View } from '@nativescript/core';\nimport { applyMixins } from './mixin';\n" + plugin);
      const app = join(dir, 'app.ts');
      writeFileSync(app, "import { install } from './panel';\ninstall();\n");
      const pluginFiles = [join(dir, 'mixin.ts'), join(dir, 'panel.ts')];
      const { checker, program } = createProgram([app], new Map(), platform, modulesDir);
      const all = program.getSourceFiles().filter((f) => !f.isDeclarationFile);
      try {
        if (platform === 'ios') return translateModules(new SwiftTranslator(checker, new Map(), all, { pluginFiles }), program, all.map((f) => f.fileName)).map((m) => m.code).join('\n');
        const translator = new Translator(checker, new Map(), all, { pluginFiles, appModule: 'org.example.app' });
        return translateKotlinModules(translator, program, all.map((f) => f.fileName)).map((m) => m.code).join('\n');
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    };
    const composed = [
      "class Common extends View {\n  _dismissed(reason: string): string { return 'common ' + reason; }\n}",
      "class Platform extends View {\n  _dismissed(reason: string): string { return 'platform ' + reason; }\n}",
      "class Later extends View {\n  _dismissed(reason: string): string { return 'later ' + reason; }\n}",
      'export function install() {\n  applyMixins(View, [Common, Platform]);\n  applyMixins(View, [Later]);\n}\n',
    ].join('\n');
    const swift = translate(composed, 'ios'), kotlin = translate(composed, 'android');
    const install = (code: string, name: string) => new RegExp(`(?:func|fun) __install_${name}\\(\\) \\{[^]*?\\n\\}`).exec(code)?.[0] ?? '';
    check(/^var __mixins_View__dismissed: \[Int\] = \[\]$/m.test(swift) && /func __Common__dismissed\(_ reason: String\) -> String/.test(swift) && /func _dismissed\(_ reason: String\) -> String \{\n {8}let __chain = __mixins_View__dismissed\n/.test(swift)
      && /for __k in __chain\.dropFirst\(\)\.reversed\(\) \{\n {12}switch __k \{\n {12}case 0: _ = self\.__Common__dismissed\(reason\)\n {12}case 1: _ = self\.__Platform__dismissed\(reason\)\n {12}default: _ = self\.__Later__dismissed\(reason\)/.test(swift)
      && /switch __chain\[0\] \{\n {8}case 0: return self\.__Common__dismissed\(reason\)/.test(swift)
      && /__mixins_View__dismissed\.append\(0\)/.test(install(swift, 'Common')) && /__mixins_View__dismissed\.append\(1\)/.test(install(swift, 'Platform')) && /__mixins_View__dismissed\.append\(2\)/.test(install(swift, 'Later')),
      `a method several mixins define runs the last installed first and returns the first one's result, across applyMixins calls (Swift)${swift.startsWith('error') ? `: ${swift}` : ''}`);
    check(/^val __mixins_View__dismissed = mutableListOf<Int>\(\)$/m.test(kotlin) && /^fun View\.__Common__dismissed\(reason: String\?\): String/m.test(kotlin)
      && /for \(__k in __chain\.drop\(1\)\.asReversed\(\)\) when \(__k\) \{ 0 -> this\.__Common__dismissed\(reason\); 1 -> this\.__Platform__dismissed\(reason\); else -> this\.__Later__dismissed\(reason\) \}/.test(kotlin)
      && /return when \(__chain\[0\]\)/.test(kotlin) && /__mixins_View__dismissed\.add\(2\)/.test(install(kotlin, 'Later')),
      `a method several mixins define runs the last installed first and returns the first one's result, across applyMixins calls (Kotlin)${kotlin.startsWith('error') ? `: ${kotlin}` : ''}`);
    const hooks = "class A extends View {\n  initNativeView() { console.log('a'); }\n}\nclass B extends View {\n  initNativeView() { console.log('b'); }\n}\nexport function install() { applyMixins(View, [A, B]); }\n";
    for (const platform of ['ios', 'android'] as const) check(/the lifecycle hook initNativeView several mixins of View define/.test(translate(hooks, platform)), `a lifecycle hook several mixins of one class define is refused (${platform})`);
    const wraps = "class Loading extends View {\n  onLoaded() { console.log('loaded'); }\n}\nexport function install() { applyMixins(View, [Loading]); }\n";
    for (const platform of ['ios', 'android'] as const) check(/a mixin method View already has \(applyMixins wraps core's onLoaded/.test(translate(wraps, platform)), `a mixin method core's class already has is refused (${platform})`);
    const differ = "class A extends View {\n  _shown(): string { return 'a'; }\n}\nclass B extends View {\n  _shown(): number { return 1; }\n}\nexport function install() { applyMixins(View, [A, B]); }\n";
    for (const platform of ['ios', 'android'] as const) check(/the method _shown several mixins define with different parameter or return types/.test(translate(differ, platform)), `mixins defining one method with different types are refused (${platform})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// cancelAnimationFrame takes the id a frame may not have been requested for (undefined), as the web's does.
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-raf-'));
  try {
    const file = join(dir, 'raf.ts');
    writeFileSync(file, `class Loop {
  frame?: number;
  start() { this.frame = requestAnimationFrame(() => {}); }
  stop() { cancelAnimationFrame(this.frame); this.frame = undefined; }
}
const l = new Loop();
l.start();
l.stop();
l.stop();
cancelAnimationFrame(undefined);
console.log('stopped', l.frame);
`);
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      const modules = translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import Foundation\nimport NativeScriptKit\n${modules.map((m) => m.init ? `${m.init}()\n` : '').join('')}`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors[0] : spawnSync(join(dir, 'main'), { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === 'stopped undefined', `cancelAnimationFrame of an id that may be undefined compiles and runs (Swift)${got === 'stopped undefined' ? '' : `: ${got.slice(0, 300)}`}`);
    const out = join(dir, 'kotlin');
    translateKotlin([file], out, 'org.example.app');
    const kt = readdirSync(out).filter((f) => f.endsWith('.kt')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    check(/cancelAnimationFrame\(this\.frame\)/.test(kt) && /cancelAnimationFrame\(null\)/.test(kt), 'cancelAnimationFrame is given the id as it is held, undefined too (Kotlin: its kit function takes a Double?)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A template's first read of a value that throws ----
(() => {
  // A child component's input whose first read throws starts at its type's neutral value, the binding that follows
  // reporting the error; a type with none lets the error through to the region rendering it. No diff case has a template.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-read-or-zero-'));
  const expected = '0.0 [] false true 0 0 threw';
  let got: string;
  try {
    buildSwiftRuntime(nativeBuild, '-Onone');
    writeFileSync(join(dir, 'main.swift'), `import Foundation
import NativeScriptKit
final class Box {}
struct Boom: Error {}
func fail<T>() throws -> T { throw Boom() }
let n: Double = try jsReadOrZero { try fail() }
let s: String = try jsReadOrZero { try fail() }
let b: Bool = try jsReadOrZero { try fail() }
let o: String? = try jsReadOrZero { try fail() }
let a: [Double] = try jsReadOrZero { try fail() }
let j: JSArray<Double> = try jsReadOrZero { try fail() }
var box = "made"
do { let _: Box = try jsReadOrZero { try fail() } } catch { box = "threw" }
print("\\(n) [\\(s)] \\(b) \\(o == nil) \\(a.count) \\(j.count) \\(box)")
`);
    const errors = swiftc([join(dir, 'main.swift')], join(dir, 'main'), nativeBuild, '-Onone');
    got = errors ? errors[0] : spawnSync(join(dir, 'main'), { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  }
  check(got === expected, "a value whose read throws is its type's neutral value (undefined, zero, false, empty), and a type with none lets the error through (Swift)");
  if (got !== expected) console.log(`    got: ${got.slice(0, 500)}`);
  try {
    writeFileSync(join(dir, 'Main.kt'), `import org.nativescript.kit.*
class Box
fun <T> fail(): T = throw RuntimeException("boom")
fun main() {
    val n: Double = jsReadOrZero { fail() }
    val s: String = jsReadOrZero { fail() }
    val b: Boolean = jsReadOrZero { fail() }
    val o: String? = jsReadOrZero { fail() }
    val a: List<Double> = jsReadOrZero { fail() }
    val j: JSArray<Double> = jsReadOrZero { fail() }
    var box = "made"
    try { jsReadOrZero<Box> { fail() } } catch (e: Throwable) { box = "threw" }
    println("$n [$s] $b \${o == null} \${a.size} \${j.size} $box")
}
`);
    const runtime = buildKotlinRuntime(nativeBuild);
    const errors = kotlinc([join(dir, 'Main.kt')], join(dir, 'classes'), [runtime]);
    got = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  check(got === expected, "a value whose read throws is its type's neutral value (undefined, zero, false, empty), and a type with none lets the error through (Kotlin)");
  if (got !== expected) console.log(`    got: ${got.slice(0, 500)}`);
})();

// ---- Monorepo workspaces, pure-JS ESM packages, bundler verification, and ecosystem hardening ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-hardening-'));
  try {
    // 1. Monorepo `file:` dependencies, tsconfig `extends` + out-of-app `paths`, and ESM exports preference.
    const workspace = join(dir, 'mono');
    const appDir = join(workspace, 'apps', 'demo');
    const sharedLib = join(workspace, 'libs', 'shared');
    const localPkg = join(workspace, 'dist', 'packages', 'my-plugin');
    mkdirSync(join(appDir, 'src'), { recursive: true });
    mkdirSync(sharedLib, { recursive: true });
    mkdirSync(join(localPkg, 'esm'), { recursive: true });
    mkdirSync(join(localPkg, 'cjs'), { recursive: true });
    writeFileSync(join(workspace, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@demo/shared': ['libs/shared/index.ts'] } },
    }));
    writeFileSync(join(appDir, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json' }));
    writeFileSync(join(sharedLib, 'index.ts'), 'export const SHARED = 42;\n');
    writeFileSync(join(localPkg, 'package.json'), JSON.stringify({
      name: '@acme/my-plugin',
      version: '1.0.0',
      main: 'cjs/index.js',
      module: 'esm/index.js',
      exports: { '.': { node: './cjs/index.js', browser: './esm/index.js', default: './cjs/index.js' } },
    }));
    writeFileSync(join(localPkg, 'cjs', 'index.js'), 'module.exports = { answer: 1 };\n');
    writeFileSync(join(localPkg, 'esm', 'index.js'), 'export const answer = 1;\n');
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({
      name: 'demo',
      dependencies: { '@acme/my-plugin': 'file:../../dist/packages/my-plugin' },
    }));
    const locals = localFilePackages(appDir);
    check(locals.get('@acme/my-plugin') === resolve(localPkg), 'localFilePackages resolves monorepo file: dependencies');
    const alias = pathAliases(appDir);
    check(alias('@demo/shared') === join(sharedLib, 'index.ts'), 'pathAliases follows tsconfig extends and resolves out-of-app workspace aliases');
    const rt = runtimeFile('@acme/my-plugin', join(appDir, 'node_modules'), 'ios', locals);
    check(rt?.file === join(resolve(localPkg), 'esm', 'index.js'), `runtimeFile prefers exports.browser ESM over node/CJS for file: packages (${rt?.file})`);

    // 2. Platform-aware engine-binding detection (Android V8/N-API vs clean iOS).
    const nativeApp = join(dir, 'native-app');
    const sqlitePkg = join(nativeApp, 'node_modules', 'demo-sqlite');
    mkdirSync(join(sqlitePkg, 'platforms', 'android', 'cpp'), { recursive: true });
    mkdirSync(join(sqlitePkg, 'platforms', 'ios', 'src'), { recursive: true });
    writeFileSync(join(nativeApp, 'package.json'), JSON.stringify({ name: 'native-app', dependencies: { 'demo-sqlite': '1.0.0' } }));
    writeFileSync(join(sqlitePkg, 'package.json'), JSON.stringify({ name: 'demo-sqlite', version: '1.0.0', main: 'index.js', nativescript: {} }));
    writeFileSync(join(sqlitePkg, 'platforms', 'android', 'cpp', 'sqlite.cpp'), '#include <v8.h>\nvoid init(v8::Isolate* isolate) {}\n');
    writeFileSync(join(sqlitePkg, 'platforms', 'ios', 'src', 'Sqlite.m'), '#import <Foundation/Foundation.h>\n');
    check(unboundEnginePlugins(nativeApp, 'ios', []).length === 0, 'unboundEnginePlugins allows a plugin whose iOS native code does not bind a JS engine');
    check(unboundEnginePlugins(nativeApp, 'android', []).some((m) => m.includes('demo-sqlite')), 'unboundEnginePlugins flags a plugin whose Android C++ uses v8::Isolate');

    // 3. Pure-JS ESM package compilation, CommonJS refusal, shipped .ts without .js.map, and esbuild/Rollup verification.
    const jsApp = join(dir, 'js-app');
    const esmPkg = join(jsApp, 'node_modules', 'pure-esm');
    const cjsPkg = join(jsApp, 'node_modules', 'pure-cjs');
    const tsNoMapPkg = join(jsApp, 'node_modules', 'ts-nomap');
    mkdirSync(esmPkg, { recursive: true });
    mkdirSync(cjsPkg, { recursive: true });
    mkdirSync(join(tsNoMapPkg, 'lib'), { recursive: true });
    mkdirSync(join(tsNoMapPkg, 'build', 'lib'), { recursive: true });
    writeFileSync(join(jsApp, 'package.json'), JSON.stringify({ name: 'js-app', dependencies: { 'pure-esm': '1.0.0', 'pure-cjs': '1.0.0', 'ts-nomap': '1.0.0' } }));
    writeFileSync(join(esmPkg, 'package.json'), JSON.stringify({ name: 'pure-esm', version: '1.0.0', type: 'module', main: 'index.js' }));
    writeFileSync(join(esmPkg, 'index.js'), 'export function twice(x) { return x * 2; }\n');
    writeFileSync(join(cjsPkg, 'package.json'), JSON.stringify({ name: 'pure-cjs', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(cjsPkg, 'index.js'), 'module.exports = function () { return 1; };\n');
    writeFileSync(join(tsNoMapPkg, 'package.json'), JSON.stringify({ name: 'ts-nomap', version: '1.0.0', main: 'build/lib/index.js' }));
    writeFileSync(join(tsNoMapPkg, 'lib', 'index.ts'), 'export function triple(x: number): number { return x * 3; }\n');
    writeFileSync(join(tsNoMapPkg, 'build', 'lib', 'index.js'), 'export function triple(x) { return x * 3; }\n');
    const sources = new PluginSources({ app: jsApp, platform: 'ios', cache: join(dir, 'cache') });
    sources.get(esmPkg);
    check(sources.sourceOf(join(esmPkg, 'index.js')) === join(resolve(esmPkg), 'index.js'), 'PluginSources maps a pure-JS ESM package directly without cloning');
    let cjsError = '';
    try {
      sources.get(cjsPkg);
      sources.sourceOf(join(cjsPkg, 'index.js'));
    } catch (e) { cjsError = (e as Error).message; }
    check(/CommonJS/.test(cjsError) && /pluginReplacements/.test(cjsError), `PluginSources refuses a CommonJS-only JS package with replacement guidance (${cjsError.slice(0, 120)})`);
    sources.get(tsNoMapPkg);
    check(sources.sourceOf(join(tsNoMapPkg, 'build', 'lib', 'index.js')) === join(resolve(tsNoMapPkg), 'lib', 'index.ts'), 'PluginSources maps build/lib/*.js to shipped lib/*.ts without .js.map');

    // 3b. Local/private package with no repository whose .js.map embeds TypeScript sourcesContent.
    const mapSrcPkg = join(jsApp, 'node_modules', 'local-map-pkg');
    const staleMapPkg = join(jsApp, 'node_modules', 'stale-map-pkg');
    mkdirSync(mapSrcPkg, { recursive: true });
    mkdirSync(staleMapPkg, { recursive: true });
    writeFileSync(join(mapSrcPkg, 'package.json'), JSON.stringify({ name: 'local-map-pkg', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(mapSrcPkg, 'index.js'), 'export function quad(x) { return x * 4; }\n//# sourceMappingURL=index.js.map\n');
    writeFileSync(
      join(mapSrcPkg, 'index.js.map'),
      JSON.stringify({
        version: 3,
        file: 'index.js',
        sources: ['../src/index.ts'],
        sourcesContent: ['export function quad(x: number): number { return x * 4; }\n'],
        names: [],
        mappings: 'AAAA',
      }),
    );
    const extractedPkg = sources.get(mapSrcPkg);
    const extractedSrc = sources.sourceOf(join(mapSrcPkg, 'index.js'));
    check(!!extractedSrc && extractedSrc.endsWith(join('src', 'index.ts')) && extractedPkg.verified === 'published', `PluginSources extracts verified sourcesContent when package.json has no repository (${extractedSrc ?? 'none'})`);
    let verifyExtractedOk = true;
    try { sources.verify([extractedSrc!]); } catch { verifyExtractedOk = false; }
    check(verifyExtractedOk, 'PluginSources verifies extracted sourcesContent against the installed JS');

    writeFileSync(join(staleMapPkg, 'package.json'), JSON.stringify({ name: 'stale-map-pkg', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(staleMapPkg, 'index.js'), 'export const x = 1;\n');
    writeFileSync(
      join(staleMapPkg, 'index.js.map'),
      JSON.stringify({
        version: 3,
        file: 'index.js',
        sources: ['../src/index.ts'],
        sourcesContent: ['export const x: number = 1;\n'],
        names: [],
        // 6 empty lines: mapped line lies outside the 2-line index.js (stale map).
        mappings: ';;;;;;AAAA',
      }),
    );
    let staleRejected = false;
    try { sources.get(staleMapPkg); } catch (e) { staleRejected = /stale/i.test((e as Error).message); }
    check(staleRejected, 'PluginSources rejects stale source maps during sourcesContent fallback');

    const vDir = join(dir, 'verify-esbuild');
    mkdirSync(vDir, { recursive: true });
    const vSrc = join(vDir, 'a.ts');
    const vJsOk = join(vDir, 'a.js');
    const vJsBad = join(vDir, 'b.js');
    writeFileSync(vSrc, 'export function f(a: number) { const x = 255; const y = 1000000; const o = { a: a }; return a === undefined ? void 0 : x + y + o.a; }\n');
    writeFileSync(vJsOk, 'export function f(a) { const x = 0xff; const y = 1e6; const o = { a }; return a === void 0 ? undefined : x + y + o.a; }\n');
    writeFileSync(vJsBad, 'export function f(a) { const x = 0xff; const y = 1e6; const o = { a }; return a === void 0 ? undefined : x * y + o.a; }\n');
    let esbuildOk = true;
    let esbuildErr = '';
    try { verify('esbuild-ok', vJsOk, vSrc); } catch (e) { esbuildOk = false; esbuildErr = (e as Error).message; }
    check(esbuildOk, `verify accepts esbuild/Rollup normalizations (hex, scientific, void 0, shorthand)${esbuildOk ? '' : `: ${esbuildErr.slice(0, 200)}`}`);
    let tamperedCaught = false;
    try { verify('esbuild-bad', vJsBad, vSrc); } catch { tamperedCaught = true; }
    check(tamperedCaught, 'verify still rejects genuine behavioral differences');

    // 4. ShorthandPropertyAssignment closed-world reachability (`export const ops = { helper }`).
    const reachDir = join(dir, 'reach');
    mkdirSync(reachDir, { recursive: true });
    const reachPlug = join(reachDir, 'plug.ts');
    const reachApp = join(reachDir, 'app.ts');
    writeFileSync(reachPlug, 'function helper(x: number): number { return x + 1; }\nfunction unused(): number { return 0; }\nexport const ops = { helper };\n');
    writeFileSync(reachApp, "import { ops } from './plug';\nexport const out = ops.helper(5);\n");
    const rp = createProgram([reachApp], new Map(), 'ios', modulesDir);
    const reach = reachability(rp.program, rp.resolved, [reachApp], new Set([reachPlug]), 'ios');
    const plugSf = rp.program.getSourceFile(reachPlug)!;
    const helperDecl = plugSf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'helper')!;
    const unusedDecl = plugSf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'unused')!;
    check(reach.keeps(helperDecl) && !reach.keeps(unusedDecl), 'reachability retains functions referenced via ShorthandPropertyAssignment and drops unreferenced ones');

    // 5. Feature-detection dead-branch folding (preflight + Swift & Kotlin) and runtime/translator hardening.
    const featureFile = join(dir, 'hardening.ts');
    writeFileSync(featureFile, `
export const registry = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((_: string) => {}) : undefined;
export const b64 = typeof (Uint8Array as any).fromBase64 === 'function' ? (Uint8Array as any).fromBase64('AA==') : new Uint8Array(0);
class Base {
  id = 1;
  [Symbol.dispose]() { return 'disposed'; }
  async [Symbol.asyncDispose]() { return 'async-disposed'; }
}
type WithExtra = Base & { extra: number };
export function readExtra(x: WithExtra): number { return x.extra; }
type OnlyStr = Extract<string | number, string>;
export function erased(a: OnlyStr, r: RegExpConstructor): any { return [a, r]; }
interface Rec { next?: Rec; items: Rec[]; }
export function touchRec(r: Rec): number { return r.items.length; }
export const fns = {
  err: console.error,
  fromCode: String.fromCharCode,
  fromBytes: Uint8Array.from,
  isArr: Array.isArray,
  isInt: Number.isInteger,
};
export const objWithDollar = { get $() { return 7; } };
export function testAll(): string {
  const $ = 3;
  const $$ = 4;
  const p = Promise.resolve(1).catch();
  const d = new DOMException('oops', 'AbortError');
  const fromCode = String.fromCharCode;
  const isArr = Array.isArray;
  const isInt = Number.isInteger;
  return [$ + $$, objWithDollar.$, d.name, d.message, fromCode(65, 66), isArr([1]), isInt(4), isInt(4.5), registry === undefined, b64.length, p !== undefined].join('|');
}
console.log(testAll());
`);
    for (const platform of ['ios', 'android'] as const) {
      const fp = createProgram([featureFile], new Map(), platform, modulesDir);
      const findings = preflight(fp.checker, fp.files);
      check(findings.length === 0, `preflight folds guarded FinalizationRegistry feature probe without errors (${platform}${findings.length ? `: ${findings[0].what}` : ''})`);
    }
    // Verify recursive type does not stack-overflow AndroidNativeAPI.classesOf.
    {
      const ap = createProgram([featureFile], new Map(), 'android', modulesDir);
      const at = new Translator(ap.checker, new Map(), ap.files, { appModule: 'org.example.app', native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [], dependencies: [] })) });
      let ok = true;
      try { translateKotlinModules(at, ap.program, [featureFile]); } catch (e) { ok = false; console.log('    android err:', String(e).slice(0, 300)); }
      check(ok, 'recursive TS types + feature probes + lib function values + Symbol.dispose translate cleanly with AndroidNativeAPI');
    }
    // Compile & run on BOTH Swift and Kotlin runtimes and check exact output matches Node!
    const expectedLine = '7|7|AbortError|oops|AB|true|true|false|true|0|true';
    {
      let swGot = '';
      try {
        buildSwiftRuntime(nativeBuild, '-Onone');
        const out = join(dir, 'swift-hardening');
        const modules = translateSwift([featureFile], out);
        writeFileSync(join(out, 'main.swift'), swiftMain(modules));
        const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main-hardening'), nativeBuild, '-Onone');
        swGot = errors ? errors[0] : spawnSync(join(dir, 'main-hardening'), { encoding: 'utf8' }).stdout.trim();
      } catch (e) {
        swGot = (e as Error).message.split('\n')[0];
      }
      check(swGot === expectedLine, `hardening suite (feature probes, lib fn values, $, DOMException, catch(), Symbol.dispose) compiles & runs identically (Swift${swGot === expectedLine ? '' : `: ${swGot.slice(0, 300)}`})`);
    }
    {
      let ktGot = '';
      try {
        const out = join(dir, 'kotlin-hardening');
        const modules = translateKotlin([featureFile], out, 'org.example.hardening');
        writeFileSync(join(out, '__Main.kt'), `package org.example.hardening\nimport org.nativescript.kit.*\nfun main() {\n${modules.map((m) => (m.init ? `    ${m.init}()\n` : '')).join('')}}\n`);
        const runtime = buildKotlinRuntime(nativeBuild);
        const errors = kotlinc(readdirSync(out).filter((f) => f.endsWith('.kt')).map((f) => join(out, f)), join(dir, 'classes-hardening'), [runtime]);
        ktGot = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes-hardening'), runtime, kotlinStdlib()].join(':'), 'org.example.hardening.__MainKt'], { encoding: 'utf8' }).stdout.trim();
      } catch (e) {
        ktGot = (e as Error).message.split('\n')[0];
      }
      check(ktGot === expectedLine, `hardening suite (feature probes, lib fn values, $, DOMException, catch(), Symbol.dispose) compiles & runs identically (Kotlin${ktGot === expectedLine ? '' : `: ${ktGot.slice(0, 300)}`})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

finish();
