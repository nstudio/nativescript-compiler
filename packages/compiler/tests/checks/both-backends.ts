#!/usr/bin/env node
// Every diff case runs on both backends unless its `// @swift` or `// @kotlin` line names why (case-options.ts `onlyOn`),
// a mode line keeping it on one (`// @lenient`, `// @plugin`, `// @lenient-kotlin`) included:
// - `ledger:<entry>`: a field of src/semantics/ledger.ts whose Swift and Kotlin values differ;
// - `refused:<id>`: a refusal of src/semantics/refusals.ts, which translating the case for the other backend must give.
// A refusal one backend's source gives (`this.error(…, id)`, `this.limit(n, id, …)`) and the other's never does is one
// `ONE_BACKEND_REFUSALS` lists, with a ledger entry the backends differ in.
// Each method table of src/semantics/apis/ is spelled whole by both backends: a `switch (<lookup>(name)?.op)` there has
// a case for every entry. So are the global functions (a case of the `switch (op)` over `globalFunction(name)`, or, for
// an entry `declaredBy` the backend's SDK, a call of the function its kit declares under the library's name) and each
// owner's static functions (`staticCall` names the member in the owner's case, or hands the whole table on); an entry
// with `args` is a runtime call the front spells for both.
// It prints the ledger's entries by kind (LEDGER_KINDS) with the cases naming each.
//   node tests/checks/both-backends.ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { diffCases } from '../suite.ts';
import { kotlinApp, kotlinOnly, kotlinOptions, lenient, lenientBoth, onlyOn, pluginBoth, pluginCase, refusalId, swiftOptions } from '../diff/case-options.ts';
import { translateKotlin, translateSwift } from '../native-build.ts';
import { KOTLIN_LEDGER, LEDGER_KINDS, ONE_BACKEND_REFUSALS, SWIFT_LEDGER, type Ledger } from '../../src/semantics/ledger.ts';
import { REFUSALS } from '../../src/semantics/refusals.ts';
import { ARRAY_METHODS } from '../../src/semantics/apis/array.ts';
import { COLLECTION_METHODS } from '../../src/semantics/apis/mapset.ts';
import { NUMBER_METHODS } from '../../src/semantics/apis/number.ts';
import { PROMISE_METHODS } from '../../src/semantics/apis/promise.ts';
import { REGEXP_STRING_METHODS } from '../../src/semantics/apis/regexp.ts';
import { STRING_METHODS } from '../../src/semantics/apis/string.ts';
import { GLOBALS, type GlobalOp } from '../../src/semantics/apis/globals.ts';
import { STATICS } from '../../src/semantics/apis/statics.ts';
import { BUFFER_TYPES } from '../../src/semantics/globals.ts';

const failures: string[] = [];
const naming = new Map<string, string[]>();
const out = mkdtempSync(join(tmpdir(), 'ns-both-backends-'));
let refused = 0;
for (const name of readdirSync(diffCases)
	.filter((f) => f.endsWith('.ts'))
	.sort()) {
	const file = join(diffCases, name);
	const only = onlyOn(file);
	// A mode line that keeps the case off one backend (`// @lenient`, `// @plugin`: Swift; `// @lenient-kotlin`: Kotlin).
	const modeOnly = kotlinOnly(file) ? 'kotlin' : (lenient(file) && !lenientBoth(file)) || (pluginCase(file) && !pluginBoth(file)) ? 'swift' : null;
	if (modeOnly && only?.backend !== modeOnly) failures.push(`${name}: its mode line runs it on ${modeOnly} only: a \`// @${modeOnly}\` line names why (\`ledger:<entry>\` or \`refused:<id>\`), or the mode line takes its \`-both\` form`);
	if (!only) continue;
	const other = only.backend === 'swift' ? 'kotlin' : 'swift';
	if (only.backend === 'kotlin' && !kotlinApp(file) && modeOnly !== 'kotlin') failures.push(`${name}: \`// @kotlin\` is the case's first line`);
	const [kind, value] = only.reason.split(':');
	if (kind === 'ledger' && value && !/\s/.test(value)) {
		const entry = value as keyof Ledger;
		if (!Object.hasOwn(SWIFT_LEDGER, entry)) failures.push(`${name}: ledger:${value} is no entry of src/semantics/ledger.ts`);
		else if (SWIFT_LEDGER[entry] === KOTLIN_LEDGER[entry]) failures.push(`${name}: ledger:${value} is the same on both backends, so it keeps no case off one`);
		else naming.set(entry, [...(naming.get(entry) ?? []), name.replace(/\.ts$/, '')]);
	} else if (kind === 'refused' && value && !/\s/.test(value)) {
		if (!Object.hasOwn(REFUSALS, value)) {
			failures.push(`${name}: refused:${value} is no refusal id of src/semantics/refusals.ts`);
			continue;
		}
		refused++;
		const dir = join(out, other, name);
		let given: string | undefined;
		try {
			if (other === 'swift') translateSwift([file], dir, swiftOptions(file));
			else translateKotlin([file], dir, 'case_both', kotlinOptions(file));
		} catch (err) {
			given = refusalId(err as Error) ?? `no refusal (${(err as Error).message.split('\n')[0]})`;
		}
		if (given !== value) failures.push(`${name}: refused:${value}, but ${other} ${given ? `gives ${given}` : 'translates it'}`);
	} else failures.push(`${name}: \`// @${only.backend}\` names why the case does not run on ${other}: \`ledger:<entry>\` or \`refused:<id>\``);
}
rmSync(out, { recursive: true, force: true });

/** The refusal ids `dir`'s source gives: a refusal id passed to an `error` or `limit` call, or chosen there (`c ? 'a' : 'b'`). */
function refusalsGiven(dir: string): Set<string> {
	const ids = new Set<string>();
	const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
	for (const f of walk(dir)) {
		const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n)) {
				const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : '';
				if (callee === 'error' || callee === 'limit') for (const a of n.arguments) for (const x of ts.isConditionalExpression(a) ? [a.whenTrue, a.whenFalse] : [a]) if (ts.isStringLiteral(x) && Object.hasOwn(REFUSALS, x.text)) ids.add(x.text);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return ids;
}
const src = resolve(import.meta.dirname, '../../src');
const given = { swift: refusalsGiven(join(src, 'swift')), kotlin: refusalsGiven(join(src, 'kotlin')) };
for (const id of new Set([...given.swift, ...given.kotlin])) {
	if (given.swift.has(id) === given.kotlin.has(id)) continue;
	const entry = ONE_BACKEND_REFUSALS[id as keyof typeof REFUSALS];
	if (!entry) failures.push(`refusal ${id}: only ${given.swift.has(id) ? 'Swift' : 'Kotlin'} gives it; refuse it on both, or name its ledger entry in ONE_BACKEND_REFUSALS`);
	else if (SWIFT_LEDGER[entry] === KOTLIN_LEDGER[entry]) failures.push(`refusal ${id}: ledger:${entry} is the same on both backends`);
}
const METHOD_TABLES: Record<string, Readonly<Record<string, unknown>>> = { arrayMember: ARRAY_METHODS, stringMember: STRING_METHODS, regexpStringMember: REGEXP_STRING_METHODS, numberMember: NUMBER_METHODS, promiseMember: PROMISE_METHODS, collectionMember: COLLECTION_METHODS };
for (const backend of ['swift', 'kotlin']) {
	const spelled = new Map<string, Set<string>>();
	const sf = ts.createSourceFile('builtins.ts', readFileSync(join(src, backend, 'builtins.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
	const visit = (n: ts.Node): void => {
		const lookup = ts.isSwitchStatement(n) ? /^(\w+)\(name\)\?\.op$/.exec(n.expression.getText(sf))?.[1] : undefined;
		if (lookup && ts.isSwitchStatement(n)) for (const c of n.caseBlock.clauses) if (ts.isCaseClause(c) && ts.isStringLiteral(c.expression)) spelled.set(lookup, (spelled.get(lookup) ?? new Set()).add(c.expression.text));
		ts.forEachChild(n, visit);
	};
	visit(sf);
	for (const [lookup, table] of Object.entries(METHOD_TABLES)) {
		const missing = Object.keys(table).filter((op) => !spelled.get(lookup)?.has(op));
		if (missing.length) failures.push(`${backend}/builtins.ts: no case of switch (${lookup}(name)?.op) for ${missing.join(', ')}`);
	}
}
for (const backend of ['swift', 'kotlin'] as const) {
	let sf!: ts.SourceFile;
	const globals = new Set<string>();
	/** By owner (`*`: before the owner's cases, for an owner without one), the members `staticCall` names; null: the owner's whole table. */
	const statics = new Map<string, Set<string> | null>();
	const literals = (n: ts.Node, into: Set<string>): void => {
		if (ts.isBinaryExpression(n) && [n.left, n.right].some((x) => x.getText(sf) === 'method')) for (const x of [n.left, n.right]) if (ts.isStringLiteral(x)) into.add(x.text);
		if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'includes' && n.arguments[0]?.getText(sf) === 'method' && ts.isArrayLiteralExpression(n.expression.expression))
			for (const x of n.expression.expression.elements) if (ts.isStringLiteral(x)) into.add(x.text);
		if (ts.isSwitchStatement(n) && n.expression.getText(sf) === 'method') for (const c of n.caseBlock.clauses) if (ts.isCaseClause(c) && ts.isStringLiteral(c.expression)) into.add(c.expression.text);
		ts.forEachChild(n, (x) => literals(x, into));
	};
	const handsOn = (n: ts.Node): boolean => ((ts.isCallExpression(n) && n.arguments.some((a) => a.getText(sf) === 'method')) || (ts.isElementAccessExpression(n) && n.argumentExpression.getText(sf) === 'method') ? true : !!ts.forEachChild(n, handsOn));
	// A branch for the buffer types' statics ahead of `staticCall` (`BUFFER_TYPES.has(target.text) && [...].includes(method)`).
	const buffers = new Set<string>();
	const visit = (n: ts.Node): void => {
		if (ts.isIfStatement(n) && /\bBUFFER_TYPES\.has\(/.test(n.expression.getText(sf))) literals(n.expression, buffers);
		if (ts.isBlock(n) && n.statements.some((st) => ts.isVariableStatement(st) && /\bglobalFunction\(name\)/.test(st.getText(sf))))
			for (const st of n.statements) if (ts.isSwitchStatement(st) && st.expression.getText(sf) === 'op') for (const c of st.caseBlock.clauses) if (ts.isCaseClause(c) && ts.isStringLiteral(c.expression)) globals.add(c.expression.text);
		if ((ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n)) && n.name.getText(sf) === 'staticCall') {
			const before = new Set<string>();
			const body = ts.isMethodDeclaration(n) ? n.body! : n.initializer;
			const ownerSwitch = (x: ts.Node): ts.SwitchStatement | undefined => (ts.isSwitchStatement(x) && x.expression.getText(sf) === 'owner' ? x : ts.forEachChild(x, ownerSwitch));
			const sw = ownerSwitch(body);
			for (const st of ts.isBlock(body) ? body.statements : []) if (st !== sw && st.end <= (sw?.pos ?? Infinity)) literals(st, before);
			statics.set('*', before);
			let pending: string[] = [];
			for (const c of sw?.caseBlock.clauses ?? []) {
				if (!ts.isCaseClause(c) || !ts.isStringLiteral(c.expression)) continue;
				pending.push(c.expression.text);
				if (!c.statements.length) continue;
				const named = new Set<string>();
				for (const st of c.statements) literals(st, named);
				for (const owner of pending) statics.set(owner, c.statements.some(handsOn) && !named.size ? null : named);
				pending = [];
			}
			return;
		}
		ts.forEachChild(n, visit);
	};
	for (const file of ['calls.ts', 'global-calls.ts', 'static-calls.ts']) {
		sf = ts.createSourceFile(file, readFileSync(join(src, backend, file), 'utf8'), ts.ScriptTarget.Latest, true);
		visit(sf);
	}
	const sdk = (backend === 'swift' ? SWIFT_LEDGER : KOTLIN_LEDGER).nativeSdk;
	// A global function the backend's kit declares under its own name is called as the declared function (`declaredBy`).
	const byName = new Set<string>((Object.keys(GLOBALS) as GlobalOp[]).filter((op) => GLOBALS[op].declaredBy === sdk));
	const missing = (Object.keys(GLOBALS) as GlobalOp[]).filter((op) => !globals.has(op) && !GLOBALS[op].args && !byName.has(op));
	if (missing.length) failures.push(`${backend}/global-calls.ts: no case of the global functions' switch (op) for ${missing.join(', ')}`);
	for (const op of byName) if (globals.has(op) || GLOBALS[op as GlobalOp].args) failures.push(`apis/globals.ts: ${op} is declaredBy ${sdk}, but ${backend}/global-calls.ts spells it`);
	const ledger = backend === 'swift' ? SWIFT_LEDGER : KOTLIN_LEDGER;
	for (const [owner, table] of Object.entries(STATICS)) {
		const named = statics.has(owner) ? statics.get(owner) : statics.get('*');
		if (named === null) continue;
		const lacking = Object.keys(table).filter((m) => !table[m].args && !named?.has(m) && !(BUFFER_TYPES.has(owner) && buffers.has(m)) && !(table[m].sdk && table[m].sdk !== ledger.nativeSdk));
		if (lacking.length) failures.push(`${backend}/static-calls.ts: staticCall names no ${lacking.map((m) => `${owner}.${m}`).join(', ')}`);
	}
}
for (const id of Object.keys(ONE_BACKEND_REFUSALS)) if (given.swift.has(id) === given.kotlin.has(id)) failures.push(`ONE_BACKEND_REFUSALS: ${id} is given by ${given.swift.has(id) ? 'both backends' : 'neither backend'}`);

for (const kind of ['platform', 'gap'] as const) {
	const entries = (Object.keys(LEDGER_KINDS) as (keyof Ledger)[]).filter((k) => LEDGER_KINDS[k] === kind);
	console.log(`${kind}: ${entries.map((k) => `${k}${naming.has(k) ? ` (${naming.get(k)!.join(', ')})` : ''}`).join('; ')}`);
}
for (const f of failures) console.log(`✗ ${f}`);
console.log(`both backends: ${[...naming.values()].reduce((n, v) => n + v.length, 0)} cases name a ledger entry, ${refused} a refusal; ${Object.keys(ONE_BACKEND_REFUSALS).length} refusals one backend gives; ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
