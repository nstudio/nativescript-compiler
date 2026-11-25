// Definite assignment of fields and code that always throws or ends.
import ts from 'typescript';
import { hasStatic } from './members.ts';

/** The type a slot declares: a function's result, or the declaration's own type. */
export function slotType(d: ts.Declaration, checker: ts.TypeChecker): ts.Type | null {
	if (ts.isFunctionLike(d)) return checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration)?.getReturnType() ?? null;
	const name = (d as ts.NamedDeclaration).name;
	return name ? checker.getTypeAtLocation(name) : null;
}

/**
 * The fields of a class its code sets to null though their written type leaves null out (`colors: string[] = null`,
 * `this.indices = h.length ? h : null`): code checked without strictNullChecks, where such a field holds null apart from undefined.
 */
export function nullSetFields(cls: ts.ClassLikeDeclaration): ts.PropertyDeclaration[] {
	const givesNull = (e: ts.Expression): boolean => {
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (e.kind === ts.SyntaxKind.NullKeyword) return true;
		if (ts.isConditionalExpression(e)) return givesNull(e.whenTrue) || givesNull(e.whenFalse);
		return ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind) && givesNull(e.right);
	};
	const nullable = (t: ts.TypeNode) => t.kind === ts.SyntaxKind.AnyKeyword || t.kind === ts.SyntaxKind.UnknownKeyword || (ts.isUnionTypeNode(t) && t.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword)));
	return cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) && ts.isIdentifier(m.name) && !!m.type && !nullable(m.type) && ((!!m.initializer && givesNull(m.initializer)) || assignedValues(m).some(givesNull)));
}

/** Whether a field's initializer is null. */
export function initializedNull(m: ts.PropertyDeclaration): boolean {
	return !!m.initializer && ts.skipOuterExpressions(m.initializer, ts.OuterExpressionKinds.Parentheses).kind === ts.SyntaxKind.NullKeyword;
}

/** The values a class's own code assigns its field (`this.name = value`). */
export function assignedValues(field: ts.PropertyDeclaration): ts.Expression[] {
	const name = field.name.getText(),
		out: ts.Expression[] = [];
	const visit = (x: ts.Node): void => {
		if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(x.left) && x.left.expression.kind === ts.SyntaxKind.ThisKeyword && x.left.name.text === name) out.push(x.right);
		ts.forEachChild(x, visit);
	};
	ts.forEachChild(field.parent, visit);
	return out;
}

/**
 * The fields of a class with no base that its constructor assigns on every path before any read of them and before
 * `this` escapes it (a method called on it, `this` passed or stored, a function that captures it): a backend may hold
 * them as their type, never undefined. Anything the walk cannot follow ends it, keeping only what was assigned before.
 */
export function definitelyAssignedFields(cls: ts.ClassLikeDeclaration): Set<ts.PropertyDeclaration> {
	const out = new Set<ts.PropertyDeclaration>();
	if (cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) return out;
	const fields = new Map<string, ts.PropertyDeclaration>();
	for (const m of cls.members) {
		if (ts.isPropertyDeclaration(m) && !m.initializer && !hasStatic(m) && ts.isIdentifier(m.name) && !m.questionToken) fields.set(m.name.text, m);
	}
	const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
	if (!fields.size || !ctor?.body) return out;
	// The class's other fields and parameter properties: reading or writing one runs nothing.
	const plain = new Set<string>();
	for (const m of cls.members) if (ts.isPropertyDeclaration(m) && !hasStatic(m) && ts.isIdentifier(m.name) && !fields.has(m.name.text)) plain.add(m.name.text);
	for (const p of ctor.parameters) if (ts.isIdentifier(p.name) && ts.getModifiers(p)?.length) plain.add(p.name.text);
	const unsafe = new Set<string>();
	type State = { assigned: Set<string>; done: boolean };
	const isThis = (n: ts.Node) => n.kind === ts.SyntaxKind.ThisKeyword;
	const fieldOf = (n: ts.Node): string | null => (ts.isPropertyAccessExpression(n) && isThis(n.expression) && ts.isIdentifier(n.name) && fields.has(n.name.text) ? n.name.text : null);
	// Whether `n` uses `this` other than reading a field: an escape. A read of a field not yet assigned marks it unsafe.
	const escapes = (n: ts.Node, s: State): boolean => {
		let escaped = false;
		const visit = (x: ts.Node) => {
			if (escaped) return;
			if (ts.isFunctionLike(x) || ts.isClassLike(x)) {
				if (containsThis(x)) escaped = true;
				return;
			}
			const f = fieldOf(x);
			if (f !== null) {
				const p = ts.walkUpParenthesizedExpressions(x.parent);
				// A field written, or a method it holds called on `this`: more than a read.
				if ((ts.isBinaryExpression(p) && p.left === ts.skipOuterExpressions(x) && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p) || (ts.isCallExpression(p) && p.expression === x) || ts.isDeleteExpression(p)) {
					escaped = true;
					return;
				}
				if (!s.assigned.has(f)) unsafe.add(f);
				return;
			}
			if (ts.isPropertyAccessExpression(x) && isThis(x.expression)) {
				const p = ts.walkUpParenthesizedExpressions(x.parent);
				// Another field read or written; anything else (an accessor, a method, a function a field holds called) may run anything.
				if (ts.isIdentifier(x.name) && plain.has(x.name.text) && !(ts.isCallExpression(p) && p.expression === x)) return;
				escaped = true;
				return;
			}
			if (isThis(x) || x.kind === ts.SyntaxKind.SuperKeyword) {
				escaped = true;
				return;
			}
			ts.forEachChild(x, visit);
		};
		visit(n);
		return escaped;
	};
	const all = () => new Set(fields.keys());
	const walk = (stmts: readonly ts.Statement[], s: State): State => {
		for (const st of stmts) {
			if (s.done) return s;
			if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const f = fieldOf(ts.skipOuterExpressions(st.expression.left));
				if (f !== null) {
					if (escapes(st.expression.right, s)) return { assigned: s.assigned, done: true };
					s = { assigned: new Set([...s.assigned, f]), done: false };
					continue;
				}
			}
			if (ts.isIfStatement(st)) {
				if (escapes(st.expression, s)) return { assigned: s.assigned, done: true };
				const a = walk(ts.isBlock(st.thenStatement) ? st.thenStatement.statements : [st.thenStatement], { assigned: new Set(s.assigned), done: false });
				const b = st.elseStatement ? walk(ts.isBlock(st.elseStatement) ? st.elseStatement.statements : [st.elseStatement], { assigned: new Set(s.assigned), done: false }) : { assigned: new Set(s.assigned), done: false };
				const ends = (x: State, branch: ts.Statement | undefined) => !!branch && !x.done && alwaysThrows(branch);
				const left = ends(a, st.thenStatement) ? all() : a.assigned,
					right = ends(b, st.elseStatement) ? all() : b.assigned;
				s = { assigned: new Set([...left].filter((f) => right.has(f))), done: a.done || b.done };
				continue;
			}
			if (ts.isBlock(st)) {
				s = walk(st.statements, s);
				continue;
			}
			if (ts.isThrowStatement(st)) return { assigned: all(), done: true };
			if (ts.isVariableStatement(st) || ts.isExpressionStatement(st)) {
				if (escapes(st, s)) return { assigned: s.assigned, done: true };
				continue;
			}
			// A loop, a switch, a try, a return: not followed. Whatever it does with `this` ends the walk.
			escapes(st, s);
			return { assigned: s.assigned, done: true };
		}
		return s;
	};
	// Field initializers run before the body: one that lets `this` escape leaves every field unsure.
	const start: State = { assigned: new Set(), done: false };
	for (const m of cls.members) if (ts.isPropertyDeclaration(m) && m.initializer && !hasStatic(m) && escapes(m.initializer, start)) return out;
	const end = walk(ctor.body.statements, start);
	for (const [name, d] of fields) if (end.assigned.has(name) && !unsafe.has(name)) out.add(d);
	return out;
}

export function containsThis(n: ts.Node): boolean {
	let found = false;
	const visit = (x: ts.Node) => {
		if (found) return;
		if (x.kind === ts.SyntaxKind.ThisKeyword || x.kind === ts.SyntaxKind.SuperKeyword) {
			found = true;
			return;
		}
		// A nested function or class has its own `this`, except an arrow function.
		if ((ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isClassLike(x)) && x !== n) return;
		ts.forEachChild(x, visit);
	};
	ts.forEachChild(n, visit);
	return found;
}

export function alwaysThrows(st: ts.Statement): boolean {
	if (ts.isThrowStatement(st)) return true;
	if (ts.isBlock(st)) return st.statements.some((s) => ts.isThrowStatement(s));
	return false;
}

/** Whether a statement always returns or throws: a body whose end it isn't may give undefined there. */
export function alwaysEnds(st: ts.Statement | undefined): boolean {
	if (!st) return false;
	if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
	if (ts.isBlock(st)) return alwaysEnds(st.statements[st.statements.length - 1]);
	if (ts.isIfStatement(st)) return alwaysEnds(st.thenStatement) && alwaysEnds(st.elseStatement);
	if (ts.isTryStatement(st)) return (!!st.finallyBlock && alwaysEnds(st.finallyBlock)) || (alwaysEnds(st.tryBlock) && (!st.catchClause || alwaysEnds(st.catchClause.block)));
	if (ts.isSwitchStatement(st)) {
		const clauses = st.caseBlock.clauses;
		return clauses.some(ts.isDefaultClause) && clauses.every((c, k) => (c.statements.length ? alwaysEnds(c.statements[c.statements.length - 1]) : k < clauses.length - 1));
	}
	return false;
}

/** Whether an expression's value is unused: a statement of its own, or a for loop's clause. */
export function statementLevel(e: ts.Expression): boolean {
	let n: ts.Node = e;
	while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
	const p = n.parent;
	return ts.isExpressionStatement(p) || (ts.isForStatement(p) && (p.incrementor === n || p.initializer === n)) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken && p.left === n);
}
