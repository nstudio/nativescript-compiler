// The package's documentation against the code:
// - each generated section (between `<!-- generated: <name> -->` and `<!-- /generated -->`) is what its generator
//   writes from the source it names: the refusal catalog (src/semantics/refusals.ts), the ledger
//   (src/semantics/ledger.ts), the diff suite's composition (the cases' directives and diff/known-failures.json);
// - every relative link resolves to a file, and every `#anchor` to a heading of the file it names; a doc the npm package
//   lists in `files` links only to files it ships, and names the repository's others by their GitHub URL (`REPO_URL`),
//   checked as the local file it names (npm's page resolves the README's relative links against `repository` itself);
// - every path a doc names in backticks (a token with a `/`) exists, from the package root, its src/, the doc's folder
//   or the repository root, unless it is build output (OUTPUT) or EXTERNAL lists it;
// - the kit's runtime-to-ECMA-262 table (docs/KIT.md) has a row for every file of both kits' runtimes;
// - test262's results table (tests/test262/README.md, which run.ts --report --readme writes) agrees with
//   tests/test262/baseline.json: the same test262 commit, and per backend the tests that do not pass, by column.
// Counts in prose go stale; a count a doc needs is one of these sections.
//   node tests/checks/docs.ts [--write]
// --write rewrites the generated sections, then checks the rest.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { REFUSALS } from '../../src/semantics/refusals.ts';
import { KOTLIN_LEDGER, LEDGER_KINDS, ONE_BACKEND_REFUSALS, SWIFT_LEDGER, type Ledger } from '../../src/semantics/ledger.ts';
import { refusedWith, runsOn } from '../diff/case-options.ts';
import { columnOf, type Column } from '../test262/columns.ts';

const pkg = resolve(import.meta.dirname, '../..');
const repo = resolve(pkg, '../..');
const write = process.argv.includes('--write');

/** Paths the docs name that live in another repository, each with where. */
const EXTERNAL: Record<string, string> = {
	'lib/services/compiled-release-service.ts': 'the NativeScript CLI',
};
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { files: string[]; repository: { url: string; directory: string } };
/** The package's files on GitHub's main branch: a shipped doc's link to a file the package does not ship. */
const REPO_URL = `${manifest.repository.url.replace(/\.git$/, '')}/blob/main/${manifest.repository.directory}/`;
/** Whether a `files` entry of the npm package names `path` (from the package root) or a folder holding it. */
const shipped = (path: string) => manifest.files.some((f) => (f.endsWith('/') ? path.startsWith(f) : path === f));

/** Paths a build writes, which a checkout does not have until it runs. */
const OUTPUT = /^(?:dist\/|platforms\/|kit-apple\/Sources\/NativeScriptKit\/Core|kit-android\/generated|generated\/)/;

const files = (...pattern: string[]) => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...pattern], { cwd: pkg, encoding: 'utf8' });
const docs = files('*.md')
	.split('\n')
	.filter((f) => f && !f.startsWith('tests/diff/cases/'));
const problems: string[] = [];

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const yes = (v: unknown) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : `\`${String(v)}\``);

function refusalTable(cls: 'limit' | 'excluded' | 'gap'): string {
	const rows = Object.entries(REFUSALS)
		.filter(([, r]) => r.class === cls)
		.map(([id, r]) => {
			const why = 'why' in r && r.why ? ` (${r.why})` : '';
			const one = ONE_BACKEND_REFUSALS[id as keyof typeof ONE_BACKEND_REFUSALS];
			const where = one ? `one backend: [\`${one}\`](#the-ledger)` : 'both';
			return `| \`${id}\` | ${cell(r.title + why)} | ${cell(r.suggestion)} | ${where} |`;
		});
	return ['| Id | What is refused | What to write instead | Refused on |', '|---|---|---|---|', ...rows].join('\n');
}

/** Text up to its first full stop outside code and parentheses that ends the text or comes before a capital. */
function firstSentence(text: string): string {
	let code = false;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '`') code = !code;
		else if (!code && c === '(') depth++;
		else if (!code && c === ')') depth--;
		else if (!code && !depth && c === '.' && (i === text.length - 1 || /^\s+[A-Z`]/.test(text.slice(i + 1)))) return text.slice(0, i + 1);
	}
	return text;
}

/** Each ledger field's doc comment, its first sentence. */
function ledgerDocs(): Map<string, string> {
	const file = join(pkg, 'src/semantics/ledger.ts');
	const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const out = new Map<string, string>();
	sf.forEachChild((n) => {
		if (!ts.isInterfaceDeclaration(n) || n.name.text !== 'Ledger') return;
		for (const m of n.members) {
			const doc = ts
				.getJSDocCommentsAndTags(m)
				.map((d) => (typeof d.comment === 'string' ? d.comment : ''))
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim();
			out.set((m.name as ts.Identifier).text, firstSentence(doc));
		}
	});
	return out;
}

function ledgerTable(kind: 'platform' | 'gap'): string {
	const doc = ledgerDocs();
	const rows = (Object.keys(LEDGER_KINDS) as (keyof Ledger)[])
		.filter((k) => LEDGER_KINDS[k] === kind)
		.map((k) => `| \`${k}\` | ${yes(SWIFT_LEDGER[k])} | ${yes(KOTLIN_LEDGER[k])} | ${cell(doc.get(k) ?? '')} |`);
	return ['| Entry | Swift | Kotlin | What it says |', '|---|---|---|---|', ...rows].join('\n');
}

function diffSuiteTable(): string {
	const cases = join(pkg, 'tests/diff/cases');
	const files = readdirSync(cases)
		.filter((f) => f.endsWith('.ts'))
		.map((f) => join(cases, f));
	const known = JSON.parse(readFileSync(join(pkg, 'tests/diff/known-failures.json'), 'utf8'));
	const rows = (['swift', 'kotlin'] as const).map((b) => {
		const runs = files.filter((f) => runsOn(f, b));
		const refused = runs.filter((f) => refusedWith(f, b)).length;
		const failing = Object.keys(known[b] ?? {}).length;
		const only = runs.filter((f) => !runsOn(f, b === 'swift' ? 'kotlin' : 'swift')).length;
		return `| ${b === 'swift' ? 'Swift' : 'Kotlin'} | ${runs.length} | ${only} | ${refused} | ${failing} | ${runs.length - refused - failing} |`;
	});
	return [
		`${files.length} cases in \`tests/diff/cases\`.`,
		'',
		'| Backend | Runs | Of them on this backend only | Refused, as the case declares | Known failures | Match Node |',
		'|---|---:|---:|---:|---:|---:|',
		...rows,
	].join('\n');
}

const GENERATORS: Record<string, () => string> = {
	'refusals-limit': () => refusalTable('limit'),
	'refusals-excluded': () => refusalTable('excluded'),
	'refusals-gap': () => refusalTable('gap'),
	'ledger-platform': () => ledgerTable('platform'),
	'ledger-gap': () => ledgerTable('gap'),
	'diff-suite': diffSuiteTable,
};

const SECTION = /(<!-- generated: ([\w-]+) -->\n)([\s\S]*?)(<!-- \/generated -->)/g;
for (const doc of docs) {
	const file = join(pkg, doc);
	const text = readFileSync(file, 'utf8');
	const next = text.replace(SECTION, (_all, open: string, name: string, body: string, close: string) => {
		const gen = GENERATORS[name];
		if (!gen) {
			problems.push(`${doc}: no generator is named ${name}`);
			return open + body + close;
		}
		const now = `${gen()}\n`;
		if (now !== body && !write) problems.push(`${doc}: the generated section ${name} is stale: run node tests/checks/docs.ts --write`);
		return open + now + close;
	});
	if (write && next !== text) {
		writeFileSync(file, next);
		console.log(`wrote ${doc}`);
	}
}

/** GitHub's anchor for a heading's text. */
function slug(heading: string): string {
	return heading
		.replace(/<[^>]+>/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
		.replace(/ /g, '-');
}

function anchors(file: string): Set<string> {
	const out = new Set<string>();
	const seen = new Map<string, number>();
	let fenced = false;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (line.startsWith('```')) fenced = !fenced;
		const m = !fenced && /^#{1,6} (.+)$/.exec(line);
		if (!m) continue;
		const s = slug(m[1].trim());
		const n = seen.get(s) ?? 0;
		seen.set(s, n + 1);
		out.add(n ? `${s}-${n}` : s);
	}
	for (const m of readFileSync(file, 'utf8').matchAll(/<a (?:name|id)="([^"]+)"/g)) out.add(m[1]);
	return out;
}

const ROOTS = ['', 'src', 'src/semantics', 'tests', 'kit-apple/Sources/NativeScriptKit', 'kit-android/src/main/kotlin/org/nativescript/kit'];
function pathExists(token: string, docDir: string): boolean {
	const bare = token.replace(/[#:].*$/, '').replace(/\/$/, '');
	return [docDir, ...ROOTS.map((r) => join(pkg, r)), repo].some((base) => existsSync(join(base, bare)));
}

/** A backticked token that names a file or folder of this repository. */
const PATHLIKE = /^(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\/?$/;
const FILE_EXT = /\.(?:ts|mts|mjs|js|json|md|swift|kt|kts|sh|py|txt|yml)$/;

for (const doc of docs) {
	const file = join(pkg, doc);
	const dir = dirname(file);
	let fenced = false;
	const lines = readFileSync(file, 'utf8').split('\n');
	lines.forEach((line, i) => {
		if (line.startsWith('```')) fenced = !fenced;
		if (fenced) return;
		const at = `${doc}:${i + 1}`;
		for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = m[1];
			const repoLink = target.startsWith(REPO_URL);
			if (/^[a-z]+:/.test(target) && !repoLink) continue;
			const [path, anchor] = (repoLink ? target.slice(REPO_URL.length) : target).split('#');
			const into = repoLink ? join(pkg, path) : path ? resolve(dir, path) : file;
			if (!repoLink && shipped(doc) && !shipped(relative(pkg, into))) problems.push(`${at}: the package ships ${doc} but not ${relative(pkg, into)}: link it as ${REPO_URL}${relative(pkg, into)}`);
			if (!existsSync(into)) problems.push(`${at}: the link ${target} names no file`);
			else if (anchor && into.endsWith('.md') && !anchors(into).has(anchor)) problems.push(`${at}: the link ${target} names no heading of ${relative(pkg, into)}`);
		}
		for (const m of line.matchAll(/`([^`\s]+)`/g)) {
			const token = m[1];
			if (!token.includes('/') || EXTERNAL[token] || OUTPUT.test(token) || !PATHLIKE.test(token) || token.startsWith('@')) continue;
			const looksLikePath = FILE_EXT.test(token) || /^(?:src|tests|tools|bin|docs|bench|verify|kit-apple|kit-android|\.github)\//.test(token);
			if (looksLikePath && !pathExists(token, dir)) problems.push(`${at}: \`${token}\` names no file of the repository`);
		}
	});
}

const KIT_DOC = join(pkg, 'docs/KIT.md');
const kitDoc = existsSync(KIT_DOC) ? readFileSync(KIT_DOC, 'utf8') : '';
const runtimeDirs = ['kit-apple/Sources/NativeScriptKit/Runtime', 'kit-android/src/main/kotlin/org/nativescript/kit/runtime'];
for (const d of runtimeDirs)
	for (const f of readdirSync(join(pkg, d)).filter((f) => /\.(swift|kt)$/.test(f)))
		if (!kitDoc.includes(`\`${f}\``)) problems.push(`docs/KIT.md: the runtime table has no row for ${d}/${f}`);

/** Each column of the test262 README's backend rows that baseline.json's entries (`<status>: <detail>`) also count. */
const NOT_PASSING: Column[] = ['refused', 'type check rejected', 'compile error', 'wrong output'];
function test262AgainstBaseline(): void {
	const readme = 'tests/test262/README.md';
	const text = readFileSync(join(pkg, readme), 'utf8');
	const baseline = JSON.parse(readFileSync(join(pkg, 'tests/test262/baseline.json'), 'utf8')) as Record<string, unknown> & { commit: string };
	const commit = /^test262 `([0-9a-f]+)`/m.exec(text)?.[1];
	if (!commit || !baseline.commit.startsWith(commit)) problems.push(`${readme}: results measured at test262 ${commit ?? '(none)'}, baseline.json at ${baseline.commit.slice(0, 10)}`);
	const header = text.split('\n').find((l) => l.startsWith('| Backend |'));
	if (!header) return void problems.push(`${readme}: no results table`);
	const names = header.split('|').map((c) => c.trim().toLowerCase());
	const number = (row: string[], name: string) => Number(row[names.indexOf(name)].replace(/,/g, ''));
	for (const [backend, label] of [['swift', 'Swift'], ['kotlin', 'Kotlin']] as const) {
		const line = text.split('\n').find((l) => l.startsWith(`| ${label} |`));
		if (!line) {
			problems.push(`${readme}: no ${label} row in the results table`);
			continue;
		}
		const row = line.split('|').map((c) => c.trim());
		const counts = new Map<Column, number>(NOT_PASSING.map((c) => [c, 0]));
		for (const entry of Object.values((baseline[backend] ?? {}) as Record<string, string>)) {
			const at = entry.indexOf(': ');
			const column = columnOf({ status: entry.slice(0, at), detail: entry.slice(at + 2) });
			counts.set(column, (counts.get(column) ?? 0) + 1);
		}
		const notPassing = NOT_PASSING.reduce((n, c) => n + counts.get(c)!, 0);
		if (number(row, 'counted') - number(row, 'pass') !== notPassing) problems.push(`${readme}: ${label} counts ${number(row, 'counted') - number(row, 'pass')} tests not passing, baseline.json ${notPassing}: run tests/test262/run.ts and --report --readme at one commit`);
		for (const c of NOT_PASSING) if (number(row, c) !== counts.get(c)) problems.push(`${readme}: ${label} ${c} ${number(row, c)}, baseline.json ${counts.get(c)}`);
	}
}
test262AgainstBaseline();

for (const p of problems) console.log(`✗ ${p}`);
if (problems.length) process.exit(1);
console.log(`docs: ${docs.length} documents, generated sections current, links and paths resolve`);
