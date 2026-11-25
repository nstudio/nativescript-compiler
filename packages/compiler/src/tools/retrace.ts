#!/usr/bin/env node
// A native release's stack trace, or its Gradle build log, in terms of the app's source:
//   ns-compiled-retrace <android project> [trace.txt]   (the trace on stdin without a file)
//   ns-compiled-retrace --build-log <android project> [gradle.log]   (Kotlin's errors only)
//   ns-compiled-retrace <ios project | App.app.dSYM | App.xcarchive> [trace.txt | crash.ips]   (targets/ios/retrace.ts)
//   ns-compiled-retrace --compose-mapping <android project> [out.txt]   (targets/android/compose-mapping.ts)
// R8's retrace undoes the release build's renaming and line packing with the
// build's mapping.txt; the project's source-lines.json then takes each frame
// in a compiled Kotlin file to the line of the app's source it came from, and
// the kit's own (kit-android/generated/source-lines.json) takes each frame in
// the kit generated from core to core's .ts line. Kotlin compiler errors
// (`e: file:///…/X.kt:12:3 …`) in a build log are mapped the same way.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { composeMapping, isComposed, r8Retrace, type LineTable } from '../targets/android/compose-mapping.ts';
import { mapKotlinDiagnostics } from '../kotlin/diagnostics.ts';
import { KIT_ANDROID } from '../driver/paths.ts';
import { iosDebugSymbols, retraceIOS } from '../targets/ios/retrace.ts';

const buildLog = process.argv.includes('--build-log');
const compose = process.argv.includes('--compose-mapping');
const [project, traceFile] = process.argv.slice(2).filter((a) => a !== '--build-log' && a !== '--compose-mapping');
if (!project) {
	console.error('usage: ns-compiled-retrace [--build-log] <android project> [trace.txt]\n       ns-compiled-retrace <ios project | App.app.dSYM | App.xcarchive> [trace.txt | crash.ips]\n       ns-compiled-retrace --compose-mapping <android project> [out.txt]');
	process.exit(2);
}
const mappingDir = join(project, 'build', 'outputs', 'mapping', 'release');
const kitLines = join(KIT_ANDROID, 'generated', 'source-lines.json');
const tables = (): LineTable[] => [join(project, 'source-lines.json'), kitLines].filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')));
if (compose) {
	// In place (what the release build does after R8): R8's own mapping is kept as mapping-kotlin.txt and mapping.txt
	// becomes the composed one, which the bundle carries and crash reporters' upload tasks read. With `out`, only `out` is written.
	const mapping = join(mappingDir, 'mapping.txt'),
		kotlin = join(mappingDir, 'mapping-kotlin.txt');
	if (!existsSync(join(project, 'source-lines.json')) || !existsSync(mapping)) {
		console.error(`${project} has no source-lines.json or no ${relative(project, mapping)}: give the compiled Android project (platforms/compiled/android) after a release build, built without --no-source-lines`);
		process.exit(1);
	}
	const composed = isComposed(readFileSync(mapping, 'utf8'));
	if (composed && !existsSync(kotlin)) {
		console.error(`${mapping} is composed already and R8's own (${basename(kotlin)}) is gone`);
		process.exit(1);
	}
	const text = composeMapping(readFileSync(composed ? kotlin : mapping, 'utf8'), tables());
	const out = traceFile;
	if (out) {
		writeFileSync(out, text);
		process.exit(0);
	}
	if (!composed) copyFileSync(mapping, kotlin);
	writeFileSync(mapping + '.tmp', text);
	renameSync(mapping + '.tmp', mapping);
	process.exit(0);
}
let trace = readFileSync(traceFile ?? 0, 'utf8');
let dsym: string | null = null;
try {
	dsym = buildLog ? null : iosDebugSymbols(project);
} catch (e) {
	console.error((e as Error).message);
	process.exit(1);
}
if (dsym) {
	const { trace: retraced, warning } = retraceIOS(trace, dsym);
	if (warning) console.error(`warning: ${warning}`);
	process.stdout.write(retraced);
	process.exit(0);
}
if (!existsSync(join(project, 'source-lines.json'))) {
	console.error(`${project} has no source-lines.json: give the compiled Android project (platforms/compiled/android), built without --no-source-lines, or for iOS the compiled project (platforms/compiled/ios), an .app.dSYM or an .xcarchive`);
	process.exit(1);
}
trace = mapKotlinDiagnostics(trace, project);
if (buildLog) {
	process.stdout.write(trace);
	process.exit(0);
}

// R8's own mapping with Kotlin lines: the line tables below then name each file by its path, and a template's lines too.
const r8 = join(mappingDir, 'mapping.txt');
const mapping = existsSync(r8) && isComposed(readFileSync(r8, 'utf8')) && existsSync(join(mappingDir, 'mapping-kotlin.txt')) ? join(mappingDir, 'mapping-kotlin.txt') : r8;
if (existsSync(mapping) && /^\s*at\s/m.test(trace)) {
	const tool = r8Retrace();
	if (!tool) {
		console.error('R8 retrace not found (Android SDK cmdline-tools); set ANDROID_HOME');
		process.exit(1);
	}
	const scratch = mkdtempSync(join(tmpdir(), 'ns-retrace-'));
	try {
		writeFileSync(join(scratch, 'trace.txt'), trace);
		trace = execFileSync(tool, [mapping, join(scratch, 'trace.txt')], { encoding: 'utf8', maxBuffer: 64 << 20 });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const app: LineTable = JSON.parse(readFileSync(join(project, 'source-lines.json'), 'utf8'));
const kit: LineTable | null = existsSync(kitLines) ? JSON.parse(readFileSync(kitLines, 'utf8')) : null;
// Frames of the app's classes and the generated kit's; retrace names a file R8 kept no name for after its class, with .java.
process.stdout.write(
	trace.replace(/(\bat\s+([\w$.]+)\.[\w$<>-]+\s*)\(([\w$]+)\.(?:kt|java):(\d+)\)/g, (whole, frame: string, cls: string, file: string, line: string) => {
		const table = cls.startsWith(app.package + '.') ? app : kit && cls.startsWith(kit.package + '.') ? kit : null;
		const ranges = table?.files[file + '.kt'];
		if (!ranges) return whole;
		let at: [number, string, number] | undefined;
		for (const r of ranges) {
			if (r[0] > +line) break;
			at = r;
		}
		if (!at?.[1]) return whole;
		return `${frame}(${table === kit ? '@nativescript/core/' : ''}${at[1]}:${at[2]})`;
	}),
);
