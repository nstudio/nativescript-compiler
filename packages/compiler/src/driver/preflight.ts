// Preflight: the constructs a compiled release cannot run, found before any
// translation, each reported with the TypeScript file and line it is on and
// what to write instead. A construct listed here would otherwise either fail
// later inside swiftc or kotlinc, pointing into generated code, or compile and
// then fail at run time. Everything is reported at once.
//
// The rules are the documented subset's edges (docs: "Supported subset and
// known differences"); a rule is added with its diff case or probe.
import ts from 'typescript';
import { checkSharing } from '../semantics/sharing.ts';
import { refusalOf, type RefusalId } from '../semantics/refusals.ts';

export interface PreflightFinding {
	file: string;
	line: number;
	column: number;
	what: string;
	id: RefusalId;
	hint: string;
	code: string;
}

/** Where a node is in the source the developer wrote (a component's own file for its virtual class). */
export type Locate = (n: ts.Node) => { file: string; line: number } | null;

/** Lib globals the runtimes do not provide. */
const UNSUPPORTED_GLOBALS: Record<string, RefusalId> = {
	Proxy: 'proxy',
	Reflect: 'reflect',
	eval: 'eval',
	Function: 'function-constructor',
	FinalizationRegistry: 'finalization-registry',
	SharedArrayBuffer: 'shared-array-buffer',
	Atomics: 'atomics',
};

const isLibFile = (f: string) => /[\\/]typescript[\\/]lib[\\/]lib\.[\w.]+\.d\.ts$/.test(f);
const inNodeModules = (f: string) => /[\\/]node_modules[\\/]/.test(f);

/**
 * Names whose only declaration is the app's own ambient `declare const|let|var`,
 * written as a bundler constant (`__API_URL__`, `APP_VERSION`): a value only a
 * bundler `define` gives, read where nothing assigns it.
 */
const DEFINE_LIKE = /^(__[\w$]+__|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/;

/**
 * The findings for `files`. `locate` maps a node to the source the developer wrote; without one, a node is
 * reported where it is in the program. `keeps` selects the top-level statements that are compiled.
 */
export function preflight(checker: ts.TypeChecker, files: readonly ts.SourceFile[], locate?: Locate, keeps?: (st: ts.Statement) => boolean, lenient?: (file: string) => boolean): PreflightFinding[] {
	const out: PreflightFinding[] = [];
	const seen = new Set<string>();
	const report = (n: ts.Node, what: string, id: RefusalId, hint: string = refusalOf(id).suggestion) => {
		const sf = n.getSourceFile();
		const at = locate?.(n);
		const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf));
		const f: PreflightFinding = { file: at?.file ?? sf.fileName, line: at?.line ?? lc.line + 1, column: lc.character + 1, what, id, hint, code: n.getText(sf).split('\n')[0].slice(0, 80) };
		const key = `${f.file}:${f.line}:${f.column}:${what}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(f);
		}
	};

	// Globals a module assigns (`globalThis.X = …`, `global.X = …`, `(global as any).X = …`): read at run time, not defined.
	const assignedGlobals = new Set<string>();
	const collectAssigned = (n: ts.Node): void => {
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			let target: ts.Expression = n.left;
			if (ts.isPropertyAccessExpression(target)) {
				let obj: ts.Expression = target.expression;
				while (ts.isParenthesizedExpression(obj) || ts.isAsExpression(obj) || ts.isNonNullExpression(obj)) obj = obj.expression;
				if (ts.isIdentifier(obj) && ['global', 'globalThis', 'window', 'self'].includes(obj.text)) assignedGlobals.add(target.name.text);
			} else if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
				assignedGlobals.add(target.argumentExpression.text);
			}
		}
		ts.forEachChild(n, collectAssigned);
	};
	files.forEach(collectAssigned);

	/** Static truth of a feature-detection test on an unsupported lib global (`typeof FinalizationRegistry === 'function'` -> false). */
	const staticUnsupportedTest = (e: ts.Expression): boolean | undefined => {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		const K = ts.SyntaxKind;
		if (ts.isPrefixUnaryExpression(x) && x.operator === K.ExclamationToken) {
			const inner = staticUnsupportedTest(x.operand);
			return inner === undefined ? undefined : !inner;
		}
		if (!ts.isBinaryExpression(x)) return undefined;
		const op = x.operatorToken.kind;
		if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
			const l = staticUnsupportedTest(x.left);
			if (l === (op === K.BarBarToken)) return l;
			const r = staticUnsupportedTest(x.right);
			if (r === (op === K.BarBarToken)) return r;
			return l !== undefined ? r : undefined;
		}
		const eq = op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken;
		const neq = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
		if (!eq && !neq) return undefined;
		const [t, lit] = ts.isTypeOfExpression(x.left) && ts.isStringLiteralLike(x.right) ? [x.left, x.right] : ts.isTypeOfExpression(x.right) && ts.isStringLiteralLike(x.left) ? [x.right, x.left] : [null, null];
		if (!t || !lit || !ts.isIdentifier(t.expression) || !UNSUPPORTED_GLOBALS[t.expression.text]) return undefined;
		const decls = checker.getSymbolAtLocation(t.expression)?.declarations ?? [];
		if (!decls.length || !decls.every((d) => isLibFile(d.getSourceFile().fileName))) return undefined;
		const same = lit.text === 'undefined';
		return eq ? same : !same;
	};

	const visit = (n: ts.Node): void => {
		if (ts.isConditionalExpression(n)) {
			const decided = staticUnsupportedTest(n.condition);
			if (decided !== undefined) {
				visit(decided ? n.whenTrue : n.whenFalse);
				return;
			}
		} else if (ts.isIfStatement(n)) {
			const decided = staticUnsupportedTest(n.expression);
			if (decided !== undefined) {
				if (decided) visit(n.thenStatement);
				else if (n.elseStatement) visit(n.elseStatement);
				return;
			}
		} else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
			const decided = staticUnsupportedTest(n.left);
			if (decided === (n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return;
		}
		if (n.kind === ts.SyntaxKind.WithStatement) {
			report(n, '`with`', 'with');
		} else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const arg = n.arguments[0];
			if (!arg || !ts.isStringLiteralLike(arg)) report(n, 'import() of a computed specifier', 'computed-import');
		} else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require' && n.arguments.length && !ts.isStringLiteralLike(n.arguments[0])) {
			report(n, 'require() of a computed specifier', 'computed-require');
		} else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'arguments' && n.name.text === 'callee') {
			report(n, '`arguments.callee`', 'arguments-callee');
		} else if (ts.isPropertyAccessExpression(n) && n.name.text === '__proto__') {
			report(n, '`__proto__`', 'proto');
		} else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === '__proto__') {
			// A non-computed `__proto__:` sets the literal's prototype; a computed or shorthand one is an own property.
			report(n, '`__proto__` as an object literal key', 'proto');
		} else if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'process' && n.expression.name.text === 'env' && !declaredInApp(checker, n.expression.expression)) {
			report(n, `process.env.${n.name.text}, which the bundler did not define`, 'process-env', `a compiled release has no process environment: define process.env.${n.name.text} in the bundler config (Vite \`define\`, webpack DefinePlugin), which the compiled build reads too`);
		} else if (ts.isIdentifier(n) && isValueReference(n)) {
			const sym = checker.getSymbolAtLocation(n);
			const decls = sym?.declarations ?? [];
			const global = UNSUPPORTED_GLOBALS[n.text];
			const functionSupported = n.text === 'Function' && ((ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.name.text === 'prototype') || (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && n.parent.right === n));
			const typeofProbe = ts.isTypeOfExpression(n.parent) && n.parent.expression === n;
			if (global && !functionSupported && !typeofProbe && decls.length && decls.every((d) => isLibFile(d.getSourceFile().fileName))) {
				report(n, n.text === 'eval' || n.text === 'Function' ? `\`${n.text}\`` : `\`${n.text}\` (not provided by the compiled runtime)`, global);
			} else if (DEFINE_LIKE.test(n.text) && decls.length && !assignedGlobals.has(n.text) && decls.every((d) => isAmbientAppVariable(d))) {
				report(n, `${n.text}, declared but never given a value`, 'undefined-constant', `if your bundler defines ${n.text} (Vite \`define\`, webpack DefinePlugin), the compiled build reads the same config: check the name there; otherwise assign globalThis.${n.text} before it is read`);
			}
		}
		ts.forEachChild(n, visit);
	};
	// A plugin module's statements the app never reaches are not compiled.
	for (const sf of files) if (!sf.isDeclarationFile) for (const st of sf.statements) if (!keeps || keeps(st)) visit(st);
	checkSharing(checker, files, report, keeps, lenient);
	return out;
}

/** `file:line:col: what: code` then the hint, one finding per entry. */
export function formatPreflight(findings: PreflightFinding[]): string {
	return findings.map((f) => `${f.file}:${f.line}:${f.column}: ${f.what} is not supported in a compiled release: ${f.code}\n    hint: ${f.hint}`).join('\n');
}

function isAmbientAppVariable(d: ts.Declaration): boolean {
	const file = d.getSourceFile().fileName;
	if (inNodeModules(file) || isLibFile(file) || file.startsWith('/__shims__/')) return false;
	if (!ts.isVariableDeclaration(d)) return false;
	return d.getSourceFile().isDeclarationFile || !!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient);
}

/** `process` is the app's own (a module variable or parameter), not Node's. */
function declaredInApp(checker: ts.TypeChecker, id: ts.Identifier): boolean {
	const decls = checker.getSymbolAtLocation(id)?.declarations ?? [];
	return decls.some((d) => !d.getSourceFile().isDeclarationFile && !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient));
}

/** An identifier read as a value: not a declaration's name, a member name, a type or a label. */
function isValueReference(n: ts.Identifier): boolean {
	const p = n.parent;
	if (!p) return false;
	if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
	if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === n) return false;
	if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isBindingElement(p)) && p.name === n) return false;
	if (ts.isBindingElement(p) && p.propertyName === n) return false;
	if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
	if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ImplementsKeyword)) return false;
	return true;
}
