// Reads and writes, compound operators, and the built-in prototypes a program reaches through an alias.
import ts from 'typescript';
import { isLibDeclaration } from '../ast.ts';
import type { StateBackend } from '../states/value-states.ts';
import { statementLevel } from './fields.ts';

/**
 * A compound (`+=` …), logical (`??=`, `||=`, `&&=`) or update (`++`, `--`) assignment to a member: JavaScript evaluates
 * the target's object and key once, reads the member, and writes it (a logical one only when it assigns). `held` is the
 * parts a second evaluation could be seen by (a call, a getter, an untyped read), object first, which each translation
 * evaluates once into a temporary; `value`, whether the assignment's value is used; `stored`, whether the target is a
 * plain stored member of a typed object with no held parts, which reading back or writing unchanged runs nothing for.
 */
export interface ReadWrite {
	target: ts.PropertyAccessExpression | ts.ElementAccessExpression;
	held: ts.Expression[];
	value: boolean;
	stored: boolean;
}

export function readWrite(e: ts.Expression, checker: ts.TypeChecker): ReadWrite | null {
	const K = ts.SyntaxKind;
	let target: ts.Expression;
	if (ts.isBinaryExpression(e) && e.operatorToken.kind >= K.FirstCompoundAssignment && e.operatorToken.kind <= K.LastCompoundAssignment) target = e.left;
	else if ((ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) && (e.operator === K.PlusPlusToken || e.operator === K.MinusMinusToken)) target = e.operand;
	else return null;
	while (ts.isParenthesizedExpression(target)) target = target.expression;
	if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return null;
	const held: ts.Expression[] = [];
	if (!stableRead(target.expression, checker)) held.push(target.expression);
	if (ts.isElementAccessExpression(target) && !stableRead(target.argumentExpression, checker)) held.push(target.argumentExpression);
	return { target, held, value: !statementLevel(e), stored: stableRead(target, checker) };
}

/** Whether evaluating an expression again gives the same value and runs nothing that could be seen. */
function stableRead(x: ts.Expression, checker: ts.TypeChecker): boolean {
	const K = ts.SyntaxKind;
	x = ts.skipOuterExpressions(x);
	if ([K.Identifier, K.ThisKeyword, K.SuperKeyword, K.StringLiteral, K.NumericLiteral, K.BigIntLiteral, K.NoSubstitutionTemplateLiteral, K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(x.kind)) return true;
	if (ts.isPrefixUnaryExpression(x) && x.operator === K.MinusToken) return ts.isNumericLiteral(x.operand);
	const untyped = (r: ts.Expression) => !!(checker.getTypeAtLocation(r).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	if (ts.isPropertyAccessExpression(x)) {
		const sym = checker.getSymbolAtLocation(x.name);
		return !!sym && !(sym.flags & ts.SymbolFlags.Accessor) && !untyped(x.expression) && stableRead(x.expression, checker);
	}
	if (ts.isElementAccessExpression(x)) return !untyped(x.expression) && stableRead(x.expression, checker) && stableRead(x.argumentExpression, checker);
	return false;
}

/** The operator of the operation a compound assignment makes (`+` of `+=`). */
export function compoundOperator(op: ts.SyntaxKind): ts.BinaryOperator {
	const K = ts.SyntaxKind;
	const map: Partial<Record<ts.SyntaxKind, ts.BinaryOperator>> = {
		[K.PlusEqualsToken]: K.PlusToken,
		[K.MinusEqualsToken]: K.MinusToken,
		[K.AsteriskEqualsToken]: K.AsteriskToken,
		[K.SlashEqualsToken]: K.SlashToken,
		[K.PercentEqualsToken]: K.PercentToken,
		[K.AsteriskAsteriskEqualsToken]: K.AsteriskAsteriskToken,
		[K.AmpersandEqualsToken]: K.AmpersandToken,
		[K.BarEqualsToken]: K.BarToken,
		[K.CaretEqualsToken]: K.CaretToken,
		[K.LessThanLessThanEqualsToken]: K.LessThanLessThanToken,
		[K.GreaterThanGreaterThanEqualsToken]: K.GreaterThanGreaterThanToken,
		[K.GreaterThanGreaterThanGreaterThanEqualsToken]: K.GreaterThanGreaterThanGreaterThanToken,
	};
	return map[op]!;
}

/** `a op= b` read as `a op b`: the same node apart from its operator, for a translator's binary expression. */
export function asOperation(e: ts.BinaryExpression): ts.BinaryExpression {
	return Object.assign(Object.create(e) as ts.BinaryExpression, { operatorToken: { kind: compoundOperator(e.operatorToken.kind) } });
}

/** `left = right` in place of `e`, for a translator's assignment of a value it computed (`right`, held by its subst). */
export function assignmentOf(e: ts.Expression, left: ts.Expression, right: ts.Expression): ts.BinaryExpression {
	return Object.assign(Object.create(e) as ts.BinaryExpression, { kind: ts.SyntaxKind.BinaryExpression, operatorToken: { kind: ts.SyntaxKind.EqualsToken }, left, right });
}

const ALIASED_PROTOTYPES = ['Array', 'String', 'Number', 'Boolean'];
type PrototypeAlias = { member: ts.PropertyAccessExpression; refused?: { at: ts.Node; message: string } };
const prototypeAliases = new WeakMap<ts.VariableDeclaration, PrototypeAlias | null>();

/**
 * Whether `e` is the global `Proxy` or starts from it (`new Proxy(…)`, `Proxy.revocable(…)`, `Proxy` held as a value):
 * a compiled release has no engine to run traps, so every such use is refused. A program's own `Proxy` is not it.
 */
export function globalProxyUse(e: ts.Expression, checker: ts.TypeChecker): boolean {
	let x: ts.Expression = e;
	while (ts.isNewExpression(x) || ts.isCallExpression(x) || ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) || ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
	if (!ts.isIdentifier(x) || x.text !== 'Proxy') return false;
	const decls = checker.getSymbolAtLocation(x)?.declarations ?? [];
	return decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * A variable initialized to a built-in's prototype method (`const slice = Array.prototype.slice`), as the library declares
 * the built-in. It is a compile-time alias, declaring nothing, when it is a `const` whose every use is the receiver of
 * `.call` or `.apply`: each call is the `Array.prototype.slice.call(…)` it names. Any other holding or use is `refused`.
 */
export function builtinPrototypeAlias(d: ts.VariableDeclaration, checker: ts.TypeChecker): PrototypeAlias | null {
	if (prototypeAliases.has(d)) return prototypeAliases.get(d)!;
	let found: PrototypeAlias | null = null;
	const init = d.initializer;
	const owner = init && ts.isPropertyAccessExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'prototype' ? init.expression.expression : undefined;
	if (ts.isIdentifier(d.name) && owner && ts.isIdentifier(owner) && ALIASED_PROTOTYPES.includes(owner.text) && checker.getSymbolAtLocation(owner)?.declarations?.every((x) => x.getSourceFile().isDeclarationFile)) {
		const member = init as ts.PropertyAccessExpression;
		const held = d.name;
		const kind = d.parent.flags & ts.NodeFlags.Const ? '' : d.parent.flags & ts.NodeFlags.Let ? 'the let ' : 'the var ';
		const refuse = (at: ts.Node, use: string) => ({ at, message: `${member.getText()} held in ${kind}\`${held.text}\`${use && `, ${use}`} (held in a const, a built-in's prototype method may only be the receiver of .call or .apply)` });
		const sym = checker.getSymbolAtLocation(held);
		let refused = kind ? refuse(d, '') : ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Export ? refuse(d, 'exported') : undefined;
		const visit = (n: ts.Node): void => {
			if (refused) return;
			if (ts.isIdentifier(n) && n !== held && n.text === held.text && (ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : ts.isExportSpecifier(n.parent) ? checker.getExportSpecifierLocalTargetSymbol(n.parent) : checker.getSymbolAtLocation(n)) === sym) {
				let at: ts.Node = n;
				while (ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isAsExpression(at.parent)) at = at.parent;
				const p = at.parent;
				const how = ts.isPropertyAccessExpression(p) && p.expression === at ? p.name.text : undefined;
				if ((how === 'call' || how === 'apply') && ts.isCallExpression(p.parent) && p.parent.expression === p) return;
				refused = refuse(n, how === 'bind' ? 'bound' : how ? `read for .${how}` : ts.isCallExpression(p) && p.expression === at ? 'called bare' : ts.isExportSpecifier(p) || ts.isExportAssignment(p) ? 'exported' : ts.isCallExpression(p) || ts.isNewExpression(p) ? 'passed as an argument' : 'used as a value');
				return;
			}
			ts.forEachChild(n, visit);
		};
		visit(d.getSourceFile());
		found = { member, refused };
	}
	prototypeAliases.set(d, found);
	return found;
}

/** `slice` of `const slice = Array.prototype.slice` that is a compile-time alias: the `Array.prototype.slice` it names. */
export function aliasedPrototypeMember(e: ts.Expression, checker: ts.TypeChecker): ts.PropertyAccessExpression | null {
	while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
	const d = ts.isIdentifier(e) ? checker.getSymbolAtLocation(e)?.valueDeclaration : undefined;
	const alias = d && ts.isVariableDeclaration(d) ? builtinPrototypeAlias(d, checker) : null;
	return alias && !alias.refused ? alias.member : null;
}

/**
 * A package's abstract class whose members are all abstract (an injection token: ngrx's `abstract class ReducerObservable
 * extends Observable`) types its values as its base class: TypeScript lets any object of that base through, which a
 * native class's subclass would refuse.
 */
export function tokenClassBase(t: ts.Type, checker: ts.TypeChecker, pluginFiles: ReadonlySet<string>): ts.ClassLikeDeclaration | undefined {
	const sym = t.getSymbol();
	const decl = sym && sym.flags & ts.SymbolFlags.Class && !t.getConstructSignatures().length ? sym.declarations?.find(ts.isClassDeclaration) : undefined;
	const isAbstract = (n: ts.Node) => !!ts.getModifiers(n as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);
	if (!decl || !pluginFiles.has(decl.getSourceFile().fileName) || !isAbstract(decl) || !decl.members.every(isAbstract)) return undefined;
	const h = decl.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
	const base = h && checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
	return base && ts.isClassLike(base) && !base.getSourceFile().isDeclarationFile && base.name ? base : undefined;
}

/** The `arguments` of the function around, not a variable of that name. */
export function isArguments(e: ts.Node, checker: ts.TypeChecker): boolean {
	if (!ts.isIdentifier(e) || e.text !== 'arguments') return false;
	const sym = checker.getSymbolAtLocation(e);
	return !!sym && !sym.declarations?.length;
}

/** A literal, `true`, `false`, or a prefix operator on a number literal. */
export function isConstant(e: ts.Expression): boolean {
	return ts.isLiteralExpression(e) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(e.kind) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand));
}

/** `this` as the class being translated, not a value a function rebinds it to (`subst`, the translator's substitutions). */
export function isSelf(e: ts.Expression, subst: ReadonlyMap<ts.Node, unknown>): boolean {
	return e.kind === ts.SyntaxKind.ThisKeyword && !subst.has(e);
}

/** `x.hasOwnProperty`, `x.toString`: a method every object inherits, read on the object itself. */
export function objectMethod(b: Pick<StateBackend, 'resolve'>, e: ts.Node): boolean {
	return ts.isPropertyAccessExpression(e) && !!b.resolve(e.name)?.declarations?.every((d) => isLibDeclaration(d));
}

/** A method an object literal declares: its shape holds the function in a field, read and written as any field is. */
export function literalMethod(d: ts.Declaration): boolean {
	return ts.isMethodDeclaration(d) && ts.isObjectLiteralExpression(d.parent);
}

/** `const slice = Array.prototype.slice` held only for `slice.call(…)`/`slice.apply(…)`, which are the direct calls: nothing to declare. */
export function prototypeAlias(b: Pick<StateBackend, 'checker' | 'error'>, d: ts.VariableDeclaration): boolean {
	const alias = builtinPrototypeAlias(d, b.checker);
	if (alias?.refused) throw b.error(alias.refused.at, alias.refused.message);
	return !!alias;
}

/** Whether a function expression reading `this` is held as a method value: in library mode and in a plugin's code, which is not strict. */
export function methodValues(b: Pick<StateBackend, 'library' | 'pluginFiles'>, n: ts.Node): boolean {
	return !!b.library || b.pluginFiles.has(ts.getOriginalNode(n).getSourceFile()?.fileName ?? '');
}
