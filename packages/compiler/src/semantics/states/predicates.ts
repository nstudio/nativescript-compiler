// Syntax-tree and type questions the value-states ask, which read no state of theirs.
import ts from 'typescript';
import { alwaysEnds } from '../lang.ts';
import { isStatic } from '../throws.ts';
import { reassigned } from '../nullish.ts';

/** The operators that convert their operands to numbers or strings. */
export const CONVERTING = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]);

/** Whether a type admits null and undefined both, and nothing untyped. */
export function bothEmpty(t: ts.Type): boolean {
	const parts = t.isUnion() ? t.types : [t];
	return parts.some((x) => x.flags & ts.TypeFlags.Null) && parts.some((x) => x.flags & ts.TypeFlags.Undefined) && !parts.some((x) => x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/** Whether a type admits null but not undefined. */
export function onlyNull(t: ts.Type): boolean {
	const parts = t.isUnion() ? t.types : [t];
	return parts.some((x) => x.flags & ts.TypeFlags.Null) && !parts.some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/**
 * A name read at `at` that a guard has made truthy: `at` is inside the true branch of `if (x)` / `x && …` / `x ? … :`, or
 * follows `if (!x) <ends>` in a block on the way out. Only for a name nothing assigns after its declaration.
 */
export function truthyAt(e: ts.Expression, at: ts.Node, checker: ts.TypeChecker): boolean {
	e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	if (!ts.isIdentifier(e)) return false;
	const sym = checker.getSymbolAtLocation(e),
		d = sym?.valueDeclaration;
	if (!sym || !d || (!ts.isVariableDeclaration(d) && !ts.isParameter(d)) || (ts.isVariableDeclaration(d) ? reassigned(d, checker) : assignedParameter(d, checker))) return false;
	const names = (x: ts.Expression) => ts.isIdentifier((x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses))) && checker.getSymbolAtLocation(x) === sym;
	const negated = (x: ts.Expression) => ((x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses)), ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken && names(x.operand));
	for (let n: ts.Node = at; n.parent && !ts.isFunctionLike(n); n = n.parent) {
		const p = n.parent;
		if (ts.isIfStatement(p) && p.thenStatement === n && names(p.expression)) return true;
		if (ts.isIfStatement(p) && p.elseStatement === n && negated(p.expression)) return true;
		if (ts.isConditionalExpression(p) && p.whenTrue === n && names(p.condition)) return true;
		if (ts.isBlock(p) || ts.isSourceFile(p)) {
			for (const st of (p as ts.Block).statements) {
				if (st === n) break;
				if (ts.isIfStatement(st) && negated(st.expression) && alwaysEnds(st.thenStatement)) return true;
				// A member read of it that always runs first (`if (x.parent) …`, `x.load();`) has thrown had it been empty.
				const first = ts.isIfStatement(st) ? st.expression : ts.isExpressionStatement(st) ? st.expression : undefined;
				if (first && dereferences(first, names)) return true;
			}
		}
	}
	return false;
}

/** An expression whose evaluation starts by reading a member of a name `names` accepts (`x.a`, `x.a.b()`, `x.m()`), no `?.` on the way. */
function dereferences(e: ts.Expression, names: (x: ts.Expression) => boolean): boolean {
	let x: ts.Expression = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	for (;;) {
		if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) x = ts.skipOuterExpressions(x.operand, ts.OuterExpressionKinds.Parentheses);
		else if (ts.isCallExpression(x) && !x.questionDotToken) x = x.expression;
		else if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && !x.questionDotToken) {
			if (names(x.expression)) return true;
			x = x.expression;
		} else return false;
	}
}

export function assignedParameter(p: ts.ParameterDeclaration, checker: ts.TypeChecker): boolean {
	const sym = ts.isIdentifier(p.name) ? checker.getSymbolAtLocation(p.name) : undefined;
	if (!sym) return true;
	const visit = (n: ts.Node): boolean => (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(ts.skipOuterExpressions(n.left)) && checker.getSymbolAtLocation(ts.skipOuterExpressions(n.left)) === sym) || !!ts.forEachChild(n, visit);
	return visit(p.parent);
}

/**
 * A read JavaScript converts where it stands (an operand of arithmetic, `+` or a comparison, a template's part, `String(x)`,
 * `Number(x)`): undefined becomes NaN or "undefined" there. Anywhere else the value is placed as it is.
 */
export function convertedRead(e: ts.Expression): boolean {
	let x: ts.Node = e;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent,
		K = ts.SyntaxKind;
	if (ts.isTemplateSpan(p)) return true;
	if (ts.isPrefixUnaryExpression(p)) return [K.PlusToken, K.MinusToken, K.TildeToken].includes(p.operator);
	if (ts.isBinaryExpression(p)) {
		const op = p.operatorToken.kind;
		if ([K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken].includes(op)) return p.right === x;
		return [K.PlusToken, K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken, K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken].includes(op);
	}
	return ts.isCallExpression(p) && p.arguments[0] === x && ts.isIdentifier(p.expression) && ['String', 'Number'].includes(p.expression.text);
}

/** A type naming a type parameter anywhere in it (`T`, `T[]`, `Map<string, T>`): what it holds is each instantiation's. */
export function mentionsTypeParameter(checker: ts.TypeChecker, t: ts.Type, depth = 0): boolean {
	if (depth > 4) return false;
	if (t.flags & ts.TypeFlags.TypeParameter) return !(t as { isThisType?: boolean }).isThisType;
	if (t.isUnionOrIntersection()) return t.types.some((u) => mentionsTypeParameter(checker, u, depth + 1));
	return !!(t.flags & ts.TypeFlags.Object) && !!((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) && checker.getTypeArguments(t as ts.TypeReference).some((a) => mentionsTypeParameter(checker, a, depth + 1));
}

/** A member read that is written: an assignment's target, an update's operand, a `delete`'s. */
export function assigned(n: ts.Node): boolean {
	let x = n;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	if (ts.isBinaryExpression(p)) return p.left === x && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
	return ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p) ? [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator) : ts.isDeleteExpression(p);
}

/** The same reference read twice: a name of one symbol, `this`, or a member of the same name of the same reference. */
export function sameReference(a: ts.Expression, b: ts.Expression, checker: ts.TypeChecker): boolean {
	const x = ts.skipOuterExpressions(a, ts.OuterExpressionKinds.Parentheses),
		y = ts.skipOuterExpressions(b, ts.OuterExpressionKinds.Parentheses);
	if (x.kind === ts.SyntaxKind.ThisKeyword) return y.kind === ts.SyntaxKind.ThisKeyword;
	if (ts.isIdentifier(x)) return ts.isIdentifier(y) && x.text === y.text && checker.getSymbolAtLocation(x) === checker.getSymbolAtLocation(y);
	return ts.isPropertyAccessExpression(x) && ts.isPropertyAccessExpression(y) && !x.questionDotToken && x.name.text === y.name.text && sameReference(x.expression, y.expression, checker);
}

/** A field: a class's own (not static), an interface's or type literal's, or a parameter property. */
export function fieldLike(d: ts.Declaration): boolean {
	if (ts.isPropertyDeclaration(d)) return ts.isIdentifier(d.name) && !isStatic(d) && ts.isClassLike(d.parent);
	if (ts.isPropertySignature(d)) return ts.isIdentifier(d.name) && (ts.isInterfaceDeclaration(d.parent) || ts.isTypeLiteralNode(d.parent));
	return ts.isParameter(d) && ts.isIdentifier(d.name) && ts.isParameterPropertyDeclaration(d, d.parent);
}

/** Whether `a` reaches its store (`storeOf`) through a conditional's branch, a shorthand field or a logical assignment. */
export function strictOnlyRoute(a: ts.Expression): boolean {
	let x: ts.Node = a,
		branch = false;
	for (;;) {
		if (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		else if (ts.isConditionalExpression(x.parent) && x.parent.condition !== x) {
			x = x.parent;
			branch = true;
		} else break;
	}
	const p = x.parent;
	return branch || ts.isShorthandPropertyAssignment(p) || (ts.isBinaryExpression(p) && p.right === x && p.operatorToken.kind !== ts.SyntaxKind.EqualsToken);
}

/**
 * What a non-async function's promise is resolved with where nothing is given: `return Promise.resolve(x)` gives `x`,
 * `return new Promise(executor)` what the executor's calls of its `resolve` give; any other return gives a value.
 */
export function resolvedGiven(fn: ts.FunctionLikeDeclaration, checker: ts.TypeChecker): { null: boolean; missing: boolean; unknown: boolean } {
	const out = { null: false, missing: false, unknown: false };
	const gives = (x: ts.Expression | undefined): void => {
		const e = x && ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
		if (!e || (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e)) out.missing = true;
		else if (e.kind === ts.SyntaxKind.NullKeyword) out.null = true;
	};
	const resolves = (ex: ts.Expression | undefined): void => {
		if (!ex || !(ts.isArrowFunction(ex) || ts.isFunctionExpression(ex)) || !ex.parameters[0] || !ts.isIdentifier(ex.parameters[0].name)) return;
		const res = checker.getSymbolAtLocation(ex.parameters[0].name);
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && checker.getSymbolAtLocation(n.expression) === res) gives(n.arguments[0]);
			ts.forEachChild(n, visit);
		};
		ts.forEachChild(ex.body, visit);
	};
	const visit = (n: ts.Node): void => {
		if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
		if (ts.isReturnStatement(n) && n.expression) {
			const e = ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses);
			if (isPromiseNew(e)) resolves(e.arguments?.[0]);
			else if (isPromiseResolve(e)) gives(e.arguments[0]);
		}
		ts.forEachChild(n, visit);
	};
	if (fn.body) ts.forEachChild(fn.body, visit);
	return out;
}

export function isPromiseNew(e: ts.Expression): e is ts.NewExpression {
	return ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Promise';
}

export function isPromiseResolve(e: ts.Expression): e is ts.CallExpression {
	return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'resolve' && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'Promise';
}

export function returnsEmptyLiteral(fn: ts.FunctionLikeDeclaration): boolean {
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
		if (ts.isReturnStatement(n) && n.expression) {
			const e = ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses);
			if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) {
				found = true;
				return;
			}
		}
		ts.forEachChild(n, visit);
	};
	if (fn.body) ts.forEachChild(fn.body, visit);
	return found;
}

/** Whether a value is only tested (a condition, the operand of `!`). */
export function onlyTested(e: ts.Expression): boolean {
	const p = e.parent;
	if (ts.isParenthesizedExpression(p)) return onlyTested(p);
	if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
	if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return p.expression === e;
	if (ts.isConditionalExpression(p) || ts.isForStatement(p)) return p.condition === e;
	return false;
}

/** An assertion that names the type its operand has already, empty states aside (`window as UIWindow | undefined`). */
export function sameObjectType(c: ts.TypeChecker, value: ts.Expression, asserted: ts.Expression): boolean {
	return c.getNonNullableType(c.getTypeAtLocation(value)) === c.getNonNullableType(c.getTypeAtLocation(asserted));
}
