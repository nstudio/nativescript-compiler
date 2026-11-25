// JavaScript's arrays and iteration as the checker types them: evolving arrays, spreads and what iterating a value reads.
import ts from 'typescript';

/**
 * `type A = B & { x: T }` over non-generic interfaces and type literals only: the members of the type it names, each
 * property's first declaration, as one interface's. Null for any other alias.
 */
// A spread source whose fields are only known when it runs (`T`, `T & U`, `Partial<T>`): no fixed shape holds them all.
/** The declaration of the untyped `const xs = []` an identifier reads: TypeScript evolves its type with each push, the declaration holds any values. */
export function evolvingArrayRead(n: ts.Node, checker: ts.TypeChecker): ts.VariableDeclaration | undefined {
	if (!ts.isIdentifier(n) || (ts.isVariableDeclaration(n.parent) && n.parent.name === n)) return undefined;
	const d = checker.getSymbolAtLocation(n)?.valueDeclaration;
	if (!d || !ts.isVariableDeclaration(d) || d.type || !ts.isIdentifier(d.name) || !d.initializer) return undefined;
	const init = ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses);
	return ts.isArrayLiteralExpression(init) && !init.elements.length ? d : undefined;
}

const evolvingArrayTypes = new WeakMap<ts.VariableDeclaration, ts.Type | null>();
const holelessEvolvingArrayTypes = new WeakMap<ts.VariableDeclaration, ts.Type | null>();
/**
 * The `T[]` an evolving `const xs = []` is allocated as: the one array type stated where it goes (a typed declaration
 * or field it is assigned to, a declared return, a non-generic parameter). Null when it goes anywhere else, when it is
 * reassigned, or when something it is given is not a `T`. With `holeless`, also null when its name is read or written by
 * index and `holeless(T)`: JavaScript reads past the end as undefined and writes ahead of the length as holes, which an
 * array of a type without an empty slot cannot do.
 */
export function evolvingArrayType(d: ts.VariableDeclaration, checker: ts.TypeChecker, holeless?: (element: ts.Type) => boolean): ts.Type | null {
	const cache = holeless ? holelessEvolvingArrayTypes : evolvingArrayTypes;
	if (cache.has(d)) return cache.get(d)!;
	cache.set(d, null);
	const init = d.initializer && ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses);
	const statement = d.parent.parent;
	if (d.type || !ts.isIdentifier(d.name) || !init || !ts.isArrayLiteralExpression(init) || init.elements.length || (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))) return null;
	const sym = checker.getSymbolAtLocation(d.name);
	const scope = ts.findAncestor(d.parent, (x) => ts.isBlock(x) || ts.isSourceFile(x) || ts.isModuleBlock(x) || ts.isCaseBlock(x));
	if (!sym || !scope) return null;
	const typeOfNode = (t: ts.TypeNode | undefined): ts.Type | null => (t ? checker.getNonNullableType(checker.getTypeFromTypeNode(t)) : null);
	const statedSlot = (r: ts.Expression): ts.Type | null => {
		const p = r.parent;
		if (ts.isVariableDeclaration(p) && p.initializer === r) return typeOfNode(p.type);
		if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === r) {
			const target = ts.isPropertyAccessExpression(p.left) ? p.left.name : p.left;
			const decl = checker.getSymbolAtLocation(target)?.valueDeclaration;
			return decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isParameter(decl)) ? typeOfNode(decl.type) : null;
		}
		const fn = ts.isReturnStatement(p) ? ts.findAncestor(p, ts.isFunctionLike) : ts.isArrowFunction(p) && p.body === r ? p : undefined;
		if (fn) return ('modifiers' in fn ? fn.modifiers : undefined)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? null : typeOfNode(fn.type);
		if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== r) {
			const decl = checker.getResolvedSignature(p)?.getDeclaration();
			const param = decl && !ts.isJSDocSignature(decl) && !decl.typeParameters ? decl.parameters[p.arguments!.indexOf(r)] : undefined;
			return param && !param.dotDotDotToken ? typeOfNode(param.type) : null;
		}
		return null;
	};
	const given: ts.Expression[] = [];
	let found: ts.Type | null = null,
		ok = true,
		indexed = false;
	const visit = (x: ts.Node): void => {
		if (!ok) return;
		if (ts.isIdentifier(x) && x !== d.name && checker.getSymbolAtLocation(x) === sym) {
			let r: ts.Expression = x;
			while (ts.isParenthesizedExpression(r.parent) || (ts.isConditionalExpression(r.parent) && r.parent.condition !== r)) r = r.parent;
			const p = r.parent;
			if (ts.isPropertyAccessExpression(p) && p.expression === r) {
				const call = p.parent;
				if (ts.isCallExpression(call) && call.expression === p) {
					if (p.name.text === 'push' || p.name.text === 'unshift') given.push(...call.arguments);
					else if (p.name.text === 'splice') given.push(...call.arguments.slice(2));
					else if (p.name.text === 'fill' && call.arguments.length) given.push(call.arguments[0]);
				}
				return;
			}
			if (ts.isElementAccessExpression(p) && p.expression === r) {
				indexed = true;
				const w = p.parent;
				if (ts.isBinaryExpression(w) && w.left === p && w.operatorToken.kind === ts.SyntaxKind.EqualsToken) given.push(w.right);
				else if (ts.isBinaryExpression(w) && w.left === p && w.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment && w.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment) ok = false;
				return;
			}
			if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.expression === r) return;
			if (ts.isSpreadElement(p) || ts.isTypeOfExpression(p) || ts.isTemplateSpan(p) || (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken)) return;
			if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return;
			const t = statedSlot(r);
			const el = t && checker.isArrayType(t) ? checker.getTypeArguments(t as ts.TypeReference)[0] : undefined;
			if (!t || !el || el.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || hasTypeParameter(el) || (found && checker.getTypeArguments(found as ts.TypeReference)[0] !== el)) {
				ok = false;
				return;
			}
			found ??= t;
			return;
		}
		ts.forEachChild(x, visit);
	};
	visit(scope);
	if (!ok || !found) return null;
	const el = checker.getTypeArguments(found as ts.TypeReference)[0]!;
	if (indexed && holeless?.(el)) return null;
	for (const g of given) {
		const t = ts.isSpreadElement(g) ? checker.getTypeAtLocation(g.expression).getNumberIndexType() : checker.getTypeAtLocation(g);
		if (!t || !checker.isTypeAssignableTo(t, el)) return null;
	}
	cache.set(d, found);
	return found;
}

/** The element type of the stated `T[]` (`evolvingArrayType`) a value is given to (`xs.push(v)`, `xs[i] = v`). */
export function evolvingElementContext(e: ts.Expression, checker: ts.TypeChecker, holeless?: (element: ts.Type) => boolean): ts.Type | null {
	let n: ts.Node = e;
	while (ts.isParenthesizedExpression(n.parent) || (ts.isConditionalExpression(n.parent) && n.parent.condition !== n)) n = n.parent;
	const p = n.parent;
	let target: ts.Expression | undefined;
	if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression) && ts.isPropertyAccessExpression(p.expression) && ['push', 'unshift', 'splice', 'fill'].includes(p.expression.name.text)) target = p.expression.expression;
	else if (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(p.left)) target = p.left.expression;
	const d = target && evolvingArrayRead(ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses), checker);
	const t = d && evolvingArrayType(d, checker, holeless);
	return t ? checker.getTypeArguments(t as ts.TypeReference)[0]! : null;
}

function hasTypeParameter(t: ts.Type): boolean {
	if (t.flags & ts.TypeFlags.TypeParameter) return true;
	if (t.isUnionOrIntersection()) return t.types.some(hasTypeParameter);
	return !!(ts.getObjectFlags(t) & ts.ObjectFlags.Reference) && ((t as ts.TypeReference).typeArguments ?? []).some(hasTypeParameter);
}

/** A literal that is (a branch of) what `...` spreads into an object literal: TypeScript types it by the whole object, but only some of the whole's members are in it. */
export function spreadOperand(e: ts.Expression): boolean {
	let n: ts.Node = e;
	for (;;) {
		const p = n.parent;
		if (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== n)) n = p;
		else if (ts.isBinaryExpression(p) && p.right === n && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) n = p;
		else return ts.isSpreadAssignment(p);
	}
}

export function openSpreadType(t: ts.Type): boolean {
	if (t.isUnionOrIntersection()) return t.types.some(openSpreadType);
	if (t.flags & ts.TypeFlags.Instantiable) return true;
	return !!t.aliasTypeArguments?.some(openSpreadType) && !!(ts.getObjectFlags(t) & ts.ObjectFlags.Mapped);
}

export function intersectionAliasMembers(st: ts.TypeAliasDeclaration, checker: ts.TypeChecker): ts.TypeElement[] | null {
	if (!ts.isIntersectionTypeNode(st.type) || st.typeParameters?.length) return null;
	const sym = checker.getSymbolAtLocation(st.name);
	const t = sym && checker.getDeclaredTypeOfSymbol(sym);
	if (!t?.isIntersection()) return null;
	const plain = (u: ts.Type) => {
		const decls = u.getSymbol()?.declarations ?? [];
		return !!(u.flags & ts.TypeFlags.Object) && decls.length > 0 && !u.getCallSignatures().length && !u.getConstructSignatures().length && !u.getStringIndexType() && !u.getNumberIndexType() && decls.every((d) => ts.isTypeLiteralNode(d) || (ts.isInterfaceDeclaration(d) && !d.typeParameters?.length));
	};
	if (!t.types.every(plain)) return null;
	return t.getProperties().flatMap((p) => p.declarations?.filter((d): d is ts.TypeElement => ts.isPropertySignature(d) || ts.isMethodSignature(d)).slice(0, 1) ?? []);
}

/** A type's `[Symbol.iterator]` (or `[Symbol.asyncIterator]`) member. */
function iteratorMember(t: ts.Type, async: boolean): ts.Symbol | undefined {
	return t.getProperties().find((p) => p.escapedName.toString().startsWith(async ? '__@asyncIterator@' : '__@iterator@'));
}

/**
 * Whether iterating `e` goes through its class's checked `jsAnyIterator`: the `[Symbol.iterator]()` the program declares
 * for it gives other than an iterator class (`spelled`: the backend's spelling of the method's result).
 */
export function iteratesCheckedResult(e: ts.Expression, checker: ts.TypeChecker, spelled: (m: ts.MethodDeclaration) => string): boolean {
	const d = iteratorMember(checker.getNonNullableType(checker.getTypeAtLocation(e)), false)?.valueDeclaration;
	return !!d && ts.isMethodDeclaration(d) && !!d.body && !/^JS(Iterator|Generator)<.*>$/.test(spelled(d));
}

const ITERATING_SCRIPT = new Set(['Generator', 'Iterator', 'IterableIterator', 'IteratorObject', 'Iterable', 'AsyncGenerator', 'AsyncIterator', 'AsyncIterableIterator', 'AsyncIteratorObject', 'AsyncIterable']);
const ITERATING_BUILTIN = new Set(['Array', 'ReadonlyArray', 'Map', 'ReadonlyMap', 'Set', 'ReadonlySet', 'String', 'ArrayIterator', 'MapIterator', 'SetIterator', 'StringIterator', 'RegExpStringIterator', 'TemplateStringsArray', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']);

/**
 * Whether iterating a value of this type runs script (a generator's body, an
 * iterator class's `next`), which can throw: `for…of`, spread and
 * destructuring over it step the iteration protocol. Arrays, strings, maps,
 * sets and their built-in iterators iterate natively.
 */
export function iterationThrows(t: ts.Type, checker: ts.TypeChecker): boolean {
	if (t.isUnion()) return t.types.some((u) => !(u.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) && iterationThrows(u, checker));
	if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
	if (checker.isArrayType(t) || checker.isTupleType(t)) return false;
	const name = (t.aliasSymbol ?? t.getSymbol())?.getName() ?? '';
	if (ITERATING_BUILTIN.has(name)) return false;
	if (ITERATING_SCRIPT.has(name)) return true;
	return !!iteratorMember(t, false) || !!iteratorMember(t, true);
}

/** The type of the values an iterable yields (`T` of its `[Symbol.iterator]().next()`'s `IteratorYieldResult<T>`). */
export function iteratedType(t: ts.Type, checker: ts.TypeChecker, where: ts.Node, async = false): ts.Type | undefined {
	const member = iteratorMember(t, async);
	const iterator = member ? checker.getTypeOfSymbolAtLocation(member, where).getCallSignatures()[0]?.getReturnType() : t;
	if (!iterator) return undefined;
	const next = iterator.getProperty('next');
	let result = next && checker.getTypeOfSymbolAtLocation(next, where).getCallSignatures()[0]?.getReturnType();
	if (!result) return undefined;
	if (async) result = checker.getAwaitedType(result) ?? result;
	const parts = result.isUnion() ? result.types : [result];
	const yielded = parts.filter((p) => {
		const done = p.getProperty('done');
		const dt = done && checker.getTypeOfSymbolAtLocation(done, where);
		return !dt || !(dt.flags & ts.TypeFlags.BooleanLiteral) || checker.typeToString(dt) !== 'true';
	});
	const values = yielded
		.map((p) => p.getProperty('value'))
		.filter((v): v is ts.Symbol => !!v)
		.map((v) => checker.getTypeOfSymbolAtLocation(v, where));
	if (!values.length) return undefined;
	return values.length === 1 ? values[0] : (checker as unknown as { getUnionType(types: ts.Type[]): ts.Type }).getUnionType(values);
}
