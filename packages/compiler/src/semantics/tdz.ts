// Module-level `let`/`const` bindings belonging to an import cycle, which may be read or written before their
// initializer runs (JavaScript's TDZ ReferenceError). Only cyclic app modules carry TDZ guards so acyclic modules
// and library kits emit zero extra overhead.
import ts from 'typescript';
import { hasModifier } from './ast.ts';

/**
 * The module-level `let` and `const` declarations (with initializers) in `files` that belong to an import cycle
 * (SCC of size > 1 or self-import in the value-import graph).
 */
export function cyclicModuleBindings(checker: ts.TypeChecker, files: readonly ts.SourceFile[]): Set<ts.VariableDeclaration> {
	const sources = files.filter((f) => !f.isDeclarationFile);
	if (sources.length < 2) return new Set();
	const fileSet = new Set(sources);
	const edges = new Map<ts.SourceFile, Set<ts.SourceFile>>();
	const resolveTargets = (sf: ts.SourceFile, seen: Set<ts.SourceFile>): Set<ts.SourceFile> => {
		const out = new Set<ts.SourceFile>();
		for (const st of sf.statements) {
			let spec: ts.Expression | undefined;
			if (ts.isImportDeclaration(st)) {
				if (st.importClause?.isTypeOnly) continue;
				const nb = st.importClause?.namedBindings;
				if (nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly)) continue;
				spec = st.moduleSpecifier;
			} else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
				if (st.isTypeOnly) continue;
				if (st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.length > 0 && st.exportClause.elements.every((e) => e.isTypeOnly)) continue;
				spec = st.moduleSpecifier;
			}
			if (!spec) continue;
			const target = checker.getSymbolAtLocation(spec)?.valueDeclaration;
			if (!target || !ts.isSourceFile(target) || target.isDeclarationFile) continue;
			if (fileSet.has(target)) out.add(target);
			else if (!seen.has(target)) {
				seen.add(target);
				for (const nested of resolveTargets(target, seen)) out.add(nested);
			}
		}
		return out;
	};
	for (const sf of sources) edges.set(sf, resolveTargets(sf, new Set([sf])));

	// Tarjan's SCC algorithm to find every file participating in an import cycle.
	let nextIndex = 0;
	const index = new Map<ts.SourceFile, number>();
	const low = new Map<ts.SourceFile, number>();
	const stack: ts.SourceFile[] = [];
	const onStack = new Set<ts.SourceFile>();
	const cyclic = new Set<ts.SourceFile>();
	const strongConnect = (v: ts.SourceFile) => {
		index.set(v, nextIndex);
		low.set(v, nextIndex);
		nextIndex++;
		stack.push(v);
		onStack.add(v);
		for (const w of edges.get(v) ?? []) {
			if (!index.has(w)) {
				strongConnect(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v)!, index.get(w)!));
			}
		}
		if (low.get(v) === index.get(v)) {
			const component: ts.SourceFile[] = [];
			for (;;) {
				const w = stack.pop()!;
				onStack.delete(w);
				component.push(w);
				if (w === v) break;
			}
			if (component.length > 1 || edges.get(v)?.has(v)) {
				for (const f of component) cyclic.add(f);
			}
		}
	};
	for (const sf of sources) if (!index.has(sf)) strongConnect(sf);

	const out = new Set<ts.VariableDeclaration>();
	for (const sf of cyclic) {
		for (const st of sf.statements) {
			if (!ts.isVariableStatement(st) || hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
			if (!(st.declarationList.flags & ts.NodeFlags.BlockScoped)) continue;
			for (const d of st.declarationList.declarations) {
				if (ts.isIdentifier(d.name) && d.initializer) out.add(d);
			}
		}
	}
	return out;
}
