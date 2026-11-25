// The states a value's flow carries into a slot (bit flags), the slots the analysis joins, and the syntax-tree and type
// questions it asks, which read no state of its own.
import ts from 'typescript';
import { definitelyAssignedFields } from '../lang.ts';
import { isTemplateMethod } from '../trust.ts';

export const U = 1,
	N = 2,
	H = 4,
	F = 8;
export const LOGICAL_ASSIGNMENT = new Set([ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);
/** `Form.missing`, carried beside U: whatever keeps or drops U keeps or drops it with it (`withMissing`). */
export const M = 16;
/** `Form.absent`, carried beside U and N: kept by masks that keep either, dropped where both are. */
export const A = 32;
/** `Form.given`, carried as A is. */
export const G = 64;
/** `Form.untyped`, carried beside U as M is. */
export const O = 128;

export type Part = 'element' | 'value' | 'result';

/** A place a value is held. Union-find: only a root's fields beyond `up` are meaningful. */
export class Slot {
	up: Slot = this;
	states = 0;
	/** A declaration file's slot, or one merged with it: its form is its declared type, whatever reaches it. */
	fixed = false;
	/** Strict code's slot: its checker type, its elements' included, is a lower bound on what it holds. */
	typed = false;
	/** Typed by a type parameter: it holds what each instantiation gives, and shares no form with a concrete slot. */
	generic = false;
	/** A generic slot's states less those only an instantiation brings in: what it holds as a `T`. */
	local = 0;
	/** Something tells null from undefined in its value, or in a slot its value flows to. */
	observed = false;
	/** Something tests the type of its value, or of a slot its value flows to. */
	typeObserved = false;
	children = new Map<Part, Slot>();
	readonly type: ts.Type | null;
	/** The declaration it is the slot of, if any. */
	readonly decl: ts.Declaration | null;
	constructor(type: ts.Type | null, decl: ts.Declaration | null = null) {
		this.type = type;
		this.decl = decl;
	}

	give(states: number): void {
		this.states |= states;
		this.local |= states;
	}
}

/** What an expression may give: states of its own, and the slots it reads, each with the states a read keeps. */
export interface Flow {
	states: number;
	from: [Slot, number][];
}

export const PRESENT: Flow = { states: 0, from: [] };

export const ELEMENT_CALLBACKS = new Set(['forEach', 'map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap']);
export const SAME_ELEMENTS = new Set(['filter', 'slice', 'concat', 'reverse', 'sort', 'toSorted', 'toReversed', 'splice', 'flat', 'fill', 'copyWithin', 'values']);
export const ONE_ELEMENT = new Set(['find', 'findLast', 'pop', 'shift', 'at']);
/** Operators that convert their operands to a number or a string, which null and undefined convert to differently. */
export const CONVERTING = new Set([
	ts.SyntaxKind.PlusToken,
	ts.SyntaxKind.MinusToken,
	ts.SyntaxKind.AsteriskToken,
	ts.SyntaxKind.AsteriskAsteriskToken,
	ts.SyntaxKind.SlashToken,
	ts.SyntaxKind.PercentToken,
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.GreaterThanEqualsToken,
	ts.SyntaxKind.AmpersandToken,
	ts.SyntaxKind.BarToken,
	ts.SyntaxKind.CaretToken,
	ts.SyntaxKind.LessThanLessThanToken,
	ts.SyntaxKind.GreaterThanGreaterThanToken,
	ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
	ts.SyntaxKind.PlusEqualsToken,
	ts.SyntaxKind.MinusEqualsToken,
	ts.SyntaxKind.AsteriskEqualsToken,
	ts.SyntaxKind.AsteriskAsteriskEqualsToken,
	ts.SyntaxKind.SlashEqualsToken,
	ts.SyntaxKind.PercentEqualsToken,
	ts.SyntaxKind.AmpersandEqualsToken,
	ts.SyntaxKind.BarEqualsToken,
	ts.SyntaxKind.CaretEqualsToken,
	ts.SyntaxKind.LessThanLessThanEqualsToken,
	ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
	ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);
/** Built-in methods whose arguments from this position on are stored where the flow follows them (an element, a value, a result). */
export const STORES = new Map([
	['push', 0],
	['unshift', 0],
	['splice', 2],
	['add', 0],
	['set', 1],
	['resolve', 0],
]);
export const STORE_OWNERS = new Set(['Array', 'Set', 'Map', 'WeakMap', 'WeakSet', 'PromiseConstructor']);

/** A declaration whose members a value's are. */
export type Owner = ts.ClassLikeDeclaration | ts.InterfaceDeclaration | ts.TypeLiteralNode | ts.ObjectLiteralExpression;

/** A node's source file: none for a node a transform made. */
export function sourceOf(n: ts.Node): ts.SourceFile | undefined {
	return n.getSourceFile() as ts.SourceFile | undefined;
}

/** A signature's parameters as callers give them: a declared `this` is the receiver, not an argument. */
export function valueParameters(sig: ts.SignatureDeclaration): readonly ts.ParameterDeclaration[] {
	const first = sig.parameters[0];
	return first && ts.isIdentifier(first.name) && first.name.text === 'this' ? sig.parameters.slice(1) : sig.parameters;
}

/** A type parameter, alone or with null and undefined. */
export function isGeneric(t: ts.Type | null | undefined): boolean {
	if (!t) return false;
	const parts = (t.isUnion() ? t.types : [t]).filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
	return parts.length > 0 && parts.every((x) => !!(x.flags & ts.TypeFlags.TypeParameter) && !(x as { isThisType?: boolean }).isThisType);
}

/** The interfaces and object literal types a value of type `t` is held as: types whose keys are what a value has. */
export function shapes(checker: ts.TypeChecker, t: ts.Type): ts.Type[] {
	const x = checker.getNonNullableType(t);
	return (x.isUnion() ? x.types : [x]).filter((m) => {
		if (!(m.flags & ts.TypeFlags.Object) || m.isClass() || m.getCallSignatures().length) return false;
		const sym = m.aliasSymbol ?? m.getSymbol();
		return !!sym && !!(sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeLiteral)) && !(sym.flags & ts.SymbolFlags.Class);
	});
}

/** A value of an object type: not a string, number, boolean, bigint, symbol or enum, which a binding holds as a value. */
export function objectValue(t: ts.Type): boolean {
	const parts = (t.isUnion() ? t.types : [t]).filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
	return parts.length > 0 && parts.every((x) => !!(x.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.TypeParameter)) && !x.getCallSignatures().length);
}

/** The replacer function type `String.prototype.replace` and `replaceAll` take. */
export function stringReplacer(sig: ts.SignatureDeclaration): boolean {
	const p = sig.parent,
		m = p?.parent;
	return !!m && ts.isParameter(p) && ts.isMethodSignature(m) && ts.isIdentifier(m.name) && ['replace', 'replaceAll'].includes(m.name.text) && ts.isInterfaceDeclaration(m.parent) && m.parent.name.text === 'String';
}

/** An object used as a dictionary (`Record<string, T>`, `{ [k: string]: T }`): an index signature and no named members. */
export function isRecord(t: ts.Type): boolean {
	return !!(t.flags & ts.TypeFlags.Object) && !!(t.getStringIndexType() ?? t.getNumberIndexType()) && !t.getProperties().length && !t.getCallSignatures().length;
}

export function untyped(t: ts.Type): boolean {
	return !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/** A union of different object types, held untyped where the platform has no class common to them (types.ts `unionType`). */
export function unionOfObjects(t: ts.Type): boolean {
	return t.isUnion() && t.types.filter((x) => !!(x.flags & ts.TypeFlags.Object)).length > 1;
}

/** A parameter of a declared function or member, or a writable field: what a library's callers give. */
export function writtenByCallers(n: ts.Node): boolean {
	if (ts.isParameter(n)) return !ts.isFunctionTypeNode(n.parent) && !ts.isConstructorTypeNode(n.parent);
	return (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) && isPublic(n) && !isReadonly(n);
}

/** A member a library's callers can reach: neither private nor protected. */
export function isPublic(m: ts.Node): boolean {
	const name = (m as ts.NamedDeclaration).name;
	return !(name && ts.isPrivateIdentifier(name)) && !(ts.getCombinedModifierFlags(m as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
}

export function isReadonly(m: ts.Node): boolean {
	return !!(ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Readonly);
}

export function declarationFile(n: ts.Node): boolean {
	return !!sourceOf(n)?.isDeclarationFile;
}

export function merge(a: Flow, b: Flow): Flow {
	return { states: a.states | b.states, from: [...a.from, ...b.from] };
}

/** States with M and O wherever they have U: a mask or an admitted set that names undefined names a missing one too. */
export function withMissing(s: number): number {
	return s & U ? s | M | O : s;
}

/** An admitted set with A wherever it admits U or N: an absent value is one of those. */
export function withAbsent(s: number): number {
	return withMissing(s) | (s & (U | N) ? A | G : 0);
}

/** A set of states to drop with A where it drops both U and N: nothing empty is left to be absent. */
export function dropsAbsent(s: number): number {
	return (s & (U | N)) === (U | N) ? s | A | G : s;
}

export function mask(f: Flow, keep: number): Flow {
	return { states: f.states & keep, from: f.from.map(([s, k]): [Slot, number] => [s, k & keep]) };
}

export function typeStates(t: ts.Type | undefined): number {
	if (!t) return 0;
	let s = 0;
	for (const x of t.isUnion() ? t.types : [t]) {
		if (x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) s |= F | U | N;
		else if (x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) s |= U;
		else if (x.flags & ts.TypeFlags.Null) s |= N;
	}
	return s;
}

/** What a type as written says, which the checker drops in code checked without strictNullChecks. */
export function typeNodeStates(n: ts.TypeNode | undefined): number {
	if (!n) return 0;
	if (ts.isParenthesizedTypeNode(n)) return typeNodeStates(n.type);
	if (ts.isUnionTypeNode(n)) return n.types.reduce((s, x) => s | typeNodeStates(x), 0);
	if (n.kind === ts.SyntaxKind.AnyKeyword || n.kind === ts.SyntaxKind.UnknownKeyword) return F | U | N;
	if (n.kind === ts.SyntaxKind.UndefinedKeyword || n.kind === ts.SyntaxKind.VoidKeyword) return U;
	if (ts.isLiteralTypeNode(n) && n.literal.kind === ts.SyntaxKind.NullKeyword) return N;
	return 0;
}

export function elementType(checker: ts.TypeChecker, t: ts.Type, part: Part): ts.Type | null {
	const x = checker.getNonNullableType(t);
	if (part === 'result') return checker.getAwaitedType(x) ?? null;
	if (checker.isArrayType(x) || checker.isTupleType(x)) return checker.getIndexTypeOfType(x, ts.IndexKind.Number) ?? checker.getTypeArguments(x as ts.TypeReference)[0] ?? null;
	const args = (x as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(x as ts.TypeReference) : [];
	const name = x.getSymbol()?.name;
	if (name === 'Set' || name === 'ReadonlySet') return args[0] ?? null;
	if (name === 'Map' || name === 'ReadonlyMap') return args[1] ?? null;
	return checker.getIndexInfosOfType(x)[0]?.type ?? null;
}

/** A template method's loop parameter, whose default only types it: the template's glue always gives it. */
export function isTemplateDefault(d: ts.Declaration): boolean {
	return ts.isParameter(d) && !!d.initializer && isTemplateMethod(d.parent);
}

export function isAsync(fn: ts.SignatureDeclaration): boolean {
	return !!ts.getModifiers(fn as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

export function hasStatic(m: ts.Node): boolean {
	return ts.canHaveModifiers(m) && !!ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
}

export function isConstAssertion(e: ts.AsExpression | ts.TypeAssertion): boolean {
	return ts.isTypeReferenceNode(e.type) && ts.isIdentifier(e.type.typeName) && e.type.typeName.text === 'const';
}

export function isCalleeOrName(e: ts.Expression): boolean {
	let x: ts.Node = e;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	return ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === x) || (ts.isPropertyAccessExpression(p) && p.expression === x) || ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === x);
}

export function isMatchArray(t: ts.Type): boolean {
	const name = t.getSymbol()?.name ?? t.aliasSymbol?.name;
	return name === 'RegExpMatchArray' || name === 'RegExpExecArray';
}

/** `match.groups` of a regexp's result: a group that took no part in the match reads undefined. */
export function isGroupsRead(recv: ts.Expression, checker: ts.TypeChecker): boolean {
	const x = ts.skipOuterExpressions(recv);
	return ts.isPropertyAccessExpression(x) && x.name.text === 'groups' && isMatchArray(checker.getNonNullableType(checker.getTypeAtLocation(x.expression)));
}

const assigned = new WeakMap<ts.ClassLikeDeclaration, Set<ts.PropertyDeclaration>>();
export function definitelyAssigned(cls: ts.ClassLikeDeclaration): Set<ts.PropertyDeclaration> {
	let s = assigned.get(cls);
	if (!s) assigned.set(cls, (s = definitelyAssignedFields(cls)));
	return s;
}

/**
 * Code checked without strictNullChecks, where the checker narrows nothing: the states a guard around a read rules out
 * (`if (x)`, `x && x.y`, `x != null ? … : …`, an earlier `if (!x) return`). A `const` declared outside a function keeps
 * the value its guards around that function prove.
 */
export function guarded(e: ts.Expression, d?: ts.Declaration): number {
	if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e) && !(ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))) return 0;
	const text = e.getText();
	const fixed = ts.isIdentifier(e) && !!d && ts.isVariableDeclaration(d) && !!(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) && d.getSourceFile() === e.getSourceFile();
	const outside = (fn: ts.Node) => fixed && (d!.pos < fn.pos || d!.end > fn.end);
	let out = 0;
	for (let x: ts.Node = e; x.parent && (!ts.isFunctionLike(x) || outside(x)) && !ts.isSourceFile(x); x = x.parent) {
		const p = x.parent;
		if (ts.isIfStatement(p)) out |= p.thenStatement === x ? proves(p.expression, text, true) : p.elseStatement === x ? proves(p.expression, text, false) : 0;
		else if (ts.isConditionalExpression(p)) out |= p.whenTrue === x ? proves(p.condition, text, true) : p.whenFalse === x ? proves(p.condition, text, false) : 0;
		else if (ts.isBinaryExpression(p) && p.right === x) out |= p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? proves(p.left, text, true) : p.operatorToken.kind === ts.SyntaxKind.BarBarToken ? proves(p.left, text, false) : 0;
		else if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p)) {
			for (const st of p.statements) {
				if (st === x) break;
				if (ts.isIfStatement(st) && !st.elseStatement && exits(st.thenStatement)) out |= proves(st.expression, text, false);
			}
		}
		if ((out & (U | N)) === (U | N)) break;
	}
	return out;
}

function exits(st: ts.Statement): boolean {
	if (ts.isBlock(st)) return st.statements.length > 0 && exits(st.statements[st.statements.length - 1]);
	return ts.isReturnStatement(st) || ts.isThrowStatement(st) || ts.isContinueStatement(st) || ts.isBreakStatement(st);
}

/** The states of `text` that `cond` being `truth` rules out. */
function proves(cond: ts.Expression, text: string, truth: boolean): number {
	const c = ts.skipOuterExpressions(cond);
	const K = ts.SyntaxKind;
	if (ts.isPrefixUnaryExpression(c) && c.operator === K.ExclamationToken) return proves(c.operand, text, !truth);
	if (ts.isBinaryExpression(c)) {
		const op = c.operatorToken.kind;
		if (op === K.AmpersandAmpersandToken) return truth ? proves(c.left, text, true) | proves(c.right, text, true) : 0;
		if (op === K.BarBarToken) return truth ? 0 : proves(c.left, text, false) | proves(c.right, text, false);
		const [mine, other] = ts.skipOuterExpressions(c.left).getText() === text ? [c.left, c.right] : ts.skipOuterExpressions(c.right).getText() === text ? [c.right, c.left] : [null, null];
		// `x?.y === 'a'` true proves `x` present.
		const member = (s: ts.Expression) => {
			const t = ts.skipOuterExpressions(s);
			return ts.isPropertyAccessExpression(t) && (t.getText().startsWith(text + '.') || t.getText().startsWith(text + '?.'));
		};
		const lit = (s: ts.Expression) => {
			const t = ts.skipOuterExpressions(s);
			return ts.isStringLiteral(t) || ts.isNumericLiteral(t) || ts.isNoSubstitutionTemplateLiteral(t) || t.kind === K.TrueKeyword || t.kind === K.FalseKeyword;
		};
		if (truth && op === K.EqualsEqualsEqualsToken && ((member(c.left) && lit(c.right)) || (member(c.right) && lit(c.left)))) return U | N;
		if (mine && other) {
			const o = ts.skipOuterExpressions(other);
			const isNull = o.kind === K.NullKeyword,
				isUndefined = ts.isIdentifier(o) && o.text === 'undefined';
			const negated = op === K.ExclamationEqualsToken || op === K.ExclamationEqualsEqualsToken;
			const loose = op === K.ExclamationEqualsToken || op === K.EqualsEqualsToken;
			if ((isNull || isUndefined) && (negated ? truth : !truth)) return loose ? U | N : isNull ? N : U;
			if (!isNull && !isUndefined && !negated && truth && op === K.EqualsEqualsEqualsToken && (ts.isLiteralExpression(o) || o.kind === K.TrueKeyword || o.kind === K.FalseKeyword)) return U | N;
		}
		if (op === K.InstanceOfKeyword && truth && ts.skipOuterExpressions(c.left).getText() === text) return U | N;
		if (ts.isTypeOfExpression(ts.skipOuterExpressions(c.left)) && ts.skipOuterExpressions((ts.skipOuterExpressions(c.left) as ts.TypeOfExpression).expression).getText() === text && ts.isStringLiteral(c.right) && c.right.text !== 'undefined' && c.right.text !== 'object' && (op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken) && truth) return U | N;
		return 0;
	}
	if (truth && (ts.isIdentifier(c) || ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)) && c.getText() === text) return U | N;
	// `x.y` true proves `x` present.
	if (truth && ts.isPropertyAccessExpression(c) && c.getText().startsWith(text + '.')) return U | N;
	return 0;
}
