// Constructs neither backend runs as JavaScript does, refused alike by both: each decision gives the refusal, or undefined.
import ts from 'typescript';
import { declaresThis, isLibDeclaration } from './ast.ts';
import { thisArgBound } from './lang.ts';
import type { RefusalId } from './refusals.ts';

export interface ScopeRefusal {
	readonly id: RefusalId;
	readonly what: string;
	readonly node: ts.Node;
}

interface ScopeFront {
	readonly checker: ts.TypeChecker;
	readonly library: unknown;
	readsArguments(fn: ts.SignatureDeclaration): boolean;
}

/** The function whose own `this` a `this` is: the nearest enclosing function that is not an arrow function. */
function thisOwner(e: ts.Node): ts.Node | undefined {
	return ts.findAncestor(e.parent, (n) => ts.isFunctionLike(n) && !ts.isArrowFunction(n));
}

/**
 * `this` in a function declaration that reads its `arguments` too: the function then takes its arguments as one list,
 * which leaves no parameter for the receiver its calls give it.
 */
export function functionThis(e: ts.Node, front: ScopeFront): ScopeRefusal | undefined {
	if (front.library || e.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
	const owner = thisOwner(e);
	if (!owner || !ts.isFunctionDeclaration(owner) || !owner.body || declaresThis(owner) || !front.readsArguments(owner)) return undefined;
	return { id: 'function-this', what: '`this` in a function that also reads `arguments`', node: e };
}

/**
 * `this` in a function expression outside any class, stored in a typed function slot of an object
 * (`promise.then = function () { this… }`): JavaScript gives it the receiver of each call, which the typed closure does
 * not take. Asked only where the backend binds no receiver itself (a method value, a literal's method, a declared `this`).
 */
export function storedFunctionThis(e: ts.Node, front: Pick<ScopeFront, 'checker' | 'library'>): ScopeRefusal | undefined {
	if (front.library || e.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
	const owner = thisOwner(e);
	if (!owner || !ts.isFunctionExpression(owner) || declaresThis(owner) || ts.findAncestor(owner, ts.isClassLike)) return undefined;
	let at: ts.Node = owner.parent;
	while (ts.isParenthesizedExpression(at)) at = at.parent;
	if (ts.isPropertyAssignment(at) || thisArgBound(owner, front.checker)) return undefined;
	// Stored untyped, the function is a method value, which takes its receiver.
	const contextual = front.checker.getContextualType(owner)?.getCallSignatures()[0]?.getDeclaration();
	if (!contextual || ts.isJSDocSignature(contextual) || declaresThis(contextual)) return undefined;
	if (front.checker.getTypeAtLocation(e).flags & ts.TypeFlags.Any) return undefined;
	return { id: 'function-this', what: '`this` in a function expression stored on an object', node: e };
}

/**
 * `Object.defineProperty(array, index, { get… })` on a value typed as an array: an array holds its elements as values,
 * never as accessors. An index given as a string or number literal; `length` is left to the runtime, which throws
 * TypeError as JavaScript does.
 */
export function elementAccessor(e: ts.CallExpression, front: Pick<ScopeFront, 'checker' | 'library'>): ScopeRefusal | undefined {
	if (front.library || !ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== 'defineProperty') return undefined;
	if (!isLibDeclaration(front.checker.getResolvedSignature(e)?.getDeclaration())) return undefined;
	const [target, key, descriptor] = e.arguments;
	if (!target || !key || !descriptor || ![target, key, descriptor].every((a) => !ts.isSpreadElement(a))) return undefined;
	const t = front.checker.getNonNullableType(front.checker.getTypeAtLocation(target));
	if (!front.checker.isArrayType(t) && !front.checker.isTupleType(t)) return undefined;
	const k = ts.skipOuterExpressions(key);
	const text = ts.isNumericLiteral(k) ? String(Number(k.text)) : ts.isStringLiteralLike(k) ? k.text : null;
	const index = text === null ? NaN : Number(text);
	if (text === null || String(index) !== text || !Number.isInteger(index) || index < 0 || index >= 2 ** 32 - 1) return undefined;
	const d = ts.skipOuterExpressions(descriptor);
	if (!ts.isObjectLiteralExpression(d)) return undefined;
	const accessor = d.properties.some((p) => !ts.isSpreadAssignment(p) && !!p.name && !ts.isComputedPropertyName(p.name) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && (p.name.text === 'get' || p.name.text === 'set'));
	return accessor ? { id: 'element-accessor', what: 'a getter or setter defined on an array element', node: e } : undefined;
}

/**
 * The receiver of a private member (`o.#x`, `o.#m()`, `o.#x = v`) typed as any value: the member is the class's, found
 * only through a receiver typed as the class, so an object that is not one (JavaScript's TypeError) cannot be told apart.
 */
export function untypedPrivateReceiver(e: ts.Node, front: Pick<ScopeFront, 'checker' | 'library'>): ScopeRefusal | undefined {
	if (front.library || !ts.isPropertyAccessExpression(e.parent) || e.parent.expression !== e || !ts.isPrivateIdentifier(e.parent.name)) return undefined;
	if (!(front.checker.getTypeAtLocation(e).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return undefined;
	return { id: 'private-receiver', what: `\`${e.parent.name.text}\` of a value not typed as its class`, node: e.parent };
}
