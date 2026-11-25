// Syntax-tree questions both backends ask, answered the same way for each.
import ts from 'typescript';

/**
 * `o.k = (o = other)`, `o.k += (o = other).k`: an assignment to a member of the variable `o` whose value assigns `o`.
 * Script evaluates the target's object before the value, so the member is written on the object `o` held first.
 */
export function reassignedBase(e: ts.Expression, checker: ts.TypeChecker): ts.Identifier | null {
	const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	if (!ts.isBinaryExpression(x) || x.operatorToken.kind < ts.SyntaxKind.FirstAssignment || x.operatorToken.kind > ts.SyntaxKind.LastAssignment) return null;
	const target = ts.skipOuterExpressions(x.left, ts.OuterExpressionKinds.Parentheses);
	if (!(ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) || !ts.isIdentifier(target.expression)) return null;
	const base = target.expression;
	const sym = checker.getSymbolAtLocation(base);
	if (!sym) return null;
	const assigns = (n: ts.Node): boolean => {
		if (ts.isFunctionLike(n)) return false;
		const written = ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? n.left : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) ? n.operand : undefined;
		const w = written && ts.skipOuterExpressions(written, ts.OuterExpressionKinds.Parentheses);
		if (w && ts.isIdentifier(w) && checker.getSymbolAtLocation(w) === sym) return true;
		return !!ts.forEachChild(n, (c) => assigns(c) || undefined);
	};
	return assigns(x.right) ? base : null;
}

/** Whether a closure inside `body` refers to the variable `name` declares. */
export function capturedIn(name: ts.Identifier, body: ts.Node, checker: ts.TypeChecker): boolean {
	const sym = checker.getSymbolAtLocation(name);
	let found = false;
	const visit = (n: ts.Node, inClosure: boolean) => {
		if (found) return;
		if (inClosure && ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym) {
			found = true;
			return;
		}
		ts.forEachChild(n, (c) => visit(c, inClosure || ts.isFunctionLike(n)));
	};
	visit(body, false);
	return found;
}

/** The `this` nodes of a function, and of the arrow functions inside it. */
export function thisNodes(fn: ts.Node): ts.Node[] {
	const out: ts.Node[] = [];
	const visit = (n: ts.Node) => {
		if (n.kind === ts.SyntaxKind.ThisKeyword) out.push(n);
		if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isAccessor(n) || ts.isClassLike(n) || ts.isConstructorDeclaration(n))) return;
		ts.forEachChild(n, visit);
	};
	visit(fn);
	return out;
}

/** Whether a `continue label` inside `n` targets the loop labeled `label`. */
export function continuesTo(n: ts.Node, label: string): boolean {
	let found = false;
	const visit = (c: ts.Node) => {
		if (found || ts.isFunctionLike(c)) return;
		if (ts.isContinueStatement(c) && c.label?.text === label) {
			found = true;
			return;
		}
		ts.forEachChild(c, visit);
	};
	visit(n);
	return found;
}

/** A Swift parameter's type without its default value (`= nil`). */
export function withoutDefault(text: string): string {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if ('([<'.includes(ch)) depth++;
		else if (')]>'.includes(ch) && text[i - 1] !== '-') depth--;
		else if (ch === '=' && depth === 0 && text[i + 1] !== '=') return text.slice(0, i);
	}
	return text;
}

/** `Symbol.iterator`, as the library declares `Symbol`. */
export function isSymbolIterator(e: ts.Expression, checker: ts.TypeChecker): boolean {
	return ts.isPropertyAccessExpression(e) && e.name.text === 'iterator' && ts.isIdentifier(e.expression) && e.expression.text === 'Symbol' && !!checker.getSymbolAtLocation(e.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * How many of a built-in's callback arguments (element, index, array) a function value reads: its signature's
 * parameters, at least one; every argument where it is held untyped, as script calls it with all of them.
 */
export function callbackArity(e: ts.Expression, checker: ts.TypeChecker): number {
	const t = checker.getTypeAtLocation(e);
	if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return Infinity;
	return Math.max(1, t.getCallSignatures()[0]?.getParameters().length ?? 1);
}

/**
 * `x instanceof Object`, `Object` the library's: true of every object and function whose prototype chain reaches
 * Object.prototype, false of null and the primitives, which no class test of the value's native type tells apart.
 */
export function isObjectInstanceTest(e: ts.BinaryExpression, checker: ts.TypeChecker): boolean {
	return e.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(e.right) && e.right.text === 'Object' && isLibDeclaration(resolveSymbol(e.right, checker)?.declarations?.[0]);
}

/** A declaration in a declarations file of the program's own (an app's `globals.d.ts`), not a package's, the compiler's shims or the ES library. */
export function isAppDeclarationFile(d: ts.Node | undefined): boolean {
	const f = d?.getSourceFile();
	return !!f && f.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(f.fileName) && !f.fileName.startsWith('/__shims__/') && !isLibDeclaration(d);
}

export function boundNames(name: ts.BindingName): ts.Identifier[] {
	if (ts.isIdentifier(name)) return [name];
	return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : boundNames(e.name)));
}

export function isLibDeclaration(d: ts.Node | undefined): boolean {
	return !!d && /[\\/]typescript[\\/]lib[\\/]/.test(d.getSourceFile().fileName);
}

/** The symbol a name refers to, through imports; a shorthand property's name (`{ name }`) refers to what it reads. */
export function resolveSymbol(n: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
	const sym = ts.isIdentifier(n) && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
	return sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

export function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);
}

/** The mixins of a core class installed so far that define a method of this name, by their index among those that do. */
export function mixinChain(target: string, method: string): string {
	return `__mixins_${target}_${method}`;
}

/** Whether a module function `fn` called at `at` is shadowed by a member of the class around it, as a bare name is in Swift and Kotlin. */
export function shadowedByMember(at: ts.Node, decl: ts.Declaration | undefined, fn: string, ident: (name: string) => string): boolean {
	if (!decl || !ts.isFunctionDeclaration(decl) || !ts.isSourceFile(decl.parent)) return false;
	const cls = ts.findAncestor(at, ts.isClassLike);
	return !!cls && cls.members.some((m) => !!m.name && ts.isIdentifier(m.name) && ident(m.name.text) === fn);
}

/** The final copy of a method that `X.prototype.m.call(obj, …)` calls (see `nonVirtualEntry`). */
export function nonVirtualName(method: string, cls: string): string {
	return `${method}__${cls}`;
}

/** A node an assignment or an increment writes, or a target in a destructuring assignment's pattern. */
export function isWriteTarget(e: ts.Node): boolean {
	let x = e;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	if (ts.isBinaryExpression(p) && p.left === x && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
	if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
	return inAssignmentPattern(e);
}

/** A target inside a destructuring assignment's pattern (`[a, o.b] = …`, `({ x: arr[0] } = …)`, `for ([k, v] of …)`). */
export function inAssignmentPattern(e: ts.Node): boolean {
	let n = e;
	for (;;) {
		const p = n.parent;
		if (!p) return false;
		if (ts.isParenthesizedExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === n) || (ts.isShorthandPropertyAssignment(p) && p.name === n)) {
			n = p;
			continue;
		}
		if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isArrayLiteralExpression(p.parent) || ts.isPropertyAssignment(p.parent))) {
			n = p;
			continue;
		}
		if (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)) {
			const q = p.parent;
			if ((ts.isBinaryExpression(q) && q.left === p && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) || ((ts.isForOfStatement(q) || ts.isForInStatement(q)) && q.initializer === p)) return true;
			n = p;
			continue;
		}
		return false;
	}
}

/** Whether `n` holds a jump of this kind that leaves it: not one inside a nested function, nor a break or continue of a nested loop. */
export function containsJump(n: ts.Node, kind: ts.SyntaxKind): boolean {
	let found = false;
	const visit = (c: ts.Node) => {
		if (found || ts.isFunctionLike(c)) return;
		if (c.kind === kind) {
			found = true;
			return;
		}
		// A break or continue inside a nested loop belongs to that loop.
		if ((kind === ts.SyntaxKind.ContinueStatement || kind === ts.SyntaxKind.BreakStatement) && ts.isIterationStatement(c, false)) return;
		ts.forEachChild(c, visit);
	};
	ts.forEachChild(n, visit);
	if (n.kind === kind) return true;
	return found;
}

/** The implementation of an overload signature (one without a body) in source; null for anything else. */
export function implementationOf(d: ts.SignatureDeclaration | ts.JSDocSignature): ts.FunctionLikeDeclaration | null {
	if (ts.isJSDocSignature(d) || d.getSourceFile().isDeclarationFile || ('body' in d && d.body)) return null;
	if (ts.isConstructorDeclaration(d)) return d.parent.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body) ?? null;
	if ((ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) && d.name) {
		const siblings = ts.isMethodDeclaration(d) ? (d.parent as ts.ClassLikeDeclaration).members : (d.parent as ts.SourceFile | ts.ModuleBlock | ts.Block).statements;
		return (siblings as ts.NodeArray<ts.Node>).find((m): m is ts.FunctionLikeDeclaration => (ts.isMethodDeclaration(m) || ts.isFunctionDeclaration(m)) && !!m.body && m.name?.getText() === d.name!.getText()) ?? null;
	}
	return null;
}

/** What a `var` named `name` at `n` belongs to: its function, static block, namespace or module, or a catch clause whose parameter it names (`catch (e) { var e = 3 }`). */
function varOwner(n: ts.Node, name: string): ts.Node | undefined {
	return ts.findAncestor(n, (a) => ts.isFunctionLike(a) || ts.isClassStaticBlockDeclaration(a) || ts.isModuleDeclaration(a) || ts.isSourceFile(a) || (ts.isCatchClause(a) && !!a.variableDeclaration && ts.isIdentifier(a.variableDeclaration.name) && a.variableDeclaration.name.text === name));
}

const inStatementOf = (x: ts.Declaration, parent: ts.Node) => ts.isVariableDeclaration(x) && ts.isVariableStatement(x.parent.parent) && x.parent.parent.parent === parent;

/**
 * A `var` declaring a variable another declaration declares, so assigning it: an earlier `var` of the same block, or,
 * for a `var` in a nested block of a module's statements (`{ var n = n + 5 }`, a loop's head), a `var` statement of the module.
 */
export function redeclaredVar(d: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
	if (d.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) return false;
	const st = d.parent.parent;
	const decls = checker.getSymbolAtLocation(d.name)?.declarations ?? [];
	if (ts.isVariableStatement(st) && decls.some((x) => x.pos < d.pos && inStatementOf(x, st.parent))) return true;
	const sf = d.getSourceFile();
	if (!(ts.isVariableStatement(st) ? st.parent !== sf : ts.isForStatement(st))) return false;
	return varOwner(st, d.name.getText()) === sf && decls.some((x) => inStatementOf(x, sf));
}

/**
 * The module's variables only `var`s in its nested blocks declare (`if (…) { var observer = … }`), each as all its
 * declarations: one variable of the module, which every declaration assigns. Not one a for-in or for-of head declares.
 */
export function moduleBlockVars(sf: ts.SourceFile, checker: ts.TypeChecker): ts.VariableDeclaration[][] {
	const vars = new Map<ts.Symbol, ts.VariableDeclaration[]>();
	const own = (x: ts.Declaration) => ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && !(x.parent.flags & ts.NodeFlags.BlockScoped) && !inStatementOf(x, sf) && !ts.isForInStatement(x.parent.parent) && !ts.isForOfStatement(x.parent.parent) && x.getSourceFile() === sf && varOwner(x, x.name.text) === sf;
	const collect = (n: ts.Node) => {
		if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && own(n)) {
			const sym = checker.getSymbolAtLocation(n.name);
			if (sym?.declarations?.every(own)) vars.set(sym, [...(vars.get(sym) ?? []), n]);
		}
		ts.forEachChild(n, collect);
	};
	for (const st of sf.statements) if (!ts.isVariableStatement(st) && !ts.isFunctionDeclaration(st) && !ts.isClassDeclaration(st) && !ts.isModuleDeclaration(st) && !hasModifier(st, ts.SyntaxKind.DeclareKeyword)) ts.forEachChild(st, collect);
	return [...vars.values()];
}

/** A member name the program's own source declares (not a declaration file, the platform's typings among them). */
export function appMember(name: ts.Node, checker: ts.TypeChecker): boolean {
	const decl = checker.getSymbolAtLocation(name)?.declarations?.[0];
	return !!decl && !decl.getSourceFile().isDeclarationFile;
}

/** A function declaration with a `this` parameter (not `this: void`). */
export function declaresThis(fn: ts.SignatureDeclaration): boolean {
	const first = fn.parameters[0];
	return !!first && ts.isIdentifier(first.name) && first.name.text === 'this' && first.type?.kind !== ts.SyntaxKind.VoidKeyword;
}

/** A function type or function expression declaring its `this` with a type other than void. */
export function takesOwnThis(d: ts.Declaration | undefined): boolean {
	return !!d && (ts.isFunctionTypeNode(d) || ts.isFunctionExpression(d)) && d.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === 'this' && !!q.type && q.type.kind !== ts.SyntaxKind.VoidKeyword);
}

/** Whether `this` appears in `e` outside nested functions, methods and classes, which bind their own. */
export function refersToThis(e: ts.Node): boolean {
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (n.kind === ts.SyntaxKind.ThisKeyword) {
			found = true;
			return;
		}
		if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isClassLike(n)) return;
		ts.forEachChild(n, visit);
	};
	visit(e);
	return found;
}

/**
 * `e` as V8 prints an expression in its TypeErrors: the JavaScript, without TypeScript's assertions, a string-literal
 * key as a dot access, a call's arguments as `...`; parentheses only around an operand other than a name, member or call.
 */
export function v8Text(e: ts.Expression): string {
	const x = ts.skipOuterExpressions(e);
	if (ts.isPropertyAccessExpression(x)) return `${v8Text(x.expression)}${x.questionDotToken ? '?.' : '.'}${x.name.text}`;
	if (ts.isElementAccessExpression(x)) {
		const key = ts.skipOuterExpressions(x.argumentExpression);
		return ts.isStringLiteral(key) && /^[A-Za-z_$][\w$]*$/.test(key.text) ? `${v8Text(x.expression)}.${key.text}` : `${v8Text(x.expression)}[${v8Text(key)}]`;
	}
	if (ts.isCallExpression(x)) return `${v8Text(x.expression)}(...)`;
	const text = x.getText().replace(/\s+/g, ' ');
	let inner: ts.Expression = e;
	while (!ts.isParenthesizedExpression(inner) && inner !== x) inner = (inner as ts.AsExpression).expression;
	return ts.isParenthesizedExpression(inner) && !ts.isIdentifier(x) && x.kind !== ts.SyntaxKind.ThisKeyword ? `(${text})` : text;
}

/** V8's TypeError for iterating `e` where it is not iterable. */
export function notIterable(e: ts.Expression): string {
	const x = ts.skipOuterExpressions(e);
	return ts.isCallExpression(x) ? `${v8Text(x.expression)} is not a function or its return value is not iterable` : `${v8Text(x)} is not iterable`;
}
