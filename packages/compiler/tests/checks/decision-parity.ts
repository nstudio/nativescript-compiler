#!/usr/bin/env node
// Decision parity: the front answers a question once, so both backends get one answer to it. Every diff case that runs on
// both backends is translated by each with NS_DECISION_TRACE set (src/semantics/decision-trace.ts), and the two traces
// are compared: a question one backend asks and the other doesn't is fine; two different answers to the same question
// about the same node fail, unless the answer is keyed by the ledger (src/semantics/ledger.ts): it read a field the
// backends differ in, or it changes when the backend translates the case with the other's ledger (each backend
// translates every case a second time so, which catches an answer a whole-program analysis made once from the ledger).
// The native types the backends hold values as (`types.<hook>`) are compared too. An answer that read one of a backend's
// own facts (`backend.<hook>`) is counted apart, not failed, where the backends answered that fact differently.
//   node tests/checks/decision-parity.ts [case…] [--set merge|nightly] [--update-set] [--jobs <n>] [--verbose]
// --set merge (the default) runs the cases decision-parity-cases.json lists: few enough for every push, chosen so that
// together they ask every question, and read every ledger field and backend input, the full set does. --set nightly
// runs every case; with --update-set it chooses the merge set again from that run, and without it it fails when the
// merge set no longer covers what the full set asks (a new front question, a new ledger field).
import { availableParallelism, tmpdir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

// Before the compiler's modules load: the front decides whether to trace as it loads.
process.env.NS_DECISION_TRACE = '1';
const { diffCases, suiteDir } = await import('../suite.ts');
const { packagesOf, runsOn, selected, kotlinOptions, swiftOptions } = await import('../diff/case-options.ts');
const { KOTLIN_LEDGER, SWIFT_LEDGER } = await import('../../src/semantics/ledger.ts');

interface Decision {
	at: string;
	question: string;
	answers: readonly string[];
	inputs: readonly string[];
	asked: number;
}
interface Mismatch {
	at: string;
	question: string;
	swift: string[];
	kotlin: string[];
	/** The backend inputs (`backend.<hook>`) the answers read that the backends answered differently: the SDK binding, the kit, a backend's own holding. */
	backend: string[];
}
interface Result {
	name: string;
	mismatches: Mismatch[];
	decisions: number;
	/**
	 * What the case exercised on either backend: each question by its entry point (`ValueStates.holdsNil`), each input
	 * an answer read, and each question with its arguments (`QUESTION` before it).
	 */
	covers: string[];
	/** The two backends compiled different modules: not one program, so not compared. */
	programsDiffer?: boolean;
}
interface Work {
	names: string[];
	out: string;
	modules: string;
}

/** Ledger fields whose values differ between the backends: an answer that read one may differ too. */
const differing = new Set(Object.keys(SWIFT_LEDGER).filter((k) => JSON.stringify(SWIFT_LEDGER[k as keyof typeof SWIFT_LEDGER]) !== JSON.stringify(KOTLIN_LEDGER[k as keyof typeof KOTLIN_LEDGER])));

/** Each question asked, by the node it was asked of: its answers and the inputs they read. */
function byQuestion(trace: Decision[]): Map<string, { answers: Set<string>; inputs: Set<string> }> {
	const out = new Map<string, { answers: Set<string>; inputs: Set<string> }>();
	for (const d of trace) {
		const key = `${d.at}\0${d.question}`;
		let e = out.get(key);
		if (!e) out.set(key, (e = { answers: new Set(), inputs: new Set() }));
		for (const a of d.answers) e.answers.add(a);
		for (const l of d.inputs) e.inputs.add(l);
	}
	return out;
}

const QUESTION = 'q:';
/** How many cases the merge set has: those that cover every entry point and input, then those asking most other questions. */
const MERGE_SIZE = 48;

/** A question's entry point, its arguments and node aside: `ValueStates.holdsNil(true)` -> `ValueStates.holdsNil`. */
const entryPoint = (question: string) => question.replace(/\(.*$/s, '');

function coverage(...traces: Decision[][]): string[] {
	const out = new Set<string>();
	for (const t of traces)
		for (const d of t) {
			out.add(entryPoint(d.question));
			out.add(`${QUESTION}${d.question}`);
			for (const i of d.inputs) out.add(i.replace(/^(backend\.\w+)\(.*$/s, '$1'));
		}
	return [...out].sort();
}

const same = (x: Set<string>, y: Set<string>) => x.size === y.size && [...x].every((v) => y.has(v));

/** A backend hook call an answer read (`backend.<hook>(<arguments>)@<node>`): its question's key in a trace, or null for a read charged by name. */
function hookKey(input: string): string | null {
	const at = input.lastIndexOf(')@');
	return input.startsWith('backend.') && at > 0 ? `${input.slice(at + 2)}\0${input.slice(0, at + 1)}` : null;
}

/** `swift` and `kotlin` traced with their own ledgers, `swiftFlipped` and `kotlinFlipped` each with the other's. */
function compare(swift: Decision[], kotlin: Decision[], swiftFlipped: Decision[], kotlinFlipped: Decision[]): Mismatch[] {
	const a = byQuestion(swift),
		b = byQuestion(kotlin),
		af = byQuestion(swiftFlipped),
		bf = byQuestion(kotlinFlipped);
	/** A backend input the two backends answered alike: an answer that read only such inputs is the front's to agree on. */
	const agreed = (input: string) => {
		const key = hookKey(input);
		const x = key && a.get(key),
			y = key && b.get(key);
		return !!x && !!y && same(x.answers, y.answers);
	};
	const out: Mismatch[] = [];
	for (const [key, s] of a) {
		const k = b.get(key);
		// A backend's answer to its own hook is an input, compared where an answer reads it.
		if (!k || same(s.answers, k.answers) || key.includes('\0backend.')) continue;
		const inputs = [...s.inputs, ...k.inputs];
		if (inputs.some((l) => l.startsWith('ledger.') && differing.has(l.slice('ledger.'.length)))) continue;
		const sf = af.get(key),
			kf = bf.get(key);
		if ((sf && !same(sf.answers, s.answers)) || (kf && !same(kf.answers, k.answers))) continue;
		const [at, question] = key.split('\0');
		const backend = [...new Set(inputs.filter((l) => l.startsWith('backend.') && !agreed(l)).map((l) => l.replace(/\(.*$/s, '')))].sort();
		out.push({ at, question, swift: [...s.answers].sort(), kotlin: [...k.answers].sort(), backend });
	}
	return out;
}

if (!isMainThread) {
	const { names, out, modules } = workerData as Work;
	const nb = await import('../native-build.ts');
	const trace = await import('../../src/semantics/decision-trace.ts');
	const results: Result[] = [];
	for (const name of names) {
		const file = join(diffCases, name + '.ts');
		const extra = packagesOf(file) ? { modules } : {};
		/** The modules a translation compiled, a platform's file (`x.ios.ts`) as the module it is (`x`); null where it was refused. */
		const compiled: (string[] | null)[] = [];
		const traced = (target: 'swift' | 'kotlin', ledger?: typeof SWIFT_LEDGER): Decision[] => {
			const dir = join(out, target, name);
			mkdirSync(dir, { recursive: true });
			trace.startDecisionTrace();
			try {
				const modules = target === 'swift' ? nb.translateSwift([file], dir, { ...swiftOptions(file), ...extra, ledger }) : nb.translateKotlin([file], dir, 'case_' + name.replace(/\W/g, '_'), { ...kotlinOptions(file), ...extra, ledger });
				compiled.push(modules.map((m) => m.file.replace(/\.(ios|android)(?=\.ts$)/, '')).sort());
			} catch {
				// A refusal ends the translation; the questions answered before it still count.
				compiled.push(null);
			}
			rmSync(dir, { recursive: true, force: true });
			return trace.takeDecisionTrace();
		};
		const swift = traced('swift'),
			kotlin = traced('kotlin');
		// A package that ships one platform's source only (its other platform typed by its declarations) makes two programs.
		const imports = (t: Decision[]) => t.find((d) => d.question === 'program.imports')?.answers.join('\n');
		if ((compiled[0] && compiled[1] && compiled[0].join('\n') !== compiled[1].join('\n')) || imports(swift) !== imports(kotlin)) {
			results.push({ name, mismatches: [], decisions: 0, covers: [], programsDiffer: true });
			continue;
		}
		results.push({ name, mismatches: compare(swift, kotlin, traced('swift', KOTLIN_LEDGER), traced('kotlin', SWIFT_LEDGER)), decisions: [...swift, ...kotlin].reduce((n, d) => n + d.asked, 0), covers: coverage(swift, kotlin) });
	}
	parentPort!.postMessage(results);
} else {
	const argv = process.argv.slice(2);
	const valued = new Set(['--jobs', '--set']);
	const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
	const args = argv.filter((a, k) => !a.startsWith('--') && !valued.has(argv[k - 1]));
	const jobs = Number(flag('--jobs') ?? Math.max(1, availableParallelism() - 2));
	const set = flag('--set') ?? 'merge';
	if (set !== 'merge' && set !== 'nightly') throw new Error(`--set is merge or nightly, not ${set}`);
	const update = argv.includes('--update-set');
	if (update && (set !== 'nightly' || args.length)) throw new Error('--update-set chooses the merge set from a run of every case: --set nightly, no case arguments');
	const setFile = join(suiteDir, 'checks/decision-parity-cases.json');
	const gapsFile = join(suiteDir, 'checks/decision-parity-gaps.json');
	/** Differences the ledger names as a gap, by case, place and question (`<case>|<file:line kind>|<question's entry point>`). */
	const gaps: Record<string, string> = existsSync(gapsFile) ? JSON.parse(readFileSync(gapsFile, 'utf8')).gaps : {};
	// A suite with no merge set of its own (an adapter's) runs every case.
	const mergeSet: string[] | null = existsSync(setFile) ? JSON.parse(readFileSync(setFile, 'utf8')).cases : null;
	const all = readdirSync(diffCases)
		.filter((f) => f.endsWith('.ts'))
		.map((f) => basename(f, '.ts'))
		.sort()
		.filter((n) => runsOn(join(diffCases, n + '.ts'), 'swift') && runsOn(join(diffCases, n + '.ts'), 'kotlin'));
	const names = args.length ? selected(args, all) : set === 'merge' && mergeSet ? all.filter((n) => mergeSet.includes(n)) : all;
	const root = join(process.env.NS_DIFF_BUILD ?? join(tmpdir(), 'ns-compiled-diff'), 'decision-parity');
	rmSync(root, { recursive: true, force: true });
	const { caseModules } = await import('../native-build.ts');
	const modules = caseModules(join(root, 'build'));
	const self = fileURLToPath(import.meta.url);
	const started = Date.now();
	const slices = Array.from({ length: Math.min(jobs, names.length) }, (_, k) => names.filter((_, i) => i % jobs === k));
	const results = (
		await Promise.all(
			slices.map(
				(slice) =>
					new Promise<Result[]>((done, fail) => {
						const w = new Worker(self, { workerData: { names: slice, out: root, modules } satisfies Work, resourceLimits: { maxOldGenerationSizeMb: 8192 } });
						w.once('message', done);
						w.once('error', fail);
						w.once('exit', (code) => code && fail(new Error(`worker exited ${code}`)));
					}),
			),
		)
	)
		.flat()
		.sort((x, y) => (x.name < y.name ? -1 : 1));
	const where = (at: string): string => {
		const m = /^(.*):(-?\d+):(\d+):(\w+)$/.exec(at);
		if (!m) return at;
		const [, file, start, , kind] = m;
		let line = 1;
		try {
			const text = readFileSync(file, 'utf8');
			for (let i = 0; i < Number(start) && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
		} catch {
			return at;
		}
		return `${relative(dirname(suiteDir), file).replace(/\\/g, '/')}:${line} ${kind}`;
	};
	const verbose = argv.includes('--verbose');
	let failures = 0,
		backendKeyed = 0,
		named = 0,
		decisions = 0;
	const seenGaps = new Set<string>();
	const keyedBy = new Map<string, number>();
	const apart = results.filter((r) => r.programsDiffer).map((r) => r.name);
	for (const r of results) {
		decisions += r.decisions;
		for (const m of r.mismatches) {
			const show = () => console.log(`${m.backend.length ? '·' : '✗'} ${r.name}: ${where(m.at)} ${m.question}${m.backend.length ? ` [${m.backend.join(', ')}]` : ''}\n    swift:  ${m.swift.join(' | ').slice(0, 400)}\n    kotlin: ${m.kotlin.join(' | ').slice(0, 400)}`);
			if (!m.backend.length) {
				const gap = gaps[`${r.name}|${where(m.at)}|${entryPoint(m.question)}`];
				if (gap && differing.has(gap)) {
					seenGaps.add(`${r.name}|${where(m.at)}|${entryPoint(m.question)}`);
					named++;
					if (verbose) console.log(`○ ${r.name}: ${where(m.at)} ${m.question} [ledger.${gap}]`);
					continue;
				}
				failures++;
				show();
				continue;
			}
			// Answers from a backend's spelled types, binding or kit: compared once the front gives them (NativeType).
			backendKeyed++;
			for (const b of m.backend) keyedBy.set(b, (keyedBy.get(b) ?? 0) + 1);
			if (verbose) show();
		}
	}
	rmSync(root, { recursive: true, force: true });
	let uncovered: string[] = [];
	let stale: string[] = [];
	if (set === 'nightly' && !args.length) {
		stale = Object.keys(gaps).filter((k) => !seenGaps.has(k));
		if (stale.length) console.log(`✗ ${relative(process.cwd(), gapsFile)} lists differences no case shows any more: ${stale.join(', ')}`);
		const covered = new Set(results.filter((r) => mergeSet?.includes(r.name)).flatMap((r) => r.covers));
		uncovered = [...new Set(results.flatMap((r) => r.covers))].filter((c) => !c.startsWith(QUESTION) && !covered.has(c)).sort();
		if (update) {
			const cases = cover(results);
			writeFileSync(setFile, JSON.stringify({ $comment: 'The per-merge set of tests/checks/decision-parity.ts: cases that together ask every question, and read every ledger field and backend input, the full set does, then those asking most other questions (`--set nightly --update-set` chooses them again).', cases }, null, '\t') + '\n');
			console.log(`decision parity: the merge set is ${cases.length} cases (${relative(process.cwd(), setFile)})`);
			uncovered = [];
		} else if (uncovered.length) console.log(`✗ the merge set (${relative(process.cwd(), setFile)}) asks none of: ${uncovered.join(', ')}\n  node tests/checks/decision-parity.ts --set nightly --update-set chooses it again`);
	}
	console.log(
		`decision parity: ${names.length} cases on both backends, ${decisions} decisions, ${failures} answered differently; ${named} named by a ledger gap (${relative(process.cwd(), gapsFile)}); ${backendKeyed} more differ by what a backend answers of its own (${
			[...keyedBy]
				.sort((x, y) => y[1] - x[1])
				.map(([k, n]) => `${k} ${n}`)
				.join(', ') || 'none'
		}) ${apart.length ? `; not compared, each backend compiling other modules: ${apart.join(', ')}` : ''} (${Math.round((Date.now() - started) / 1000)} s)`,
	);
	process.exit(failures || uncovered.length || stale.length ? 1 : 0);
}

/**
 * Few cases covering what every case covers: greedily the case covering most of what is left, ties to the case asked
 * fewest questions (the cheaper translation), then by name; first over entry points and inputs until none is left, then
 * over every question until the set has `MERGE_SIZE` cases.
 */
function cover(results: Result[]): string[] {
	const left = new Set(results.flatMap((r) => r.covers));
	const chosen: Result[] = [];
	const pick = (counts: (c: string) => boolean): Result | null => {
		let best: Result | null = null,
			gain = 0;
		for (const r of results) {
			if (chosen.includes(r)) continue;
			const g = r.covers.filter((c) => left.has(c) && counts(c)).length;
			if (g > gain || (g === gain && g > 0 && best && (r.decisions < best.decisions || (r.decisions === best.decisions && r.name < best.name)))) {
				best = r;
				gain = g;
			}
		}
		return best;
	};
	const take = (r: Result) => {
		chosen.push(r);
		for (const c of r.covers) left.delete(c);
	};
	for (let r = pick((c) => !c.startsWith(QUESTION)); r; r = pick((c) => !c.startsWith(QUESTION))) take(r);
	for (let r = chosen.length < MERGE_SIZE ? pick(() => true) : null; r; r = chosen.length < MERGE_SIZE ? pick(() => true) : null) take(r);
	return chosen.map((r) => r.name).sort();
}
