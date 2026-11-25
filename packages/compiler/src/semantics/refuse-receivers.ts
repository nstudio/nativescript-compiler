// Methods called on, and members read off, a receiver neither backend models: a built-in's method through `.call` or
// `.apply` on a value of another type, a class's prototype read for what the class declares there, a buffer type's
// prototype the runtimes have no object for. Each decision is made here once; both backends throw what it returns.
import ts from 'typescript';
import type { RefusalId } from './refusals.ts';
import { isLibDeclaration, isWriteTarget } from './ast.ts';
import { aliasedPrototypeMember } from './lang.ts';
import { programBase } from './classes.ts';
import { BUFFER_TYPES, TYPED_ARRAYS } from './globals.ts';

export interface ReceiverRefusal {
	id: RefusalId;
	what: string;
	node: ts.Node;
}

/** The primitive whose method each wrapper's prototype holds: the runtimes call it on a receiver that is one. */
const PRIMITIVE_OWNERS: Readonly<Record<string, { flags: ts.TypeFlags; noun: string }>> = {
	String: { flags: ts.TypeFlags.StringLike, noun: 'a string' },
	Number: { flags: ts.TypeFlags.NumberLike, noun: 'a number' },
	Boolean: { flags: ts.TypeFlags.BooleanLike, noun: 'a boolean' },
};

/** The buffer types whose prototype each runtime has an object for (`JSUint8Array.jsPrototype`). */
export const MODELLED_BUFFER_PROTOTYPES: ReadonlySet<string> = new Set(['ArrayBuffer', ...TYPED_ARRAYS]);

const unwrap = (e: ts.Expression): ts.Expression => {
	while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
	return e;
};

const libDeclared = (sym: ts.Symbol | undefined) => !!sym?.declarations?.length && sym.declarations.every(isLibDeclaration);

/**
 * `String.prototype.trim.call(x)`, `Number.prototype.toFixed.apply(x, [2])`, directly or through a const alias: the
 * runtimes call the method of that name on `x` itself, which is the built-in's only where `x` is that primitive. Undefined,
 * null and (for String's) a symbol receiver throw the TypeError JavaScript throws; any other receiver, `any` included, is refused.
 */
export function builtinPrototypeReceiver(e: ts.CallExpression, checker: ts.TypeChecker, library: boolean): ReceiverRefusal | undefined {
	const callee = unwrap(e.expression);
	if (library || !ts.isPropertyAccessExpression(callee) || (callee.name.text !== 'call' && callee.name.text !== 'apply')) return undefined;
	const held = unwrap(callee.expression);
	const method = aliasedPrototypeMember(held, checker) ?? held;
	if (!ts.isPropertyAccessExpression(method) || !ts.isPropertyAccessExpression(method.expression) || method.expression.name.text !== 'prototype') return undefined;
	const owner = method.expression.expression;
	if (!ts.isIdentifier(owner) || !Object.hasOwn(PRIMITIVE_OWNERS, owner.text) || !libDeclared(checker.getSymbolAtLocation(owner))) return undefined;
	const primitive = PRIMITIVE_OWNERS[owner.text];
	const receiver = e.arguments[0];
	if (!receiver || ts.isSpreadElement(receiver)) return undefined;
	const type = checker.getTypeAtLocation(receiver);
	const thrown = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | (owner.text === 'String' ? ts.TypeFlags.ESSymbolLike : 0);
	const runs = (t: ts.Type): boolean => {
		const c = t.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(t) : t;
		return !!c && (!!(c.flags & (primitive.flags | thrown)) || c.getSymbol()?.name === owner.text);
	};
	if ((type.isUnion() ? type.types : [type]).every(runs)) return undefined;
	return { id: 'builtin-receiver', what: `${callee.name.text} of ${owner.text}.prototype.${method.name.text} on a value that is not ${primitive.noun}`, node: e };
}

/**
 * `''.replaceAll.call(x, …)`, `iterator.next.call(other)`: a built-in's method read off a value, called through `.call`,
 * `.apply` or `.bind` with another receiver. A backend holds the method bound to the value it was read from, where
 * JavaScript runs it on the receiver given. Left to their own lowering: the receiver the value itself; `{}.m` and `[].m`
 * (Object's and Array's methods); a library global's (`Math.max.apply(null, xs)`, whose `this` is unused); Function's
 * own (`f.call.call(g)`).
 */
export function builtinMethodReceiver(e: ts.CallExpression, checker: ts.TypeChecker, library: boolean): ReceiverRefusal | undefined {
	const callee = unwrap(e.expression);
	if (library || !ts.isPropertyAccessExpression(callee) || !['call', 'apply', 'bind'].includes(callee.name.text) || !libDeclared(checker.getSymbolAtLocation(callee.name))) return undefined;
	const target = unwrap(callee.expression);
	if (!ts.isPropertyAccessExpression(target)) return undefined;
	const value = unwrap(target.expression);
	if (ts.isPropertyAccessExpression(value) && value.name.text === 'prototype') return undefined;
	if ((ts.isObjectLiteralExpression(value) && !value.properties.length) || (ts.isArrayLiteralExpression(value) && !value.elements.length)) return undefined;
	const member = checker.getSymbolAtLocation(target.name);
	if (!libDeclared(member) || !member!.declarations!.every((d) => ts.isMethodSignature(d) || ts.isMethodDeclaration(d))) return undefined;
	if (member!.declarations!.some((d) => ts.isInterfaceDeclaration(d.parent) && ['Function', 'CallableFunction', 'NewableFunction'].includes(d.parent.name.text))) return undefined;
	let root: ts.Expression = value;
	while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
	if (ts.isIdentifier(root) && libDeclared(checker.getSymbolAtLocation(root))) return undefined;
	const receiver = e.arguments[0];
	const plain = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(x) || ts.isLiteralExpression(x) || (ts.isPropertyAccessExpression(x) && plain(x.expression));
	if (receiver && !ts.isSpreadElement(receiver) && plain(receiver) && receiver.getText() === value.getText()) return undefined;
	return { id: 'builtin-receiver', what: `${callee.name.text} of ${target.getText().replace(/\s+/g, ' ')} with a receiver other than the value it is read from`, node: e };
}

/** The refusal for `.call`, `.apply` or `.bind` of a method with a receiver other than its object. */
export function otherReceiverRefusal(node: ts.Node, method: string): ReceiverRefusal {
	return { id: 'other-receiver', what: `${method} with a receiver other than the method's object`, node };
}

/**
 * `obj.method.call(other, …)`, `const f = obj.method; f.apply(other, …)` of a non-library method: both backends hold a
 * method bound to the object it was read from, where JavaScript runs it on the receiver given. `C.prototype.m.call(…)`
 * and calls whose receiver is the object itself are left to their own lowering.
 */
export function programMethodReceiver(e: ts.CallExpression, checker: ts.TypeChecker, library: boolean): ReceiverRefusal | undefined {
	const callee = unwrap(e.expression);
	if (library || !ts.isPropertyAccessExpression(callee) || !['call', 'apply', 'bind'].includes(callee.name.text) || !libDeclared(checker.getSymbolAtLocation(callee.name))) return undefined;
	const target = unwrap(callee.expression);
	const direct = ts.isPropertyAccessExpression(target) ? target : undefined;
	const init = !direct && ts.isIdentifier(target) ? checker.getSymbolAtLocation(target)?.valueDeclaration : undefined;
	const aliased = init && ts.isVariableDeclaration(init) && init.parent.flags & ts.NodeFlags.Const && init.initializer ? unwrap(init.initializer) : undefined;
	const access = direct ?? (aliased && ts.isPropertyAccessExpression(aliased) ? aliased : undefined);
	if (!access) return undefined;
	const value = unwrap(access.expression);
	if (ts.isPropertyAccessExpression(value) && value.name.text === 'prototype') return undefined;
	const member = checker.getSymbolAtLocation(access.name);
	if (!member || libDeclared(member)) return undefined;
	const decl = member.declarations?.find((d) => ts.isMethodDeclaration(d) && !!d.body) ?? member.valueDeclaration;
	if (!decl || !(ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl))) return undefined;
	const receiver = e.arguments[0];
	const plain = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(x) || ts.isLiteralExpression(x) || (ts.isPropertyAccessExpression(x) && plain(x.expression));
	if (receiver && !ts.isSpreadElement(receiver) && plain(receiver) && receiver.getText() === value.getText()) return undefined;
	return otherReceiverRefusal(e, callee.name.text);
}

/**
 * `DataView.prototype`: a buffer type whose prototype neither runtime has an object for, so nothing read off it, or
 * held, is the built-in's.
 */
export function bufferPrototype(e: ts.PropertyAccessExpression, checker: ts.TypeChecker): ReceiverRefusal | undefined {
	const owner = e.expression;
	if (e.name.text !== 'prototype' || !ts.isIdentifier(owner) || !BUFFER_TYPES.has(owner.text) || MODELLED_BUFFER_PROTOTYPES.has(owner.text) || !libDeclared(checker.getSymbolAtLocation(owner))) return undefined;
	return { id: 'builtin-prototype', what: `${owner.text}.prototype`, node: e };
}

/**
 * `C.prototype.m`, `C.prototype['k']` of a class the program declares, read in an app for a method or accessor the class
 * declares, or for `constructor`: a compiled class keeps those on the class, and its prototype object holds only what
 * script defines there.
 * `C.prototype.m.call(…)`, `.apply` and `.bind` are left to their calls' lowering; a write defines the member.
 */
export function classPrototypeMember(e: ts.PropertyAccessExpression, checker: ts.TypeChecker, library: boolean): ReceiverRefusal | undefined {
	if (library || e.name.text !== 'prototype') return undefined;
	let at: ts.Expression = e;
	while (ts.isParenthesizedExpression(at.parent)) at = at.parent as ts.Expression;
	const read = at.parent;
	if (!(ts.isPropertyAccessExpression(read) || ts.isElementAccessExpression(read)) || read.expression !== at || isWriteTarget(read)) return undefined;
	const sym = checker.getSymbolAtLocation(e.expression);
	const cls = sym && sym.flags & ts.SymbolFlags.Class ? sym.valueDeclaration : undefined;
	if (!cls || !ts.isClassDeclaration(cls) || cls.getSourceFile().isDeclarationFile) return undefined;
	const how = read.parent;
	if (ts.isPropertyAccessExpression(how) && how.expression === read && ['call', 'apply', 'bind'].includes(how.name.text) && ts.isCallExpression(how.parent) && how.parent.expression === how) return undefined;
	const key = ts.isPropertyAccessExpression(read) ? read.name.text : ts.isStringLiteralLike(read.argumentExpression) ? read.argumentExpression.text : ts.isNumericLiteral(read.argumentExpression) ? String(Number(read.argumentExpression.text)) : undefined;
	if (key !== 'constructor' && !declaresOnPrototype(cls, key, checker)) return undefined;
	return { id: 'class-prototype', what: `a class member read off ${cls.name?.text ?? 'a class'}.prototype`, node: read };
}

/** Whether `cls` or a program class it extends declares an instance method or accessor named `key` (any, when `key` is unknown). */
function declaresOnPrototype(cls: ts.ClassLikeDeclaration, key: string | undefined, checker: ts.TypeChecker): boolean {
	for (let c: ts.ClassLikeDeclaration | undefined = cls; c; c = programBase(c, checker)) {
		for (const m of c.members) {
			if (!(ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) || ts.isPrivateIdentifier(m.name) || ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) continue;
			const name = memberKey(m.name);
			if (key === undefined || name === undefined || name === key) return true;
		}
	}
	return false;
}

/** A member name as the property key it defines; undefined for a computed one other than a literal. */
function memberKey(n: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(n)) return n.text;
	if (ts.isStringLiteralLike(n)) return n.text;
	if (ts.isNumericLiteral(n)) return String(Number(n.text));
	if (ts.isComputedPropertyName(n)) {
		const x = n.expression;
		if (ts.isStringLiteralLike(x)) return x.text;
		if (ts.isNumericLiteral(x)) return String(Number(x.text));
	}
	return undefined;
}
