// Receivers and `thisArg`: unchecked receivers, the built-in methods that take a `thisArg`, and functions that read `this`.
import ts from 'typescript';
import { declaresThis, isLibDeclaration } from '../ast.ts';
import { TYPED_ARRAYS } from '../globals.ts';

/**
 * A member read's receiver that TypeScript's types let through though it can
 * be missing at run time: a non-null assertion (`x!.name`), or an array
 * element of an object type (`items[i].name`, read past the end). The read
 * throws JavaScript's TypeError there; which value is missing names it in the message.
 */
export function unsafeReceiver(target: ts.Expression, checker: ts.TypeChecker): 'undefined' | 'null' | null {
	while (ts.isParenthesizedExpression(target)) target = target.expression;
	const objectLike = (t: ts.Type) => !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike | ts.TypeFlags.TypeParameter));
	// A read the checker types as maybe missing, unasserted (`meeting.host.name` of `host?: Person` in a non-strict app).
	let outer: ts.Node = target;
	while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
	const read = outer.parent;
	const unasserted = (ts.isPropertyAccessExpression(target) || ts.isIdentifier(target)) && !ts.isOptionalChain(target) && (ts.isPropertyAccessExpression(read) || ts.isElementAccessExpression(read)) && read.expression === outer && !read.questionDotToken;
	if (ts.isNonNullExpression(target) || unasserted) {
		const value = ts.isNonNullExpression(target) ? target.expression : target;
		// A front end's own assertion on a signal it set before any template reads it (`this.x.value!`).
		const held = ts.isPropertyAccessExpression(value) ? checker.getSymbolAtLocation(value.name)?.declarations?.[0] : undefined;
		if (held?.getSourceFile().fileName.startsWith('/__shims__/')) return null;
		const t = checker.getTypeAtLocation(value);
		const parts = t.isUnion() ? t.types : [t];
		const undefinedOk = parts.some((p) => p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
		const nullOk = parts.some((p) => p.flags & ts.TypeFlags.Null);
		if (!undefinedOk && !nullOk) return null;
		const present = checker.getNonNullableType(t);
		// A string, number or boolean's member of undefined is as much a TypeError as an object's.
		const primitive = !ts.isNonNullExpression(target) && !(present.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) && !!(present.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike));
		return objectLike(present) || primitive ? (nullOk && !undefinedOk ? 'null' : 'undefined') : null;
	}
	const array = ts.isElementAccessExpression(target) ? checker.getNonNullableType(checker.getTypeAtLocation(target.expression)) : null;
	// In an optional chain (`a?.[0].name`) too: past the chain's short circuit the element may still be missing.
	if (array && checker.isArrayType(array)) {
		// The checker adds the chain's undefined to a link's type: the element's own type is the array's.
		const el = ts.isOptionalChain(target) ? checker.getIndexTypeOfType(array, ts.IndexKind.Number) : checker.getTypeAtLocation(target);
		if (!el) return null;
		return objectLike(el) && !(el.isUnion() && el.types.some((p) => p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) ? 'undefined' : null;
	}
	return null;
}

/**
 * `re.exec(s)` or `s.match(re)` typed without the null of no match, as a program checked without strictNullChecks
 * types it: a member read of it is JavaScript's TypeError where there is no match.
 */
export function uncheckedMatch(target: ts.Expression, checker: ts.TypeChecker): boolean {
	while (ts.isParenthesizedExpression(target)) target = target.expression;
	if (!ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression) || !['exec', 'match'].includes(target.expression.name.text)) return false;
	const decl = checker.getResolvedSignature(target)?.declaration;
	const owner = decl && ts.isMethodSignature(decl) && ts.isInterfaceDeclaration(decl.parent) ? decl.parent.name.text : null;
	if (!decl || !/[\\/]lib\.[\w.]*\.d\.ts$/.test(decl.getSourceFile().fileName) || owner !== (target.expression.name.text === 'exec' ? 'RegExp' : 'String')) return false;
	const t = checker.getTypeAtLocation(target);
	return !(t.isUnion() && t.types.some((p) => p.flags & ts.TypeFlags.Null));
}

/**
 * The member read a statement starts with when its receiver is narrowed to
 * `never` (`x.android` in the else of `if (x)`, x an object, as folding
 * `if (__APPLE__ && x)` leaves it): that code runs only when x is null or
 * undefined, so it throws there before anything else in it runs.
 */
export function leadingNeverRead(st: ts.Statement, checker: ts.TypeChecker): ts.PropertyAccessExpression | null {
	let e: ts.Expression | undefined = ts.isExpressionStatement(st) ? st.expression : ts.isVariableStatement(st) ? st.declarationList.declarations[0]?.initializer : ts.isReturnStatement(st) || ts.isThrowStatement(st) ? st.expression : undefined;
	while (e) {
		if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && checker.getTypeAtLocation(e.expression).flags & ts.TypeFlags.Never) return e;
		if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
		else if (ts.isBinaryExpression(e) && !(e.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) e = e.left;
		else return null;
	}
	return null;
}

/** Whether a statement beside a `for` declares one of the loop's variable names. */
export function redeclaredBeside(loop: ts.ForStatement, list: ts.VariableDeclarationList): boolean {
	const names = new Set(list.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : [])));
	const parent = ts.isLabeledStatement(loop.parent) ? loop.parent.parent : loop.parent;
	const siblings = ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent) ? parent.statements : [];
	const declares = (st: ts.Statement): boolean => {
		const inner = ts.isLabeledStatement(st) ? st.statement : st;
		const l = ts.isVariableStatement(inner) ? inner.declarationList : ts.isForStatement(inner) && inner.initializer && ts.isVariableDeclarationList(inner.initializer) ? inner.initializer : null;
		return !!l && l.declarations.some((d) => ts.isIdentifier(d.name) && names.has(d.name.text));
	};
	return siblings.some((st) => st !== loop && st !== loop.parent && declares(st));
}

/** The array and typed array methods calling their callback with a thisArg as `this` (typed arrays have no flatMap). */
const THIS_ARG_METHODS = new Set(['forEach', 'map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap']);

/**
 * A built-in's call taking a callback and the thisArg it calls it with as `this` (`xs.some(cb, thisArg)`,
 * `map.forEach(cb, thisArg)`, `Array.from(items, cb, thisArg)`): the callback, the thisArg if given, and the callback
 * when it is a function expression reading its own `this`, which is then the thisArg (undefined without one) as the
 * call is made: the function is not a method value then, its `this` read as a value the call holds.
 */
export function thisArgCall(e: ts.CallExpression, checker: ts.TypeChecker): { callback: ts.Expression; thisArg?: ts.Expression; bound: ts.FunctionExpression | null } | null {
	if (!ts.isPropertyAccessExpression(e.expression) || e.arguments.some(ts.isSpreadElement)) return null;
	const name = e.expression.name.text,
		owner = e.expression.expression;
	if (!isLibDeclaration(checker.getSymbolAtLocation(e.expression.name)?.declarations?.[0])) return null;
	let at = 0;
	if (name === 'from' && ts.isIdentifier(owner) && (owner.text === 'Array' || TYPED_ARRAYS.includes(owner.text))) at = 1;
	else {
		const t = checker.getNonNullableType(checker.getTypeAtLocation(owner));
		const kind = t.getSymbol()?.name ?? '';
		const own = name === 'forEach' && ['Map', 'Set', 'ReadonlyMap', 'ReadonlySet'].includes(kind);
		if (!own && !(THIS_ARG_METHODS.has(name) && (checker.isArrayLikeType(t) || (TYPED_ARRAYS.includes(kind) && name !== 'flatMap')))) return null;
	}
	const callback = e.arguments[at];
	if (!callback) return null;
	const thisArg = e.arguments[at + 1];
	const fn = ts.skipParentheses(callback);
	return { callback, thisArg, bound: ts.isFunctionExpression(fn) && readsThis(fn) ? fn : null };
}

/**
 * How a built-in's call taking a callback and a thisArg (`thisArgCall`) is made (`frontMethods.thisArgUse`): as it is;
 * with the bound callback's `this` undefined (no thisArg); with the thisArg held before the call and read as the bound
 * callback's `this` (`self` the `this` it declares); or with a thisArg the callback ignores evaluated still, first.
 */
export type ThisArgUse = { readonly kind: 'plain' } | { readonly kind: 'unbound'; readonly bound: ts.FunctionExpression } | { readonly kind: 'held'; readonly bound: ts.FunctionExpression; readonly thisArg: ts.Expression; readonly self: ts.ParameterDeclaration | undefined } | { readonly kind: 'evaluated'; readonly thisArg: ts.Expression };

/** `thisArgCall`'s call made without its thisArg, for a translation of the call taking none. */
export function withoutThisArg(e: ts.CallExpression, thisArg: ts.Expression | undefined): ts.CallExpression {
	return Object.create(e, { arguments: { value: ts.factory.createNodeArray(e.arguments.filter((a) => a !== thisArg)) } });
}

/** A function expression whose `this` the built-in call it is the callback of gives (`thisArgCall`'s bound one). */
export function thisArgBound(fn: ts.FunctionExpression, checker: ts.TypeChecker): boolean {
	let call: ts.Node = fn.parent;
	while (ts.isParenthesizedExpression(call)) call = call.parent;
	return ts.isCallExpression(call) && thisArgCall(call, checker)?.bound === fn;
}

/**
 * A function expression held untyped that takes the receiver it is called with as `this`: one declaring `this`, or
 * reading its own. A method value then, which a call with a receiver (`Array.prototype.some.call(list, fn, thisArg)`)
 * gives it.
 */
export function takesReceiver(fn: ts.FunctionExpression): boolean {
	return declaresThis(fn) || readsThis(fn);
}

/**
 * Whether an array method's callback runs the same whatever thisArg gives it as `this`: an arrow,
 * a function that never reads `this`, or `this.method` beside `this` (a method value is bound to its object).
 */
export function ignoresThisArg(callback: ts.Expression, thisArg: ts.Expression, checker: ts.TypeChecker): boolean {
	while (ts.isParenthesizedExpression(callback)) callback = callback.expression;
	if (ts.isArrowFunction(callback)) return true;
	if (ts.isFunctionExpression(callback)) return !readsThis(callback);
	if (ts.isPropertyAccessExpression(callback)) return callback.expression.kind === ts.SyntaxKind.ThisKeyword && thisArg.kind === ts.SyntaxKind.ThisKeyword;
	if (!ts.isIdentifier(callback)) return false;
	let sym = checker.getSymbolAtLocation(callback);
	if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
	const decl = sym?.valueDeclaration;
	return !!decl && ts.isFunctionDeclaration(decl) && !!decl.body && !readsThis(decl);
}

/** Whether a function's own `this` is read: in its body or an arrow function's inside it. */
function readsThis(fn: ts.FunctionLikeDeclaration): boolean {
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (n.kind === ts.SyntaxKind.ThisKeyword) {
			found = true;
			return;
		}
		if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
		if (ts.isClassLike(n)) return;
		ts.forEachChild(n, visit);
	};
	for (const p of fn.parameters) visit(p);
	if (fn.body) visit(fn.body);
	return found;
}
