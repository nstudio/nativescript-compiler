// Compiles TypeScript to JavaScript in a dist/ folder, which runs when present: a published package then runs on the
// Node versions the NativeScript CLI supports, not only those that strip types (23.6+), and from node_modules, where
// Node strips none. Beside it, in dist/types, the declarations of the public entries (package.json `exports`).
//   node bin/build-dist.mjs                the compiler: src/ into dist/, the declarations into dist/types
//   node bin/build-dist.mjs --types [dir]  the declarations alone, into dir (default dist/types): the bins keep running src/
// A framework adapter builds with `buildDist` (bin/ns-compiled-adapter.js build).
import ts from 'typescript';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Each `.ts` file under `src` (but `.d.ts`) compiled to `.js` at its place under `dist`, which is emptied first; other
 * files are copied when `copy`. Folders `skip` matches (by their path from `src`, `/`-separated) are left out.
 */
export function buildDist(src, dist, { skip = () => false, copy = false } = {}) {
	rmSync(dist, { recursive: true, force: true });
	const walk = (dir) =>
		readdirSync(dir).flatMap((f) => {
			const full = join(dir, f);
			if (!statSync(full).isDirectory()) return [full];
			return skip(relative(src, full).split(sep).join('/')) ? [] : walk(full);
		});
	let count = 0;
	for (const file of walk(src)) {
		const rel = relative(src, file).split(sep).join('/');
		const out = join(dist, relative(src, file));
		if (!file.endsWith('.ts') || file.endsWith('.d.ts')) {
			if (copy) {
				mkdirSync(dirname(out), { recursive: true });
				writeFileSync(out, readFileSync(file));
			}
			continue;
		}
		// CLI extension entry points are loaded synchronously via `require()` by nativescript-cli.
		const isCliCjs = rel.startsWith('cli/');
		const source = isCliCjs ? readFileSync(file, 'utf8').replace(/\bimport\.meta\.dirname\b/g, '__dirname') : readFileSync(file, 'utf8');
		const { outputText, diagnostics } = ts.transpileModule(source, {
			fileName: file,
			reportDiagnostics: true,
			compilerOptions: {
				module: isCliCjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
				rewriteRelativeImportExtensions: true,
				verbatimModuleSyntax: false,
				sourceMap: false,
			},
		});
		if (diagnostics?.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`);
		mkdirSync(dirname(out), { recursive: true });
		if (isCliCjs) {
			const cjsText = outputText.replace(/require\((['"])(\.\.?\/[^'"]+)\.js\1\)/g, 'require($1$2.cjs$1)');
			writeFileSync(out.replace(/\.ts$/, '.cjs'), cjsText);
		} else {
			writeFileSync(out.replace(/\.ts$/, '.js'), outputText);
		}
		count++;
	}
	return count;
}

/**
 * A declaration file's relative imports of `.ts` files as imports of their `.js`, which a consumer resolves to the
 * `.d.ts` beside it: declaration emit keeps the specifiers as the sources write them.
 */
function declarationSpecifiers(context) {
	const f = context.factory;
	const js = (spec) => (spec && ts.isStringLiteral(spec) && /^\.\.?\//.test(spec.text) && spec.text.endsWith('.ts') ? f.createStringLiteral(spec.text.replace(/\.ts$/, '.js')) : spec);
	const visit = (n) => {
		if (ts.isImportDeclaration(n)) return f.updateImportDeclaration(n, n.modifiers, n.importClause, js(n.moduleSpecifier), n.attributes);
		if (ts.isExportDeclaration(n)) return f.updateExportDeclaration(n, n.modifiers, n.isTypeOnly, n.exportClause, js(n.moduleSpecifier), n.attributes);
		if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) return f.updateImportTypeNode(n, f.updateLiteralTypeNode(n.argument, js(n.argument.literal)), n.attributes, n.qualifier, n.typeArguments, n.isTypeOf);
		return ts.visitEachChild(n, visit, context);
	};
	return (sf) => (ts.isSourceFile(sf) ? ts.visitEachChild(sf, visit, context) : sf);
}

/** The public entries, in src/api: what package.json `exports` names. */
export const PUBLIC_ENTRIES = ['adapter-api.ts', 'binding-api.ts'];

/**
 * The declarations of the public entries in `out`, which is emptied first, with the TypeScript internals they declare
 * (typescript-internal.d.ts); returns the files written, relative to `out`. Fails on a type error, and where the
 * declarations would reach a module outside src/api: what an adapter compiles against is the API alone.
 */
export function buildTypes(root, out) {
	const api = join(root, 'src', 'api');
	rmSync(out, { recursive: true, force: true });
	const program = ts.createProgram(
		PUBLIC_ENTRIES.map((f) => join(api, f)),
		{
			declaration: true,
			emitDeclarationOnly: true,
			rewriteRelativeImportExtensions: true,
			allowImportingTsExtensions: true,
			verbatimModuleSyntax: true,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ES2023,
			lib: ['lib.es2024.d.ts'],
			types: [],
			strict: true,
			rootDir: api,
			outDir: out,
		},
	);
	const outside = program
		.getSourceFiles()
		.map((sf) => sf.fileName)
		.filter((f) => !f.includes('/node_modules/') && relative(api, f).startsWith('..'));
	if (outside.length) throw new Error(`the public API reaches modules outside src/api: ${outside.map((f) => relative(root, f)).join(', ')}`);
	const written = [];
	const emitted = program.emit(
		undefined,
		(file, text) => {
			mkdirSync(dirname(file), { recursive: true });
			// A referenced declaration file of src/api is copied beside the output (below): referenced there.
			writeFileSync(file, text.replace(/(\/\/\/ <reference path=")[^"]*\/([^/"]+\.d\.ts")/g, '$1./$2'));
			written.push(relative(out, file));
		},
		undefined,
		true,
		{ afterDeclarations: [declarationSpecifiers] },
	);
	const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
	for (const f of readdirSync(api).filter((f) => f.endsWith('.d.ts'))) {
		writeFileSync(join(out, f), readFileSync(join(api, f)));
		written.push(f);
	}
	return written.sort();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const dist = join(root, 'dist');
	const args = process.argv.slice(2);
	if (!args.includes('--types')) {
		const count = buildDist(join(root, 'src'), dist, { copy: true });
		console.log(`${count} modules compiled to ${relative(process.cwd(), dist) || dist}`);
	}
	const types = args.includes('--types') ? resolve(args.find((a) => !a.startsWith('--')) ?? join(dist, 'types')) : join(dist, 'types');
	const files = buildTypes(root, types);
	console.log(`${files.length} declaration files in ${relative(process.cwd(), types) || types}`);
}
