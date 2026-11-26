// Core's source as both kit generators read it: with the bundler's defines a release build gives it, and with what a
// translation fails at dropped so the next run reports what follows.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { Refusal } from '../semantics/refusals.ts';

/**
 * Drops, in memory, the innermost member, decorator, heritage clause or
 * top-level statement at an error's position, so translating the file again
 * reports what follows it. Whether anything was dropped.
 */
export function dropAt(e: unknown, sf: ts.SourceFile): boolean {
	if (!(e instanceof Refusal) || !e.at || e.at.file !== sf.fileName) return false;
	const pos = sf.getPositionOfLineAndCharacter(e.at.line - 1, e.at.column - 1);
	let best: ts.Node | null = null;
	const visit = (n: ts.Node) => {
		if (pos < n.getStart(sf) || pos >= n.getEnd()) return;
		if (ts.isDecorator(n) || ts.isHeritageClause(n) || (ts.isClassLike(n.parent) && ts.isClassElement(n)) || ((n.parent === sf || ts.isModuleBlock(n.parent)) && ts.isStatement(n))) best = n;
		ts.forEachChild(n, visit);
	};
	ts.forEachChild(sf, visit);
	const n = best as ts.Node | null;
	if (!n) return false;
	const p = n.parent as unknown as Record<string, ts.NodeArray<ts.Node> | undefined>;
	for (const key of ['members', 'statements', 'modifiers', 'heritageClauses']) {
		const list = p[key];
		if (!list || !list.includes(n)) continue;
		const kept = Object.assign(
			list.filter((x) => x !== n),
			{ pos: list.pos, end: list.end, hasTrailingComma: list.hasTrailingComma },
		);
		Object.defineProperty(p, key, { value: kept, writable: true, configurable: true, enumerable: true });
		return true;
	}
	return false;
}

/**
 * What the bundler defines for core, as a release build's: no external
 * renderer, and CSS given as text at run time parsed by core's own parser
 * (css-tree is not compiled).
 */
const CORE_DEFINES: Record<string, string> = { __UI_USE_EXTERNAL_RENDERER__: 'false', __UI_USE_XML_PARSER__: 'true', __CSS_PARSER__: "'nativescript'" };

/**
 * A translation error as a kit generator reports it: one line per construct left out (tools/kit/omissions.json and the
 * Android summary's causes key on it), at the file where the error names no place, core's directory dropped.
 */
export function located(e: unknown, sf: ts.SourceFile, core: string): string {
	const message = e instanceof Error ? e.message : String(e);
	return (e instanceof Refusal && e.at ? message : `${sf.fileName}:0: ${message.split('\n')[0]}`).replaceAll(core + '/', '');
}

export function withCoreDefines(text: string): string {
	for (const [key, value] of Object.entries(CORE_DEFINES)) text = text.replace(new RegExp(`(?<![\\w$.])${key}(?![\\w$])`, 'g'), (m) => `(${value})`.padEnd(m.length, ' '));
	return text;
}

/**
 * Resolves an npm dependency of `@nativescript/core` during kit generation, checking `core` and `declarations`
 * ancestors' `node_modules`. When `requiredFile` is given (e.g. `src/index.ts` for `css-what@7`), prefers a copy
 * containing it — including nested `node_modules/<dep>/node_modules/<pkg>` when a monorepo hoisted an older major.
 */
export function kitPackageDir(pkg: string, core: string, declarations: string, requiredFile?: string): string {
	const roots: string[] = [];
	const seen = new Set<string>();
	for (const start of [resolve(core), resolve(declarations)]) {
		for (let dir = start; ; dir = dirname(dir)) {
			const nm = join(dir, 'node_modules');
			if (!seen.has(nm)) {
				seen.add(nm);
				if (existsSync(nm)) roots.push(nm);
			}
			if (dirname(dir) === dir) break;
		}
	}
	let firstFound: string | null = null;
	for (const nm of roots) {
		const candidate = join(nm, pkg);
		if (!existsSync(candidate)) continue;
		if (!requiredFile || existsSync(join(candidate, requiredFile))) return candidate;
		if (!firstFound) firstFound = candidate;
	}
	if (requiredFile) {
		for (const nm of roots) {
			let entries: string[];
			try {
				entries = readdirSync(nm).sort();
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.startsWith('.')) continue;
				const nested = join(nm, entry, 'node_modules', pkg);
				if (existsSync(join(nested, requiredFile))) return nested;
			}
		}
	}
	return firstFound ?? join(resolve(declarations, '../..'), pkg);
}
