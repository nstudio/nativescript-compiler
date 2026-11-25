#!/usr/bin/env node
// What the two backends (src/swift/, src/kotlin/) still define twice, counted and held to the limits in twins.json:
// - sameName: names of functions and methods (none nested in another function) both backends define;
// - identicalBodies: of those, names one definition of which has the same body text in both;
// - decisionTwins: same-name pairs that only decide, on both sides: declared to return a boolean, a number, a Set or
//   Map, a TypeScript node, symbol or type, or a type predicate, with no template literal (no code spelled);
//   identicalDecisionTwins: those of them with the same body in both;
// - sharedLines: distinct lines of 40 characters or more (comments and imports aside) present, trimmed, in both.
// A count above its limit fails: a JavaScript-semantics decision is made once, in semantics/, and the backends spell
// it. A count below its limit fails as well until the limit is lowered to it (--write, which never raises one), so the
// change that removes a twin records it.
//   node tests/checks/twins.ts [--write] [--list]   (--list prints the identical and the decision twins)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const src = resolve(import.meta.dirname, '../../src');
const limitsFile = join(import.meta.dirname, 'twins.json');

interface Definition {
	at: string;
	body: string;
	decision: boolean;
}
interface Side {
	definitions: Map<string, Definition[]>;
	lines: Set<string>;
}

const DECISION_RESULT = /^(boolean|number|Set<|ReadonlySet<|Map<|ReadonlyMap<|ts\.|readonly ts\.|\w+ is\b)/;

function files(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...files(p));
		else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
	}
	return out;
}

function side(backend: string): Side {
	const definitions = new Map<string, Definition[]>();
	const lines = new Set<string>();
	for (const file of files(join(src, backend))) {
		const text = readFileSync(file, 'utf8');
		for (const line of text.split('\n')) {
			const t = line.trim();
			if (t.length >= 40 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('import ')) lines.add(t);
		}
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const visit = (n: ts.Node): void => {
			if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && n.body) {
				const body = n.body.getText(sf);
				const result = n.type?.getText(sf) ?? '';
				const at = `${relative(src, file).split(sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
				const name = n.name.getText(sf);
				const list = definitions.get(name) ?? [];
				list.push({ at, body, decision: DECISION_RESULT.test(result) && !body.includes('`') });
				definitions.set(name, list);
				return;
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return { definitions, lines };
}

const swift = side('swift');
const kotlin = side('kotlin');
const pairs = (name: string) => swift.definitions.get(name)!.flatMap((a) => kotlin.definitions.get(name)!.map((b) => [a, b] as const));
const sameName = [...swift.definitions.keys()].filter((k) => kotlin.definitions.has(k)).sort();
const identical = sameName.filter((k) => pairs(k).some(([a, b]) => a.body === b.body));
const decisions = sameName.filter((k) => pairs(k).some(([a, b]) => a.decision && b.decision));
const identicalDecisions = decisions.filter((k) => pairs(k).some(([a, b]) => a.decision && b.decision && a.body === b.body));
const counts: Record<string, number> = {
	sameName: sameName.length,
	identicalBodies: identical.length,
	decisionTwins: decisions.length,
	identicalDecisionTwins: identicalDecisions.length,
	sharedLines: [...swift.lines].filter((l) => kotlin.lines.has(l)).length,
};

if (process.argv.includes('--list')) {
	const where = (k: string) => `${swift.definitions.get(k)!.map((d) => d.at).join(' ')}  ${kotlin.definitions.get(k)!.map((d) => d.at).join(' ')}`;
	for (const k of identical) console.log(`identical ${k}  ${where(k)}`);
	for (const k of decisions) console.log(`decision${identicalDecisions.includes(k) ? ' identical' : ''} ${k}  ${where(k)}`);
}

const limits: Record<string, number> = JSON.parse(readFileSync(limitsFile, 'utf8'));
const failures: string[] = [];
for (const [key, count] of Object.entries(counts)) {
	const limit = limits[key];
	if (limit === undefined) failures.push(`${key}: ${count}, with no limit in twins.json`);
	else if (count > limit) failures.push(`${key}: ${count}, above its limit ${limit}: hoist the decision into semantics/ instead of writing it in each backend`);
	else if (count < limit) failures.push(`${key}: ${count}, below its limit ${limit}: lower it (node tests/checks/twins.ts --write)`);
}
for (const key of Object.keys(limits)) if (!(key in counts)) failures.push(`twins.json: ${key} is no count`);

if (process.argv.includes('--write')) {
	const raised = Object.keys(counts).filter((k) => limits[k] !== undefined && counts[k] > limits[k]);
	if (raised.length) {
		console.log(`✗ --write never raises a limit: ${raised.join(', ')}`);
		process.exit(1);
	}
	writeFileSync(limitsFile, JSON.stringify(counts, null, '\t') + '\n');
	console.log(`twins.json: ${JSON.stringify(counts)}`);
	process.exit(0);
}
for (const f of failures) console.log(`✗ ${f}`);
console.log(`twins: ${Object.entries(counts)
	.map(([k, v]) => `${k} ${v}`)
	.join(', ')}`);
process.exit(failures.length ? 1 : 0);
