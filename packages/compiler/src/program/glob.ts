// Static Vite `import.meta.glob(...)` / `import.meta.globEager(...)` expansion for ahead-of-time compilation.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Converts a Vite glob pattern (supporting `**`, `*`, `?`, `{a,b}`) to a RegExp matching POSIX relative paths. */
function globToRegExp(pattern: string): RegExp {
	let re = '^';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				if (pattern[i + 2] === '/') {
					re += '(?:.*/)?';
					i += 2;
				} else {
					re += '.*';
					i++;
				}
			} else {
				re += '[^/]*';
			}
		} else if (ch === '?') {
			re += '[^/]';
		} else if (ch === '{') {
			const end = pattern.indexOf('}', i + 1);
			if (end > i) {
				const alts = pattern.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$|()[\]\\]/g, '\\$&'));
				re += `(?:${alts.join('|')})`;
				i = end;
			} else {
				re += '\\{';
			}
		} else if (/[.+^$|()[\]\\]/.test(ch)) {
			re += `\\${ch}`;
		} else {
			re += ch;
		}
	}
	return new RegExp(re + '$');
}

/** Recursively walks files under `dir` (skipping `node_modules` and `.git`), returning POSIX relative paths. */
function walkFiles(dir: string, prefix = ''): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === 'node_modules' || entry.name === '.git') continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out;
}

interface GlobSpec {
	call: ts.CallExpression;
	patterns: string[];
	eager: boolean;
	importName: string | null;
	query: string;
	typeArg: string | null;
}

/** Finds nearest directory containing package.json above `from`, falling back to `dirname(from)`. */
function projectRootOf(from: string): string {
	for (let dir = dirname(from); ; dir = dirname(dir)) {
		if (existsSync(join(dir, 'package.json'))) return dir;
		if (dirname(dir) === dir) return dirname(from);
	}
}

/** Parses static `import.meta.glob(...)` / `import.meta.globEager(...)` calls in `sf`. */
function findGlobCalls(sf: ts.SourceFile): GlobSpec[] {
	const specs: GlobSpec[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const target = node.expression.expression;
			if ((method === 'glob' || method === 'globEager') && ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword && target.name.text === 'meta') {
				const parsed = parseGlobCall(node, method === 'globEager');
				if (parsed) specs.push(parsed);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return specs;
}

function parseGlobCall(call: ts.CallExpression, defaultEager: boolean): GlobSpec | null {
	const first = call.arguments[0];
	if (!first) return null;
	const patterns: string[] = [];
	if (ts.isStringLiteralLike(first)) {
		patterns.push(first.text);
	} else if (ts.isArrayLiteralExpression(first)) {
		for (const el of first.elements) {
			if (!ts.isStringLiteralLike(el)) return null;
			patterns.push(el.text);
		}
	} else {
		return null;
	}
	let eager = defaultEager;
	let importName: string | null = null;
	let query = '';
	const opts = call.arguments[1];
	if (opts && ts.isObjectLiteralExpression(opts)) {
		for (const p of opts.properties) {
			if (!ts.isPropertyAssignment(p)) continue;
			const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
			const v = p.initializer;
			if (key === 'eager') eager = v.kind === ts.SyntaxKind.TrueKeyword;
			else if (key === 'import' && ts.isStringLiteralLike(v)) importName = v.text;
			else if (key === 'query') {
				if (ts.isStringLiteralLike(v)) query = v.text.startsWith('?') ? v.text : `?${v.text}`;
				else if (ts.isObjectLiteralExpression(v)) {
					const qs = v.properties
						.filter(ts.isPropertyAssignment)
						.map((q) => {
							const qk = ts.isIdentifier(q.name) || ts.isStringLiteralLike(q.name) ? q.name.text : '';
							const qv = ts.isStringLiteralLike(q.initializer) ? q.initializer.text : q.initializer.getText();
							return qv === 'true' || qv === '' ? qk : `${qk}=${qv}`;
						})
						.filter(Boolean)
						.join('&');
					if (qs) query = `?${qs}`;
				}
			} else if (key === 'as' && ts.isStringLiteralLike(v)) {
				if (v.text === 'raw') {
					query = '?raw';
					importName ??= 'default';
				} else if (v.text === 'url') {
					query = '?url';
					importName ??= 'default';
				}
			}
		}
	}
	const typeArg = call.typeArguments?.[0]?.getText() ?? null;
	return { call, patterns, eager, importName, query, typeArg };
}

/** Resolves a list of Vite glob patterns (supporting `!` exclusions and `/` root-relative patterns) to sorted matches. */
function resolvePatterns(patterns: string[], filePath: string, appRoot: string | null): { key: string; abs: string; specifier: string }[] {
	const fileDir = dirname(filePath);
	const rootDir = appRoot ?? projectRootOf(filePath);
	const matched = new Map<string, { key: string; abs: string }>();

	const expandOne = (raw: string): { key: string; abs: string }[] => {
		const isRoot = raw.startsWith('/');
		let cwd = isRoot ? rootDir : fileDir;
		let normalized = isRoot ? raw.slice(1) : raw.replace(/^\.\//, '');
		let keyPrefix = isRoot ? '/' : './';
		while (normalized.startsWith('../')) {
			cwd = dirname(cwd);
			normalized = normalized.slice(3);
			keyPrefix = isRoot ? `${keyPrefix}../` : keyPrefix === './' ? '../' : `${keyPrefix}../`;
		}
		// Narrow walk root to any static directory prefix before the first glob metacharacter.
		const parts = normalized.split('/');
		const staticParts: string[] = [];
		while (parts.length > 1 && !/[*?{[\]]/.test(parts[0])) staticParts.push(parts.shift()!);
		let walkDir = staticParts.length ? resolve(cwd, ...staticParts) : cwd;
		if (isRoot && !existsSync(walkDir)) {
			const fallbackRoot = projectRootOf(filePath);
			const alt = staticParts.length ? resolve(fallbackRoot, ...staticParts) : fallbackRoot;
			if (existsSync(alt)) walkDir = alt;
		}
		const matcher = globToRegExp(parts.join('/'));
		const out: { key: string; abs: string }[] = [];
		for (const rel of walkFiles(walkDir)) {
			if (!matcher.test(rel)) continue;
			const abs = resolve(walkDir, rel);
			if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
			const fullRel = staticParts.length ? `${staticParts.join('/')}/${rel}` : rel;
			out.push({ key: `${keyPrefix}${fullRel}`, abs });
		}
		return out;
	};

	for (const p of patterns) {
		if (p.startsWith('!')) {
			for (const ex of expandOne(p.slice(1))) matched.delete(ex.abs);
		} else {
			for (const inc of expandOne(p)) if (!matched.has(inc.abs)) matched.set(inc.abs, inc);
		}
	}

	return [...matched.values()]
		.sort((a, b) => a.key.localeCompare(b.key))
		.map(({ key, abs }) => {
			let spec = relative(fileDir, abs).split('\\').join('/');
			if (!spec.startsWith('.') && !isAbsolute(spec)) spec = `./${spec}`;
			return { key, abs, specifier: spec };
		});
}

/**
 * Expands static Vite `import.meta.glob(...)` / `import.meta.globEager(...)` calls in `code` into hoisted static
 * ES imports plus a plain object literal mapping matched keys to modules (eager) or `() => Promise.resolve(mod)` (lazy).
 */
export function expandImportMetaGlob(code: string, filePath: string, appRoot: string | null = null): string {
	if (!code.includes('import.meta.glob')) return code;
	const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
	const specs = findGlobCalls(sf);
	if (!specs.length) return code;

	const imports: string[] = [];
	const edits: { start: number; end: number; text: string }[] = [];
	let counter = 0;

	for (const spec of specs) {
		const matches = resolvePatterns(spec.patterns, filePath, appRoot);
		const entries: string[] = [];
		for (const m of matches) {
			const id = `__nsGlob_${counter++}`;
			const importSpec = m.specifier + spec.query;
			let val: string;
			if (spec.importName === 'default' || (spec.query === '?raw' && !spec.importName)) {
				imports.push(`import ${id} from ${JSON.stringify(importSpec)};`);
				val = id;
			} else if (spec.importName && spec.importName !== '*') {
				imports.push(`import { ${spec.importName} as ${id} } from ${JSON.stringify(importSpec)};`);
				val = id;
			} else {
				imports.push(`import * as ${id} from ${JSON.stringify(importSpec)};`);
				val = `(${id} as any)`;
			}
			entries.push(`${JSON.stringify(m.key)}: ${spec.eager ? val : `() => Promise.resolve(${val})`}`);
		}
		const obj = `{ ${entries.join(', ')} }`;
		const valType = spec.typeArg ?? (spec.query === '?raw' && !spec.importName ? 'string' : 'any');
		const entryType = spec.eager ? valType : `() => Promise<${valType}>`;
		const wrapped = `((__m: Record<string, ${entryType}>): Record<string, ${entryType}> => __m)(${obj})`;
		edits.push({ start: spec.call.getStart(sf), end: spec.call.getEnd(), text: wrapped });
	}

	let out = code;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return imports.length ? `${out}\n${imports.join('\n')}\n` : out;
}

/** Returns absolute file paths matched by static `import.meta.glob(...)` calls in `code` (for app reachability). */
export function globMatchedFiles(code: string, filePath: string, appRoot: string | null = null): string[] {
	if (!code.includes('import.meta.glob')) return [];
	const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
	const out: string[] = [];
	for (const spec of findGlobCalls(sf)) {
		if (spec.query === '?raw' || spec.query === '?url') continue;
		for (const m of resolvePatterns(spec.patterns, filePath, appRoot)) out.push(m.abs);
	}
	return out;
}
