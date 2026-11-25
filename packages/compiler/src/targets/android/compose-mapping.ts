// R8's mapping.txt composed with the build's source lines: a mapping whose
// app frames retrace to the app's source file and line, for crash
// reporters that take only a mapping file (Play Console, Crashlytics, Sentry).
// A class's original file becomes its source file (`# {"id":"sourceFile",…}`)
// and each member range's Kotlin lines become source lines, a range split where
// the source line changes. Classes no line table covers (the kit's hand-written
// runtime, libraries) are left as they are, as is every line not understood.
//
// The format holds one file per class: a class made from two files (a
// component's script and its template) names the file most of its lines come
// from, and its lines from the other file read line 0 (`ns-compiled-retrace`
// names them exactly).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { compareVersions } from '../../program/order.ts';

/** A source-lines.json: for each Kotlin file of `package`, `[first Kotlin line, source file, its line]` ranges (`''` for generated code). */
export type LineTable = { package: string; files: Record<string, [number, string, number][]> };

/** The header line a composed mapping carries. */
export const COMPOSED = "# ns-compiled: composed with the build's source lines";
/** Whether a mapping is composed: its header has `COMPOSED`. */
export function isComposed(mapping: string): boolean {
	return mapping.includes(COMPOSED);
}

/** `startMin:endMin:signature:startOrig:endOrig -> name`; the ranges are optional. */
const MEMBER = /^(\s+)(?:(\d+):(\d+):)?(\S.*?\))(?::(\d+)(?::(\d+))?)? -> (\S+)$/;
const SOURCE_FILE = /^# \{.*"id"\s*:\s*"sourceFile"/;
/** Metadata that belongs to the method rather than to one of its ranges: kept on the first range only, where R8 writes it. */
const METHOD_METADATA = /"id"\s*:\s*"com\.android\.tools\.r8\.(?:residualsignature|synthesized)"/;

interface Member {
	indent: string;
	min: [number, number] | null;
	signature: string;
	/** null: original lines are the minified lines; `[a]`: every minified line is `a`; `[a, b]`: a range. */
	orig: [number] | [number, number] | null;
	name: string;
	metadata: string[];
}
interface Class {
	line: string;
	name: string;
	metadata: string[];
	body: (Member | string)[];
}

export function composeMapping(mapping: string, tables: LineTable[]): string {
	const lines = mapping.split('\n');
	const header: string[] = [];
	let i = 0;
	while (i < lines.length && (lines[i].startsWith('#') || !lines[i].trim())) header.push(lines[i++]);
	if (!isComposed(header.join('\n'))) header.push(COMPOSED);
	const classes: Class[] = [];
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (!/^\s/.test(line) && line.includes(' -> ')) {
			classes.push({ line, name: line.slice(0, line.indexOf(' -> ')), metadata: [], body: [] });
			continue;
		}
		const c = classes.at(-1);
		if (!c) {
			header.push(line);
			continue;
		}
		const comment = line.trimStart().startsWith('#');
		if (comment && !/^\s/.test(line) && !c.body.length) {
			c.metadata.push(line);
			continue;
		}
		const last = c.body.at(-1);
		if (comment && last && typeof last !== 'string') {
			last.metadata.push(line);
			continue;
		}
		const m = MEMBER.exec(line);
		c.body.push(
			m
				? {
						indent: m[1],
						min: m[2] ? [+m[2], +m[3]] : null,
						signature: m[4],
						orig: m[5] === undefined ? null : m[6] === undefined ? [+m[5]] : [+m[5], +m[6]],
						name: m[7],
						metadata: [],
					}
				: line,
		);
	}

	// Each class's Kotlin file, its table's ranges, and the source file it is given.
	const kotlinFile = new Map<string, string>();
	for (const c of classes) {
		const meta = c.metadata.find((l) => SOURCE_FILE.test(l));
		let file: string | undefined;
		if (meta) {
			try {
				file = JSON.parse(meta.slice(1)).fileName;
			} catch {
				file = undefined;
			}
		}
		kotlinFile.set(c.name, file ?? `${c.name.slice(c.name.lastIndexOf('.') + 1).split('$')[0]}.kt`);
	}
	const rangesOf = (cls: string) => {
		const table = tables.find((t) => cls.startsWith(t.package + '.'));
		return table?.files[kotlinFile.get(cls) ?? ''];
	};
	const at = (ranges: [number, string, number][], line: number) => {
		let found: [number, string, number] | undefined;
		for (const r of ranges) {
			if (r[0] > line) break;
			found = r;
		}
		return found?.[1] ? found : undefined;
	};
	const classOf = (c: Class, m: Member) => {
		const name = m.signature.slice(0, m.signature.indexOf('(')).split(' ').at(-1)!;
		return name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : c.name;
	};
	const origAt = (m: Member, line: number) => (!m.orig ? line : m.orig.length === 1 || m.orig[0] === m.orig[1] ? m.orig[0] : m.orig[0] + line - m.min![0]);
	const chosen = new Map<string, string>();
	for (const c of classes) {
		const ranges = rangesOf(c.name);
		if (!ranges) continue;
		const count = new Map<string, number>();
		for (const m of c.body) {
			if (typeof m === 'string' || !m.min || classOf(c, m) !== c.name) continue;
			const seen = new Set<number>();
			for (let line = m.min[0]; line <= m.min[1]; line++) seen.add(origAt(m, line));
			for (const line of seen) {
				const r = at(ranges, line);
				if (r) count.set(r[1], (count.get(r[1]) ?? 0) + 1);
			}
		}
		const best = [...count].sort((a, b) => b[1] - a[1])[0];
		if (best) chosen.set(c.name, best[0]);
	}
	/** The line a member's minified line is given: the source line, 0 for generated code or another file's line; null when its class keeps its lines. */
	const sourceLine = (c: Class, m: Member, line: number): number | null => {
		const cls = classOf(c, m);
		const file = chosen.get(cls);
		if (file === undefined) return null;
		const kotlin = origAt(m, line);
		const r = kotlin ? at(rangesOf(cls)!, kotlin) : undefined;
		return r && r[1] === file ? r[2] : 0;
	};

	const out = [...header];
	for (const c of classes) {
		out.push(c.line);
		const file = chosen.get(c.name);
		const sourceFile = file === undefined ? null : JSON.stringify({ id: 'sourceFile', fileName: basename(file) });
		if (sourceFile && !c.metadata.some((l) => SOURCE_FILE.test(l))) out.push(`# ${sourceFile}`);
		out.push(...c.metadata.map((l) => (sourceFile && SOURCE_FILE.test(l) ? `# ${sourceFile}` : l)));
		for (let k = 0; k < c.body.length; k++) {
			const first = c.body[k];
			if (typeof first === 'string' || !first.min) {
				out.push(...(typeof first === 'string' ? [first] : write(first, null, null, true)));
				continue;
			}
			// An inline frame and its callers: the lines that follow with the same minified range and name.
			const group = [first];
			while (k + 1 < c.body.length) {
				const next = c.body[k + 1];
				if (typeof next === 'string' || !next.min || next.min[0] !== first.min[0] || next.min[1] !== first.min[1] || next.name !== first.name) break;
				group.push(next);
				k++;
			}
			if (group.every((m) => !chosen.has(classOf(c, m)))) {
				for (const m of group) out.push(...write(m, null, null, true));
				continue;
			}
			// Split where any frame's source line changes.
			let start = first.min[0];
			let values = group.map((m) => sourceLine(c, m, start));
			for (let line = start + 1; line <= first.min[1] + 1; line++) {
				const next = line <= first.min[1] ? group.map((m) => sourceLine(c, m, line)) : null;
				if (next && next.every((v, j) => v === values[j])) continue;
				group.forEach((m, j) => out.push(...write(m, [start, line - 1], values[j], start === first.min![0])));
				if (next) {
					start = line;
					values = next;
				}
			}
		}
	}
	return rehash(out.join('\n'));
}

/** A member line for minified lines `min` (a part of its range), given source line `line` (null: its own lines). */
function write(m: Member, min: [number, number] | null, line: number | null, first: boolean): string[] {
	const metadata = first ? m.metadata : m.metadata.filter((l) => !METHOD_METADATA.test(l));
	const range = min ?? m.min;
	const whole = !min || (m.min && min[0] === m.min[0] && min[1] === m.min[1]);
	let orig = '';
	if (line !== null) orig = m.orig?.length === 1 ? `:${line}` : `:${line}:${line}`;
	else if (m.orig && (whole || m.orig.length === 1 || m.orig[0] === m.orig[1])) orig = `:${m.orig.join(':')}`;
	else if (m.orig) {
		const from = m.orig[0] + range![0] - m.min![0];
		orig = `:${from}:${from + range![1] - range![0]}`;
	}
	return [`${m.indent}${range ? `${range[0]}:${range[1]}:` : ''}${m.signature}${orig} -> ${m.name}`, ...metadata];
}

/** R8's `pg_map_hash` is the SHA-256 of what follows its line; `pg_map_id` names the build (the dex's source files carry it) and is kept. */
function rehash(mapping: string): string {
	const m = /^# pg_map_hash: SHA-256 [0-9a-f]+\n/m.exec(mapping);
	if (!m) return mapping;
	const rest = mapping.slice(m.index + m[0].length);
	return `${mapping.slice(0, m.index)}# pg_map_hash: SHA-256 ${createHash('sha256').update(rest).digest('hex')}\n${rest}`;
}

/** R8's retrace in the Android SDK's command-line tools, the newest there. */
export function r8Retrace(): string | null {
	const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library', 'Android', 'sdk');
	const tools = join(sdk, 'cmdline-tools');
	if (!existsSync(tools)) return null;
	const versions = readdirSync(tools).sort((a, b) => (a === 'latest' ? -1 : b === 'latest' ? 1 : compareVersions(b, a)));
	for (const v of versions) {
		const bin = join(tools, v, 'bin', process.platform === 'win32' ? 'retrace.bat' : 'retrace');
		if (existsSync(bin)) return bin;
	}
	return null;
}
