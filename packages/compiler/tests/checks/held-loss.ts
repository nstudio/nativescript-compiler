#!/usr/bin/env node
// Held losses: every place a translation spells a value standing in for undefined or null (NaN, "undefined", "", 0,
// false, a type's zero) or asserts one away (Swift `!`, Kotlin `!!`), as the backends report it through the front's
// `heldLoss` (src/semantics/losses.ts), for the kits (both), the diff cases, this check's probes and any app given.
// Each site has a reason (`LossReason`), `unnamed` where nothing allows it, or none where JavaScript itself converts
// (an operand, a condition); an unwrap has a proof or `unproven`. Prints counts; the full list goes to --out.
//   node tests/checks/held-loss.ts [--no-kits] [--no-cases] [--app <folder>]… [--out <file>] [--jobs <n>] [case…]
// An app translates with src/driver/cli.ts for iOS and Android ($NS_COMPILER_ADAPTERS passed on); kits with
// tools/kit/generate*.mts --report, which writes nothing.
import { availableParallelism, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

// Before the compiler's modules load: the front decides whether to record as it loads.
process.env.NS_HELD_LOSS ||= '1';
const { diffCases } = await import('../suite.ts');
const { packagesOf, runsOn, selected, kotlinOptions, swiftOptions } = await import('../diff/case-options.ts');
type HeldLoss = import('../../src/semantics/losses.ts').HeldLoss;

/** A site and the translation it was found in: `kit`, `case:<name>`, `probe:<name>`, `app:<name>`. */
interface Found extends HeldLoss {
	corpus: string;
}
interface Work {
	files: string[];
	out: string;
	modules: string;
}

const compiler = resolve(import.meta.dirname, '../..');
const probes = join(import.meta.dirname, 'held-loss-probes');

if (!isMainThread) {
	const { files, out, modules } = workerData as Work;
	const nb = await import('../native-build.ts');
	const losses = await import('../../src/semantics/losses.ts');
	const found: Found[] = [];
	for (const file of files) {
		const name = basename(file, '.ts');
		const corpus = file.startsWith(probes) ? `probe:${name}` : `case:${name}`;
		const extra = packagesOf(file) ? { modules } : {};
		for (const target of ['swift', 'kotlin'] as const) {
			if (!runsOn(file, target)) continue;
			const dir = join(out, target, name);
			mkdirSync(dir, { recursive: true });
			losses.takeHeldLosses();
			try {
				if (target === 'swift') nb.translateSwift([file], dir, { ...swiftOptions(file), ...extra });
				else nb.translateKotlin([file], dir, 'case_' + name.replace(/\W/g, '_'), { ...kotlinOptions(file), ...extra });
			} catch {
				// A refusal ends the translation; the sites found before it still count.
			}
			rmSync(dir, { recursive: true, force: true });
			for (const l of losses.takeHeldLosses()) found.push({ ...l, corpus });
		}
	}
	parentPort!.postMessage(found);
} else {
	const argv = process.argv.slice(2);
	const valued = new Set(['--jobs', '--out', '--app']);
	const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
	const apps = argv.flatMap((a, k) => (argv[k - 1] === '--app' ? [resolve(a)] : []));
	const args = argv.filter((a, k) => !a.startsWith('--') && !valued.has(argv[k - 1]));
	const jobs = Number(flag('--jobs') ?? Math.max(1, Math.min(8, availableParallelism() - 2)));
	const root = join(process.env.NS_DIFF_BUILD ?? join(tmpdir(), 'ns-compiled-diff'), 'held-loss');
	const outFile = resolve(flag('--out') ?? join(root, 'held-loss.txt'));
	rmSync(join(root, 'work'), { recursive: true, force: true });
	const found: Found[] = [];

	/** Sites a process translating out of this one appended to `folder` (src/semantics/losses.ts). */
	const appended = (folder: string, corpus: string): Found[] =>
		existsSync(folder)
			? readdirSync(folder)
					.filter((f) => f.endsWith('.jsonl'))
					.flatMap((f) => readFileSync(join(folder, f), 'utf8').split('\n').filter(Boolean))
					.map((l) => ({ ...(JSON.parse(l) as HeldLoss), corpus }))
			: [];
	const run = (label: string, folder: string, cmd: string[], cwd: string): void => {
		rmSync(folder, { recursive: true, force: true });
		const r = spawnSync(process.execPath, cmd, { cwd, env: { ...process.env, NS_HELD_LOSS: folder }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 28 });
		if (r.status !== 0) console.log(`held-loss: ${label} exited ${r.status}: ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
	};

	if (!argv.includes('--no-kits') && !args.length) {
		for (const [platform, script] of [
			['ios', 'tools/kit/generate.mts'],
			['android', 'tools/kit/generate-android.mts'],
		] as const) {
			const folder = join(root, 'work', `kit-${platform}`);
			run(`kit ${platform}`, folder, ['--stack-size=8000', script, '--report'], compiler);
			found.push(...appended(folder, 'kit'));
		}
	}

	for (const app of apps) {
		const name = basename(app);
		for (const platform of ['ios', 'android']) {
			const folder = join(root, 'work', `app-${name}-${platform}`);
			const out = join(root, 'work', `app-${name}-${platform}-out`);
			run(`app ${name} ${platform}`, folder, [join(compiler, 'src/driver/cli.ts'), app, '--platform', platform, '--out', out, '--name', name.replace(/\W/g, ''), '--bundle', `org.nativescript.heldloss.${name.replace(/\W/g, '')}`, '--skip-toolchain-check', '--allow-core-mismatch'], app);
			found.push(...appended(folder, `app:${name}`));
			rmSync(out, { recursive: true, force: true });
		}
	}

	if (!argv.includes('--no-cases')) {
		const all = [
			...readdirSync(diffCases)
				.filter((f) => f.endsWith('.ts'))
				.map((f) => join(diffCases, f)),
			...readdirSync(probes)
				.filter((f) => f.endsWith('.ts'))
				.map((f) => join(probes, f)),
		].sort();
		const names = all.map((f) => basename(f, '.ts'));
		const files = args.length ? selected(args, names).map((n) => all[names.indexOf(n)]) : all;
		const { caseModules } = await import('../native-build.ts');
		const modules = caseModules(join(root, 'build'));
		const self = fileURLToPath(import.meta.url);
		const slices = Array.from({ length: Math.min(jobs, files.length) }, (_, k) => files.filter((_, i) => i % jobs === k));
		const results = await Promise.all(
			slices.map(
				(slice) =>
					new Promise<Found[]>((done, fail) => {
						const w = new Worker(self, { workerData: { files: slice, out: join(root, 'work'), modules } satisfies Work, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
						w.once('message', done);
						w.once('error', fail);
						w.once('exit', (code) => code && fail(new Error(`worker exited ${code}`)));
					}),
			),
		);
		found.push(...results.flat());
	}
	rmSync(join(root, 'work'), { recursive: true, force: true });

	const repo = resolve(compiler, '../..');
	const shown = (f: Found): string => {
		const at = f.at.startsWith(repo + '/') ? relative(repo, f.at) : (apps.map((a) => (f.at.startsWith(a + '/') ? `${basename(a)}/${relative(a, f.at)}` : null)).find(Boolean) ?? f.at);
		return [f.corpus, f.backend, f.form === 'unwrap' ? `unwrap:${f.proof}` : f.source ? `${f.reason}/${f.source}` : (f.reason ?? 'js'), f.emitter, f.spelled, f.use, f.mode, at, f.node].join('\t');
	};
	const lines = [...new Set(found.map(shown))].sort();
	mkdirSync(join(outFile, '..'), { recursive: true });
	writeFileSync(outFile, ['# corpus\tbackend\treason (js: an operand or condition; a zero\'s /own or /entry: where its empty value comes from) or unwrap:proof\temitter\tspelled\tuse\tmode\tat\tnode', ...lines].join('\n') + '\n');

	const kindOf = (corpus: string) => corpus.replace(/:.*$/, '');
	const rows = lines.map((l) => l.split('\t'));
	const count = (key: (r: string[]) => string, of = rows): Map<string, number> => {
		const m = new Map<string, number>();
		for (const r of of) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
		return new Map([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	};
	const table = (title: string, m: Map<string, number>) => {
		console.log(`\n${title}`);
		for (const [k, n] of m) console.log(`  ${String(n).padStart(6)}  ${k}`);
	};
	console.log(`held-loss: ${rows.length} sites (${count((r) => kindOf(r[0])).size} corpora kinds); full list in ${outFile}`);
	table(
		'by reason or proof, backend, corpus',
		count((r) => `${r[2].padEnd(22)} ${r[1].padEnd(7)} ${kindOf(r[0])}`),
	);
	table(
		'by emitter, backend',
		count((r) => `${r[3].padEnd(22)} ${r[1].padEnd(7)} ${r[2]}`),
	);
	table(
		'unnamed, by spelled, use, corpus',
		count(
			(r) => `${r[4].padEnd(12)} ${r[5].padEnd(16)} ${kindOf(r[0])}`,
			rows.filter((r) => r[2] === 'unnamed'),
		),
	);
	table(
		'unproven unwraps, by emitter, use, corpus',
		count(
			(r) => `${r[3].padEnd(16)} ${r[5].padEnd(16)} ${kindOf(r[0])}`,
			rows.filter((r) => r[2] === 'unwrap:unproven'),
		),
	);
	const probed = rows.filter((r) => r[0].startsWith('probe:'));
	if (probed.length) {
		console.log('\nprobe sites');
		for (const r of probed) console.log(`  ${r.join('  ')}`);
	}
}
