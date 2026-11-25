// A compiled iOS app's stack trace in terms of the app's source. Its frames are `at <symbol> (<image>+0x<offset>)`
// (kit-apple's NativeStack, in `error.stack` and the fatal exception's reason), or an `.ips` crash report's frames;
// the build's dSYM resolves the app image's offsets to the `.ts` lines the Swift carries (#sourceLocation), with atos.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { byName } from '../../program/order.ts';

export type IOSFrame = { indent: string; symbol: string; image: string; offset: number; pc?: boolean };
export type TraceLine = string | IOSFrame;
/** An `.ips` report's binary images, by name. */
export type IpsImage = { name: string; arch?: string; uuid?: string };

/**
 * The app target's Release Swift flags for its frames to keep their `.ts` lines: a function Swift merges with a
 * near-identical one (`merged …`) has no line table. The kit is left to merge: unmerged, it adds some 3% to an app's code.
 */
export const TRACEABLE_SWIFT_FLAGS = ['-Xfrontend', '-disable-llvm-merge-functions-pass'];

const FRAME = /^([ \t]*)at (.*) \(([^()]+)\+0x([0-9a-fA-F]+)\)[ \t]*$/;
/** The address atos is given an offset at: any load address works, as atos takes the slide from it. */
const LOAD = 0x100000000;

/** The debug symbols for an iOS input: a `.dSYM`, an `.xcarchive`, or a compiled iOS project its Release build is under; null for anything else. */
export function iosDebugSymbols(input: string): string | null {
	if (/\.dSYM\/?$/.test(input)) return input;
	if (/\.xcarchive\/?$/.test(input)) return archiveDsym(input);
	if (!existsSync(input) || !statSync(input).isDirectory() || existsSync(join(input, 'source-lines.json'))) return null;
	if (
		!readdirSync(input)
			.sort()
			.some((f) => f.endsWith('.xcodeproj') || f === 'project.yml')
	)
		return null;
	// cli.ts --build's DerivedData is build/, a device or store build's output is under build/ too, and the CLI's simulator
	// build has its own DerivedData/; an archive sits beside them or in them.
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		for (const f of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
			if (!f.isDirectory()) continue;
			const path = join(dir, f.name);
			if (f.name.endsWith('.xcarchive')) {
				const d = archiveDsym(path);
				if (d) found.push(d);
			} else if (f.name.endsWith('.app.dSYM')) {
				if (/(^|\/)Release-/.test(dir.slice(input.length))) found.push(path);
			} else if (depth > 0 && !/\.(app|framework|xcodeproj|xcworkspace|build|swiftmodule)$/.test(f.name) && !f.name.endsWith('.noindex') && f.name !== 'SourcePackages') walk(path, depth - 1);
		}
	};
	walk(input, 0);
	for (const out of ['build', 'DerivedData']) if (existsSync(join(input, out))) walk(join(input, out), 5);
	if (!found.length) throw new Error(`${input} has no Release build's dSYM (a Release-*/*.app.dSYM or an .xcarchive under it, its build/ or its DerivedData/): build it, or give the .app.dSYM or .xcarchive`);
	return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function archiveDsym(archive: string): string | null {
	const dir = join(archive, 'dSYMs');
	if (!existsSync(dir)) return null;
	const apps = existsSync(join(archive, 'Products', 'Applications')) ? readdirSync(join(archive, 'Products', 'Applications')).sort() : [];
	const dsyms = readdirSync(dir)
		.sort()
		.filter((f) => f.endsWith('.app.dSYM'));
	const dsym = dsyms.find((d) => apps.includes(d.slice(0, -'.dSYM'.length))) ?? dsyms[0];
	return dsym ? join(dir, dsym) : null;
}

/** The binary inside a dSYM, which names the app's image in a trace. */
export function dwarfBinary(dsym: string): string {
	const dir = join(dsym, 'Contents', 'Resources', 'DWARF');
	const files = existsSync(dir) ? readdirSync(dir).sort() : [];
	if (files.length !== 1) throw new Error(`${dsym} is not a dSYM of one binary`);
	return join(dir, files[0]);
}

/** A trace's lines, each `at … (<image>+0x<offset>)` one a frame. */
export function traceLines(text: string): TraceLine[] {
	return text.split('\n').map((line) => {
		const m = FRAME.exec(line);
		return m ? { indent: m[1], symbol: m[2], image: m[3].trim(), offset: parseInt(m[4], 16) } : line;
	});
}

/** An `.ips` crash report (a JSON header line, then a JSON body), or null when the text is not one. */
export function ipsReport(text: string): { lines: TraceLine[]; images: IpsImage[] } | null {
	const nl = text.indexOf('\n');
	if (!text.startsWith('{') || nl < 0) return null;
	let body: any;
	try {
		JSON.parse(text.slice(0, nl));
		body = JSON.parse(text.slice(nl + 1));
	} catch {
		return null;
	}
	if (!Array.isArray(body?.usedImages) || !Array.isArray(body.threads)) return null;
	const images: IpsImage[] = body.usedImages.map((i: any) => ({ name: i.name ?? basename(i.path ?? '?'), arch: i.arch, uuid: i.uuid }));
	// Frame 0 of a backtrace is where the thread stopped; every other frame is a return address. A report symbolicated
	// on a Mac with the dSYM lists a frame's inlined functions as frames of the same offset, which atos lists again.
	const frames = (list: any[]): TraceLine[] => list.filter((f) => !f.inline).map((f, k) => ({ indent: '    ', symbol: f.symbol ?? (images[f.imageIndex]?.name === body.procName ? '<compiled>' : '?'), image: images[f.imageIndex]?.name ?? '?', offset: f.imageOffset, pc: k === 0 }));
	const lines: TraceLine[] = [];
	const reason = body.exceptionReason?.composed_message ?? body.exceptionReason?.reason;
	if (body.exception) lines.push(`${body.exception.type ?? ''} ${body.exception.signal ?? ''}`.trim());
	// The fatal exception's reason carries the error's own frames (NativeStack's).
	for (const text of [reason, ...Object.values(body.asi ?? {}).flat()]) if (typeof text === 'string') lines.push('', ...traceLines(text));
	if (Array.isArray(body.lastExceptionBacktrace)) lines.push('', 'Last Exception Backtrace:', ...frames(body.lastExceptionBacktrace));
	const crashed = body.threads[body.faultingThread ?? -1] ?? body.threads.find((t: any) => t.triggered);
	if (crashed) lines.push('', `Thread ${body.threads.indexOf(crashed)} Crashed:`, ...frames(crashed.frames ?? []));
	return { lines, images };
}

/**
 * The lines with each frame of `image` replaced by its symbolicated frames, innermost (inlined) first. `symbolicate`
 * takes the frames' addresses (at load address 0x100000000) and gives each one's atos lines, or none when unknown.
 */
export function symbolicated(lines: TraceLine[], image: string, symbolicate: (addresses: number[]) => string[][]): string {
	const ours = lines.filter((l): l is IOSFrame => typeof l !== 'string' && l.image === image);
	// atos takes an address inside the instruction: a return address is the one after the call.
	const address = (f: IOSFrame) => LOAD + f.offset - (f.pc ? 0 : 1);
	const unique = [...new Set(ours.map(address))];
	const resolved = new Map<number, string[]>();
	if (unique.length) symbolicate(unique).forEach((r, k) => resolved.set(unique[k], r));
	return lines
		.flatMap((l) => {
			if (typeof l === 'string') return [l];
			const original = `${l.indent}at ${l.symbol} (${l.image}+0x${l.offset.toString(16)})`;
			const frames = l.image === image ? (resolved.get(address(l)) ?? []).map(atosFrame).filter((f) => f !== null) : [];
			if (!frames.length) return [original];
			return frames.map((f) => `${l.indent}at ${f.name} (${f.location ?? `${l.image}+0x${l.offset.toString(16)}`})`);
		})
		.join('\n');
}

/** One line of atos's output: `name (in image) (file:line)`, `name (in image) + 12`, or an unresolved `0x… (in image)`. */
export function atosFrame(line: string): { name: string; location?: string } | null {
	const m = /^(.*?) \(in [^)]*\)(?: \((.+:\d+)\))?(?: \+ \d+)?$/.exec(line.trim());
	if (!m || /^0x[0-9a-f]+$/i.test(m[1])) return null;
	return { name: m[1], location: m[2] };
}

/**
 * atos -i's output for `count` addresses: each address's lines, then an empty line (an address it cannot resolve
 * prints an empty line of its own). Null when the blocks don't come out one per address.
 */
export function atosBlocks(out: string, count: number): string[][] | null {
	const blocks = out
		.replace(/\n$/, '')
		.split('\n\n')
		.map((b) =>
			b
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean),
		);
	if (blocks.length === count + 1 && !blocks.at(-1)!.length) blocks.pop();
	return blocks.length === count ? blocks : null;
}

/** Runs atos once over every address, inlined frames included; one line per address when its blocks can't be told apart. */
export function atos(binary: string, arch: string): (addresses: number[]) => string[][] {
	return (addresses) => {
		const args = ['atos', '-o', binary, '-arch', arch, '-l', '0x' + LOAD.toString(16), ...addresses.map((a) => '0x' + a.toString(16))];
		const run = (inline: boolean) => execFileSync('xcrun', inline ? [args[0], '-i', ...args.slice(1)] : args, { encoding: 'utf8', maxBuffer: 64 << 20 });
		return (
			atosBlocks(run(true), addresses.length) ??
			run(false)
				.split('\n')
				.slice(0, addresses.length)
				.map((l) => [l])
		);
	};
}

/** The binary's architecture a trace is from: the report's, else arm64 when the binary has it. */
export function binaryArch(binary: string, reported?: string): string {
	const archs = execFileSync('xcrun', ['lipo', '-archs', binary], { encoding: 'utf8' }).trim().split(/\s+/);
	if (reported && archs.includes(reported)) return reported;
	return archs.includes('arm64') ? 'arm64' : archs[0];
}

/** The trace (text or an `.ips` report) with the app's frames in source lines, and a warning when the report is not of this build. */
export function retraceIOS(text: string, dsym: string): { trace: string; warning?: string } {
	const binary = dwarfBinary(dsym);
	const image = basename(binary);
	const ips = ipsReport(text);
	const reported = ips?.images.find((i) => i.name === image);
	let warning: string | undefined;
	if (reported?.uuid) {
		const uuids = execFileSync('xcrun', ['dwarfdump', '--uuid', binary], { encoding: 'utf8' }).toUpperCase();
		if (!uuids.includes(reported.uuid.toUpperCase())) warning = `the report's ${image} (${reported.uuid}) is not the binary of ${dsym}: its lines would be wrong`;
	}
	return { trace: symbolicated(ips?.lines ?? traceLines(text), image, atos(binary, binaryArch(binary, reported?.arch))), warning };
}
