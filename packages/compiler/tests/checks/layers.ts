#!/usr/bin/env node
// The layering of src/, from its import graph:
// - semantics/ (the shared front) imports no backend (swift/, kotlin/), driver/ or targets/;
// - swift/ and kotlin/ never import each other, and neither reaches the other through other modules' value imports;
// - api/ (the package's public entries) imports nothing outside api/, types included;
// - no cycle of value imports anywhere: a module's top level runs only after the modules it imports;
// - semantics/ names a backend ('swift', 'kotlin') only in a type, and branches on one only through a field of
//   semantics/ledger.ts, whose entries each name the difference they keep;
// - semantics/, swift/ and kotlin/ keep no state of their own at module level: no top-level `let` or `var`, and no
//   top-level Map, Set, array or object the module changes, but caches keyed weakly by the program's objects
//   (`WeakMap`/`WeakSet`) and the entries of MODULE_STATE, each saying why it is not a translation's state. A translation's
//   state is its translator's.
// An `import type` loads nothing at run time. `import { type A }` still loads its module (the import is kept, empty), so it
// counts as a value import, as `import()` and `export … from` do.
//   node tests/checks/layers.ts [--graph]   (--graph prints each module's value imports)
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const src = resolve(import.meta.dirname, '../../src');
const files: string[] = [];
const walk = (dir: string): void => {
	for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p);
	}
};
walk(src);
const name = (file: string) => relative(src, file).split(sep).join('/').replace(/\.ts$/, '');
const namesBackends = (file: string) => name(file).startsWith('semantics/') && name(file) !== 'semantics/ledger';

interface Edge {
	to: string;
	typeOnly: boolean;
	line: number;
}
const graph = new Map<string, Edge[]>();
const failures: string[] = [];
for (const file of files) {
	const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const edges: Edge[] = [];
	const add = (spec: ts.Expression | undefined, typeOnly: boolean, at: ts.Node) => {
		if (!spec || !ts.isStringLiteralLike(spec) || !spec.text.startsWith('.')) return;
		const to = resolve(dirname(file), spec.text);
		if (!to.startsWith(src + sep) || !to.endsWith('.ts')) return;
		edges.push({ to: name(to), typeOnly, line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1 });
	};
	const visit = (n: ts.Node): void => {
		if (ts.isImportDeclaration(n)) add(n.moduleSpecifier, !!n.importClause?.isTypeOnly, n);
		else if (ts.isExportDeclaration(n)) add(n.moduleSpecifier, n.isTypeOnly, n);
		else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) add(n.arguments[0], false, n);
		else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal, true, n);
		else if (namesBackends(file) && ts.isStringLiteralLike(n) && (n.text === 'swift' || n.text === 'kotlin') && !ts.isLiteralTypeNode(n.parent)) failures.push(`${name(file)}.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} tests the backend's name '${n.text}': the front branches on a backend only through a semantics/ledger.ts entry`);
		ts.forEachChild(n, visit);
	};
	visit(sf);
	graph.set(name(file), edges);
}

/** Module-level state allowed in semantics/, swift/ and kotlin/, by `<module>:<name>`. */
const MODULE_STATE: Readonly<Record<string, string>> = {
	'semantics/decision-trace:sink': "NS_DECISION_TRACE's record of the front's answers, which tests read; no translation reads it",
	'semantics/decision-trace:frames': "NS_DECISION_TRACE's questions being answered while a trace records",
	'semantics/decision-trace:taints': "NS_DECISION_TRACE's record of which answers read a backend's input; no translation reads it",
	'semantics/losses:site': "NS_HELD_LOSS's node being translated, which a reported loss is placed at; no translation reads it",
	'semantics/losses:seen': "NS_HELD_LOSS's losses already recorded, so each is recorded once",
	'semantics/losses:taken': "NS_HELD_LOSS's record of the losses backends reported, which tests/checks/held-loss.ts reads; no translation reads it",
	'semantics/types:SPELLED': "spelledType's answers by text, each a function of the text alone",
	'swift/native/sdk-tables:sdkInfo': "the iOS SDK's path and version, read once from xcrun",
};
const MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const seenState = new Set<string>();
for (const file of files) {
	const m = name(file);
	if (!/^(semantics|swift|kotlin)\//.test(m)) continue;
	const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
	const held = new Map<string, ts.Node>();
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		const constant = !!(st.declarationList.flags & ts.NodeFlags.Const);
		for (const d of st.declarationList.declarations) {
			if (!ts.isIdentifier(d.name)) continue;
			const init = d.initializer && ts.skipOuterExpressions(d.initializer);
			const weak = !!init && ts.isNewExpression(init) && /^Weak(Map|Set)$/.test(init.expression.getText(sf));
			if (!constant) held.set(d.name.text, d);
			else if (init && !weak && ((ts.isNewExpression(init) && /^(Map|Set|Array)$/.test(init.expression.getText(sf))) || ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init))) {
				const mutated = (n: ts.Node): boolean => {
					const target = (x: ts.Expression): boolean => ts.isIdentifier(x) && x.text === d.name.getText(sf);
					if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && target(n.expression.expression) && MUTATORS.has(n.expression.name.text)) return true;
					if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) && target(n.left.expression)) return true;
					return !!ts.forEachChild(n, mutated);
				};
				if (mutated(sf)) held.set(d.name.text, d);
			}
		}
	}
	for (const [n, d] of held) {
		const key = `${m}:${n}`;
		if (Object.hasOwn(MODULE_STATE, key)) seenState.add(key);
		else failures.push(`${m}.ts:${line(d)} keeps \`${n}\` at module level: state of a translation belongs to its translator; a cache keyed by the program's objects is a WeakMap`);
	}
}
for (const key of Object.keys(MODULE_STATE)) if (!seenState.has(key)) failures.push(`MODULE_STATE: ${key} is no module-level state any more`);

const top = (m: string) => m.split('/')[0];
const BACKENDS = new Set(['swift', 'kotlin']);
for (const [from, edges] of graph) {
	for (const e of edges) {
		if (top(from) === 'semantics' && (BACKENDS.has(top(e.to)) || top(e.to) === 'driver' || top(e.to) === 'targets')) failures.push(`${from}.ts:${e.line} imports ${e.to}: the shared front imports no backend, driver or target`);
		if (BACKENDS.has(top(from)) && BACKENDS.has(top(e.to)) && top(from) !== top(e.to)) failures.push(`${from}.ts:${e.line} imports ${e.to}: one backend never imports the other`);
		if (top(from) === 'api' && top(e.to) !== 'api') failures.push(`${from}.ts:${e.line} imports ${e.to}: the public API imports only api/, whose declarations ship alone`);
	}
}

const values = new Map([...graph].map(([m, edges]) => [m, [...new Set(edges.filter((e) => !e.typeOnly).map((e) => e.to))]]));
// What each backend's modules load: the other backend's must not be among it.
for (const backend of BACKENDS) {
	const reached = new Set<string>();
	const stack = [...values.keys()].filter((m) => top(m) === backend);
	while (stack.length) {
		const m = stack.pop()!;
		if (reached.has(m)) continue;
		reached.add(m);
		stack.push(...(values.get(m) ?? []));
	}
	const other = [...reached].filter((m) => BACKENDS.has(top(m)) && top(m) !== backend);
	if (other.length) failures.push(`${backend}/ loads ${other.sort().join(', ')}`);
}

// Strongly connected components of the value imports (Tarjan).
const cycles: string[][] = [];
{
	let next = 0;
	const index = new Map<string, number>(),
		low = new Map<string, number>(),
		stack: string[] = [],
		on = new Set<string>();
	const connect = (v: string): void => {
		index.set(v, next);
		low.set(v, next++);
		stack.push(v);
		on.add(v);
		for (const w of values.get(v) ?? []) {
			if (!index.has(w)) {
				connect(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
		}
		if (low.get(v) === index.get(v)) {
			const c: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				on.delete(w);
				c.push(w);
			} while (w !== v);
			if (c.length > 1 || values.get(v)!.includes(v)) cycles.push(c.sort());
		}
	};
	for (const v of values.keys()) if (!index.has(v)) connect(v);
}
for (const c of cycles) failures.push(`value-import cycle of ${c.length}: ${c.join(' ')}`);

if (process.argv.includes('--graph')) for (const [m, v] of values) console.log(`${m}: ${v.join(' ')}`);
for (const f of failures) console.log(`✗ ${f}`);
console.log(`layers: ${graph.size} modules, ${[...values.values()].reduce((n, v) => n + v.length, 0)} value imports, ${cycles.length} cycles, ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
