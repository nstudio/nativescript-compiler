import ts from 'typescript';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { globMatchedFiles } from './glob.ts';

/** How the app's TypeScript files import each other, as its bundler resolves the specifiers. */
export interface AppImports {
	/** Each file's imports of the app's files. */
	importsOf: Map<string, Set<string>>;
	/** The files importing each file (a worker's script is not imported by its starter). */
	usedBy: Map<string, Set<string>>;
	/** The scripts workers are started with (`new Worker(new URL('./worker', …))`). */
	workerScripts: Set<string>;
	/** Local workspace `.ts`/`.tsx` files outside `files` reached via relative, aliased, or glob imports. */
	discovered: string[];
}

/**
 * The imports among `files`: relative specifiers and those the app's tsconfig `paths` / Vite config alias (`aliased`),
 * each completed as the bundler does, the platform's own file (`thisPlatform`, `.ios.ts`) beside the shared one.
 * Local monorepo workspace TypeScript sources outside `files` (and outside `node_modules`) are discovered transitively.
 */
export function appImports(
	files: string[],
	aliased: (specifier: string, importer?: string) => string | undefined,
	thisPlatform: string,
	appRoot: string | null = null,
	readSource: (file: string) => string = (f) => readFileSync(f, 'utf8'),
): AppImports {
	const out: AppImports = { importsOf: new Map(), usedBy: new Map(), workerScripts: new Set(), discovered: [] };
	const known = new Set(files);
	const otherPlatform = thisPlatform === '.android.ts' ? /\.ios\.tsx?$/ : /\.android\.tsx?$/;
	const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
	const queue = files.filter((x) => /\.tsx?$/.test(x) && !x.endsWith('.d.ts'));
	const seen = new Set<string>();
	const link = (from: string, to: string, worker: boolean) => {
		if (worker) out.workerScripts.add(to);
		else out.usedBy.set(to, (out.usedBy.get(to) ?? new Set()).add(from));
		out.importsOf.set(from, (out.importsOf.get(from) ?? new Set()).add(to));
	};
	const discover = (c: string) => {
		if (known.has(c) || c.endsWith('.d.ts') || otherPlatform.test(c) || /[\\/]node_modules[\\/]/.test(c)) return false;
		if (!/\.tsx?$/.test(c) || !isFile(c)) return false;
		known.add(c);
		out.discovered.push(c);
		queue.push(c);
		return true;
	};
	for (let i = 0; i < queue.length; i++) {
		const f = queue[i];
		if (seen.has(f)) continue;
		seen.add(f);
		const text = readSource(f);
		const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, false);
		const specs: { spec: string; worker: boolean }[] = [];
		const visitSpec = (n: ts.Node) => {
			if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
				const clause = n.importClause;
				const allTypeOnly =
					!!clause?.isTypeOnly ||
					(!!clause && !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly));
				if (!allTypeOnly) specs.push({ spec: n.moduleSpecifier.text, worker: false });
				return;
			}
			if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
				const allTypeOnly =
					n.isTypeOnly ||
					(!!n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.length > 0 && n.exportClause.elements.every((e) => e.isTypeOnly));
				if (!allTypeOnly) specs.push({ spec: n.moduleSpecifier.text, worker: false });
				return;
			}
			if (ts.isCallExpression(n)) {
				if ((n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
					specs.push({ spec: n.arguments[0].text, worker: false });
				}
			} else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Worker' && n.arguments?.[0]) {
				const arg0 = n.arguments[0];
				const lit = ts.isStringLiteralLike(arg0) ? arg0 : ts.isNewExpression(arg0) && ts.isIdentifier(arg0.expression) && arg0.expression.text === 'URL' && arg0.arguments?.[0] && ts.isStringLiteralLike(arg0.arguments[0]) ? arg0.arguments[0] : undefined;
				if (lit) specs.push({ spec: lit.text, worker: true });
			}
			ts.forEachChild(n, visitSpec);
		};
		visitSpec(sf);
		for (const { spec, worker } of specs) {
			if (spec.includes('?')) continue;
			const target = spec.startsWith('.') ? resolve(dirname(f), spec) : aliased(spec, f);
			if (!target || /[\\/]node_modules[\\/]/.test(target)) continue;
			const base = target.replace(/\.(tsx?|m?js)$/, '');
			let matched = false;
			for (const c of [base + '.ts', base + thisPlatform, base + '.tsx', base + '/index.ts', `${base}/index${thisPlatform}`]) {
				if (!known.has(c)) continue;
				link(f, c, worker);
				matched = true;
			}
			if (matched) continue;
			// External monorepo workspace source (not under appDir): pick the platform file when present, else the shared source.
			const external = /\.tsx?$/.test(target)
				? [target.replace(/\.ts$/, thisPlatform), target]
				: [base + thisPlatform, base + '.ts', base + '.tsx', `${base}/index${thisPlatform}`, base + '/index.ts', base + '/index.tsx'];
			for (const c of external) {
				if (discover(c)) {
					link(f, c, worker);
					break;
				}
			}
		}
		for (const c of globMatchedFiles(text, f, appRoot)) {
			if (known.has(c) || discover(c)) link(f, c, false);
		}
	}
	return out;
}

/** `roots` and every file they import, transitively. */
export function reachedFrom(roots: Iterable<string>, importsOf: Map<string, Set<string>>): Set<string> {
	const reached = new Set<string>();
	const pending = [...roots];
	while (pending.length) {
		const f = pending.pop()!;
		if (reached.has(f)) continue;
		reached.add(f);
		pending.push(...(importsOf.get(f) ?? []));
	}
	return reached;
}

/** The TypeScript files under `dir` the app's tsconfig.json does not exclude; null where the app has none. */
export function tsconfigIncluded(app: string, dir: string): Set<string> | null {
	const file = join(app, 'tsconfig.json');
	if (!existsSync(file)) return null;
	const config = ts.readConfigFile(file, ts.sys.readFile).config ?? {};
	const parsed = ts.parseJsonConfigFileContent({ ...config, files: undefined, include: [join(relative(app, dir) || '.', '**/*')] }, ts.sys, app, undefined, file);
	return new Set(parsed.fileNames.map((f) => resolve(f)));
}
