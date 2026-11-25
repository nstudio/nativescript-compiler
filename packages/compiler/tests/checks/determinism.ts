#!/usr/bin/env node
// A diff case translates to the same text whatever ran before it in the process: every case is translated once inside the
// suite (one fresh worker translating them all, in the diff harness's order) and once alone (a fresh worker per case), and
// the two outputs, files or refusal, must be byte-identical. A worker thread has its own module instances, so "alone"
// starts from no module state at all.
//   node tests/checks/determinism.ts [case…] [--swift | --kotlin] [--jobs <n>] [--keep]
import { availableParallelism, tmpdir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { caseModules, kotlinMain, swiftMain, translateKotlin, translateSwift } from '../native-build.ts';
import { diffCases } from '../suite.ts';
import { kotlinOptions, packagesOf, runsOn, selected, swiftOptions } from '../diff/case-options.ts';

type Target = 'swift' | 'kotlin';
interface Job {
	name: string;
	target: Target;
}
interface Work {
	jobs: Job[];
	out: string;
	modules: string;
}

/** The case translated as tests/diff/run.ts translates it, into `dir`; a translation that fails leaves its message. */
function translate(job: Job, dir: string, modules: string): void {
	const file = join(diffCases, job.name + '.ts');
	const extra = packagesOf(file) ? { modules } : {};
	try {
		if (job.target === 'swift') writeFileSync(join(dir, 'main.swift'), swiftMain(translateSwift([file], dir, { ...swiftOptions(file), ...extra })));
		else {
			const pkg = 'case_' + job.name.replace(/\W/g, '_');
			writeFileSync(join(dir, '__Main.kt'), kotlinMain(translateKotlin([file], dir, pkg, { ...kotlinOptions(file), ...extra }), pkg));
		}
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '__error.txt'), (err as Error).message);
	}
}

if (!isMainThread) {
	const { jobs, out, modules } = workerData as Work;
	for (const job of jobs) translate(job, join(out, job.target, job.name), modules);
	parentPort!.postMessage('done');
} else {
	const argv = process.argv.slice(2);
	const valued = new Set(['--jobs']);
	const args = argv.filter((a, k) => !a.startsWith('--') && !valued.has(argv[k - 1]));
	const jobsArg = argv.includes('--jobs') ? Number(argv[argv.indexOf('--jobs') + 1]) : Math.max(1, availableParallelism() - 2);
	const targets: Target[] = argv.includes('--swift') ? ['swift'] : argv.includes('--kotlin') ? ['kotlin'] : ['swift', 'kotlin'];
	const names = selected(
		args,
		readdirSync(diffCases)
			.filter((f) => f.endsWith('.ts'))
			.map((f) => basename(f, '.ts')),
	).sort();
	const jobs = targets.flatMap((target) => names.filter((n) => runsOn(join(diffCases, n + '.ts'), target)).map((name) => ({ name, target })));
	const root = join(process.env.NS_DIFF_BUILD ?? join(tmpdir(), 'ns-compiled-diff'), 'determinism');
	rmSync(root, { recursive: true, force: true });
	const modules = caseModules(join(root, 'build'));
	const self = fileURLToPath(import.meta.url);
	const run = (work: Work) =>
		new Promise<void>((done, fail) => {
			const w = new Worker(self, { workerData: work });
			w.once('message', () => done());
			w.once('error', fail);
			w.once('exit', (code) => (code ? fail(new Error(`worker exited ${code}`)) : done()));
		});
	const started = Date.now();
	const suite = run({ jobs, out: join(root, 'suite'), modules });
	let next = 0;
	const alone = Array.from({ length: jobsArg }, async () => {
		while (next < jobs.length) {
			const job = jobs[next++];
			await run({ jobs: [job], out: join(root, 'alone'), modules });
		}
	});
	await Promise.all([suite, ...alone]);

	const files = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => !f.includes('node_modules')).sort() : []);
	const differing: string[] = [];
	for (const job of jobs) {
		const a = join(root, 'suite', job.target, job.name);
		const b = join(root, 'alone', job.target, job.name);
		const fa = files(a);
		const fb = files(b);
		const changed = [...new Set([...fa, ...fb])].filter((f) => !fa.includes(f) || !fb.includes(f) || !readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
		if (changed.length) differing.push(`${job.name} (${job.target}): ${changed.map((f) => relative('.', f)).join(', ')}`);
	}
	for (const d of differing) console.log(`✗ ${d}`);
	console.log(`${jobs.length - differing.length} of ${jobs.length} translations identical alone and in the suite (${targets.join(', ')}; ${Math.round((Date.now() - started) / 1000)} s)`);
	if (!argv.includes('--keep') && !differing.length) rmSync(root, { recursive: true, force: true });
	else console.log(`outputs: ${root}/{suite,alone}`);
	process.exit(differing.length ? 1 : 0);
}
