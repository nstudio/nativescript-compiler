// Whether an initializer of a module variable, a namespace's or a class's static field may run where the platform
// initializes it (Swift's lazy globals and statics, a Kotlin file's or companion's load) instead of where JavaScript
// evaluates it: it gives the same value whenever it runs, reading nothing that can change except constants.
import ts from 'typescript';
import { convertsUntyped, conversionCall } from './apis/operators.ts';
import { hasModifier, isLibDeclaration } from './ast.ts';
import { isLibGlobal } from './globals.ts';
import { isStatic } from './throws.ts';
import type { Ledger } from './ledger.ts';

/** The library globals' members that are constants (`Math.PI`, `Symbol.iterator`). */
export const LIBRARY_CONSTANTS: ReadonlySet<string> = new Set(['Math.PI', 'Math.E', 'Math.LN2', 'Math.LN10', 'Math.LOG2E', 'Math.LOG10E', 'Math.SQRT2', 'Math.SQRT1_2', 'Number.MAX_SAFE_INTEGER', 'Number.MIN_SAFE_INTEGER', 'Number.EPSILON', 'Number.MAX_VALUE', 'Number.MIN_VALUE', 'Number.POSITIVE_INFINITY', 'Number.NEGATIVE_INFINITY', 'Number.NaN', 'Symbol.iterator', 'Symbol.asyncIterator', 'Symbol.toPrimitive', 'Symbol.toStringTag', 'Symbol.hasInstance', 'Symbol.dispose', 'Symbol.asyncDispose', 'Object.prototype']);

export interface ConstantHost {
	readonly checker: ts.TypeChecker;
	readonly ledger: Ledger;
	resolve(n: ts.Node): ts.Symbol | undefined;
	isAny(n: ts.Node): boolean;
	conversionThrows(n: ts.Node): boolean;
	readonly framework: { pure(name: string): boolean };
}

/** Whether `e` gives the same value whenever it runs: pure, and reading nothing that can change but constants. */
export function constantInitializer(h: ConstantHost, e: ts.Expression, seen = new Set<ts.Node>()): boolean {
	const wide = h.ledger.lazyConstants;
	const c = (x: ts.Expression) => constantInitializer(h, x, seen);
	// An untyped value read as a type the backend holds (its declaration's, or asserted) is checked there, which may
	// throw: it runs where the program runs it.
	const untyped = (n: ts.Node) => !!(h.checker.getTypeAtLocation(n).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	const typed = (n: ts.Node) => !untyped(n) && !h.isAny(n);
	const untypedIntoTyped = (x: ts.Expression, contextual = h.checker.getContextualType(x)): boolean => !!contextual && untyped(x) && !(contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	const slot = e.parent;
	if (slot && (ts.isVariableDeclaration(slot) || ts.isPropertyDeclaration(slot)) && slot.initializer === e && !!slot.type && untyped(e) && typed(slot.name)) return false;
	if ((ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) && untyped(e.expression) && typed(e)) return false;
	if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return c(e.expression);
	if (ts.isLiteralExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return wide || !ts.isRegularExpressionLiteral(e);
	if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
	if (ts.isIdentifier(e)) return constantName(h, e, seen);
	// A conversion that can throw (a BigInt beside a number, an object's own toString) runs where the program runs it.
	const lib = (x: ts.CallExpression) => conversionCall(x, h.checker);
	if (convertsUntyped(e, (x) => h.conversionThrows(x), lib) || (ts.isTemplateExpression(e) && e.templateSpans.some((x) => convertsUntyped(x, (y) => h.conversionThrows(y), lib)))) return false;
	if (ts.isTemplateExpression(e)) return e.templateSpans.every((x) => c(x.expression));
	if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => (ts.isSpreadElement(x) ? ts.isArrayLiteralExpression(x.expression) && !untyped(x.expression) && c(x.expression) : !untypedIntoTyped(x) && c(x)));
	if (ts.isObjectLiteralExpression(e)) {
		const objCtx = h.checker.getContextualType(e);
		return e.properties.every((p) => {
			if (ts.isPropertyAssignment(p)) return !untypedIntoTyped(p.initializer) && c(p.initializer) && (!ts.isComputedPropertyName(p.name) || c(p.name.expression));
			if (ts.isShorthandPropertyAssignment(p)) {
				const propSym = objCtx?.getProperty(p.name.text);
				const propCtx = propSym ? h.checker.getTypeOfSymbolAtLocation(propSym, p) : undefined;
				return !untypedIntoTyped(p.name, propCtx) && constantName(h, p.name, seen);
			}
			return ts.isMethodDeclaration(p);
		});
	}
	if (ts.isPrefixUnaryExpression(e)) return e.operator !== ts.SyntaxKind.PlusPlusToken && e.operator !== ts.SyntaxKind.MinusMinusToken && c(e.operand);
	if (ts.isBinaryExpression(e)) return e.operatorToken.kind !== ts.SyntaxKind.EqualsToken && c(e.left) && c(e.right);
	if (ts.isPropertyAccessExpression(e)) {
		const sym = h.resolve(e.name);
		const d = sym?.valueDeclaration;
		if (sym && sym.flags & ts.SymbolFlags.EnumMember) return true;
		if (d && (ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d) || ts.isEnumDeclaration(d) || ts.isModuleDeclaration(d))) return c(e.expression);
		if (wide) {
			if (d && isLibDeclaration(d) && ts.isIdentifier(e.expression) && isLibGlobal(h, e.expression)) return true;
		} else if (ts.isIdentifier(e.expression) && isLibGlobal(h, e.expression)) return LIBRARY_CONSTANTS.has(`${e.expression.text}.${e.name.text}`);
		if (d && ts.isPropertyDeclaration(d) && isStatic(d) && hasModifier(d, ts.SyntaxKind.ReadonlyKeyword) && !!d.initializer && !seen.has(d)) {
			seen.add(d);
			return c(d.initializer);
		}
		if (wide && d && ts.isVariableDeclaration(d) && ts.isModuleBlock(d.parent.parent.parent) && d.parent.flags & ts.NodeFlags.Const && !!d.initializer && !seen.has(d)) {
			seen.add(d);
			return c(d.initializer);
		}
		return false;
	}
	if (wide && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && h.framework.pure(e.expression.text) && !!h.resolve(e.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return e.arguments.every(c);
	if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && ['Map', 'Set'].includes(e.expression.text)) return !e.arguments?.length || (!h.isAny(e.arguments[0]) && !e.arguments.some((a) => untyped(a)) && e.arguments.every(c));
	return false;
}

/** A name whose value never changes: a function, class, enum or namespace, a library global, or a constant of a constant initializer. */
function constantName(h: ConstantHost, id: ts.Identifier, seen: Set<ts.Node>): boolean {
	if (id.text === 'undefined' || id.text === 'NaN' || id.text === 'Infinity') return true;
	const shorthand = !h.ledger.lazyConstants && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id;
	const sym = shorthand ? h.checker.getShorthandAssignmentValueSymbol(id.parent as ts.ShorthandPropertyAssignment) : h.resolve(id);
	if (!sym) return false;
	if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.ValueModule)) return true;
	const d = sym.valueDeclaration;
	if (!d) return false;
	if (d.getSourceFile().isDeclarationFile) return isLibDeclaration(d) || !(sym.flags & ts.SymbolFlags.Variable) || !!(d.parent && d.parent.flags & ts.NodeFlags.Const);
	if (ts.isVariableDeclaration(d) && d.parent.flags & ts.NodeFlags.Const && d.initializer && !seen.has(d)) {
		seen.add(d);
		return constantInitializer(h, d.initializer, seen);
	}
	return false;
}
