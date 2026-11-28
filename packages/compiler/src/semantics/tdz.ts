// Module-level `let`/`const` bindings that may be read or written before their initializer runs (JavaScript's TDZ
// ReferenceError): either belonging to an import cycle or read by a function / earlier statement in the same module
// when executable code runs before the declaration. Other module bindings and library kits emit zero extra overhead.
import ts from 'typescript';
import { hasModifier, resolveSymbol } from './ast.ts';

/** Whether a top-level statement before a declaration can run user code (and thus invoke a hoisted function or closure). */
function canRunCode(st: ts.Statement): boolean {
	if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEmptyStatement(st)) return false;
	if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) return false;
	if (ts.isVariableStatement(st)) return st.declarationList.declarations.some((d) => !!d.initializer && exprCanRunCode(d.initializer));
	if (ts.isClassDeclaration(st)) return st.members.some((m) => ts.isClassStaticBlockDeclaration(m) || (ts.isPropertyDeclaration(m) && !!(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) && !!m.initializer && exprCanRunCode(m.initializer)));
	return true;
}

/** Whether an expression may invoke a function, getter, constructor, or other non-literal code at evaluation time. */
function exprCanRunCode(e: ts.Expression): boolean {
	if (ts.isLiteralExpression(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword || ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isIdentifier(e)) return false;
	if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return exprCanRunCode(e.expression);
	if (ts.isPrefixUnaryExpression(e)) return exprCanRunCode(e.operand);
	if (ts.isBinaryExpression(e)) return exprCanRunCode(e.left) || exprCanRunCode(e.right);
	if (ts.isArrayLiteralExpression(e)) return e.elements.some((x) => !ts.isOmittedExpression(x) && exprCanRunCode(ts.isSpreadElement(x) ? x.expression : x));
	if (ts.isObjectLiteralExpression(e)) return e.properties.some((p) => (ts.isPropertyAssignment(p) && exprCanRunCode(p.initializer)) || (ts.isSpreadAssignment(p) && exprCanRunCode(p.expression)));
	return true;
}

/** Collects same-module `let`/`const` declarations that may be observed before their initializer executes. */
function addSameModuleTdz(checker: ts.TypeChecker, sf: ts.SourceFile, out: Set<ts.VariableDeclaration>): void {
	const decls = new Map<ts.Symbol, { decl: ts.VariableDeclaration; stmtIndex: number; declIndex: number }>();
	for (let i = 0; i < sf.statements.length; i++) {
		const st = sf.statements[i];
		if (!ts.isVariableStatement(st) || hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
		if (!(st.declarationList.flags & ts.NodeFlags.BlockScoped)) continue;
		for (let j = 0; j < st.declarationList.declarations.length; j++) {
			const d = st.declarationList.declarations[j];
			if (!ts.isIdentifier(d.name) || !d.initializer || out.has(d)) continue;
			const sym = checker.getSymbolAtLocation(d.name);
			if (sym) decls.set(sym, { decl: d, stmtIndex: i, declIndex: j });
		}
	}
	if (!decls.size) return;

	// Track which hoisted function declarations are reachable from executable statements before each statement index.
	const hoistedFns = new Map<ts.Symbol, ts.FunctionDeclaration>();
	for (const st of sf.statements) {
		if (ts.isFunctionDeclaration(st) && st.name && st.body) {
			const sym = checker.getSymbolAtLocation(st.name);
			if (sym) hoistedFns.set(sym, st);
		}
	}

	const isRef = (n: ts.Identifier): boolean => {
		const p = n.parent;
		if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isTypeReferenceNode(p)) return false;
		if (ts.isVariableDeclaration(p) && p.name === n) return false;
		if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
		if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n) return false;
		return true;
	};

	const referencedFnsIn = (root: ts.Node): Set<ts.Symbol> => {
		const refs = new Set<ts.Symbol>();
		const visit = (n: ts.Node) => {
			if (ts.isIdentifier(n) && isRef(n)) {
				const sym = resolveSymbol(n, checker);
				if (sym && hoistedFns.has(sym)) refs.add(sym);
			}
			ts.forEachChild(n, visit);
		};
		ts.forEachChild(root, visit);
		return refs;
	};

	const fnCalls = new Map<ts.Symbol, Set<ts.Symbol>>();
	for (const [sym, fn] of hoistedFns) fnCalls.set(sym, referencedFnsIn(fn.body!));

	const closeReach = (seeds: Set<ts.Symbol>): Set<ts.Symbol> => {
		const reached = new Set<ts.Symbol>(seeds);
		const queue = [...seeds];
		while (queue.length) {
			const cur = queue.pop()!;
			for (const next of fnCalls.get(cur) ?? []) {
				if (!reached.has(next)) {
					reached.add(next);
					queue.push(next);
				}
			}
		}
		return reached;
	};

	const reachableFnsBefore: Set<ts.Symbol>[] = new Array(sf.statements.length);
	const seenBefore = new Set<ts.Symbol>();
	for (let i = 0; i < sf.statements.length; i++) {
		reachableFnsBefore[i] = closeReach(seenBefore);
		const st = sf.statements[i];
		if (!ts.isFunctionDeclaration(st) && canRunCode(st)) {
			for (const s of referencedFnsIn(st)) seenBefore.add(s);
		}
	}

	const walk = (node: ts.Node, stmtIndex: number, hoistedSym: ts.Symbol | null, inDeferredScope: boolean) => {
		if (ts.isIdentifier(node) && isRef(node)) {
			const sym = resolveSymbol(node, checker);
			const entry = sym ? decls.get(sym) : undefined;
			if (entry) {
				const beforeDecl = stmtIndex < entry.stmtIndex;
				const inOwnInit = !inDeferredScope && stmtIndex === entry.stmtIndex && node.pos >= entry.decl.initializer!.pos && node.end <= entry.decl.initializer!.end;
				const fnReachableEarly = !!hoistedSym && reachableFnsBefore[entry.stmtIndex].has(hoistedSym);
				if ((beforeDecl && !inDeferredScope) || fnReachableEarly || inOwnInit) {
					out.add(entry.decl);
				}
			}
		}
		const entersDeferred = ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
		ts.forEachChild(node, (child) => walk(child, stmtIndex, hoistedSym, inDeferredScope || entersDeferred));
	};

	for (let i = 0; i < sf.statements.length; i++) {
		const st = sf.statements[i];
		const hoistedSym = ts.isFunctionDeclaration(st) && st.name ? (checker.getSymbolAtLocation(st.name) ?? null) : null;
		walk(st, i, hoistedSym, false);
	}
}

/**
 * The module-level `let` and `const` declarations (with initializers) in `files` that may be read or written before
 * their initializer runs: either in an import cycle (SCC of size > 1 or self-import) or reachable before initialization
 * within the same module.
 */
export function cyclicModuleBindings(checker: ts.TypeChecker, files: readonly ts.SourceFile[]): Set<ts.VariableDeclaration> {
	const sources = files.filter((f) => !f.isDeclarationFile);
	const out = new Set<ts.VariableDeclaration>();
	for (const sf of sources) addSameModuleTdz(checker, sf, out);
	if (sources.length < 2) return out;
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
