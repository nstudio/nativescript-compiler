// Code checked without strictNullChecks: its async functions and the empty values their defaults and results give.
import ts from 'typescript';
import type { ValueStates } from './value-states.ts';
import { emptyInto } from '../conversion.ts';
import { sameType } from '../types.ts';
import { isAsync, isStatic } from '../throws.ts';
import { isPromiseNew, isPromiseResolve, resolvedGiven, returnsEmptyLiteral } from './predicates.ts';
import { assignedBefore, givenBy, nothingGiven, onlyNullOrPresent } from '../nullish.ts';
import { isWriteTarget } from '../ast.ts';

const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike;

/** A string, number or boolean type (a union of them included), not `any`. */
const primitiveType = (t: ts.Type): boolean => !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && (t.isUnion() ? t.types : [t]).every((x) => !!(x.flags & PRIMITIVE));

export const lenientMethods = {
	/**
	 * A non-strict app's async function (or method of its own signature) whose body may give null or undefined where its
	 * promise's type says a value, or a function returning a promise it resolves so (`resolvedGiven`): the promise is of
	 * the optional. Its promise is only awaited or dropped; a body giving both null and undefined is refused, as the
	 * optional can't tell them apart.
	 */
	lenientAsync(this: ValueStates, fn: ts.Node): fn is ts.FunctionDeclaration | ts.MethodDeclaration {
		const b = this.backend;
		if (b.library || !b.lenientApp || fn.getSourceFile().isDeclarationFile) return false;
		if (!(ts.isFunctionDeclaration(fn) || b.ownSignature(fn)) || fn.asteriskToken || !fn.body) return false;
		let found = this.lenientAsyncs.get(fn);
		if (found !== undefined) return found;
		const result = b.type(this.checker.getSignatureFromDeclaration(fn)!.getReturnType(), fn);
		const v = result.head === 'JSPromise' && result.args.length === 1 && !result.optional && !result.implicit ? result.args[0] : undefined;
		const given = this.lenientGiven(fn);
		// A plugin's promises are held optional (lenient code's), which adopting another function's promise into a widened
		// one cannot spell: a plugin's async result widens only where it returns `null` or `undefined` itself (a plain
		// function's `resolvedGiven` counts only literal empties).
		found = !!v && emptyInto(v) === 'widen' && !b.functionType(v) && (given.null || given.missing || given.unknown) && (!this.plugin(fn) || !isAsync(fn) || returnsEmptyLiteral(fn));
		this.lenientAsyncs.set(fn, found);
		if (found && given.null && (given.missing || given.unknown)) throw b.error(fn, 'a non-strict async function giving null and undefined both (`return null` and a bare `return`)');
		return found;
	},

	/**
	 * `x ?? null`, `x || null` (or `undefined`) of an object a non-strict app's code types present: the value, or that
	 * empty state where `x` gives nothing, which no object of the type stands for.
	 */
	emptyDefault(this: ValueStates, e: ts.Expression): 'null' | 'undefined' | null {
		const b = this.backend,
			K = ts.SyntaxKind;
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (!b.lenientApp || b.library || !ts.isBinaryExpression(e) || (e.operatorToken.kind !== K.QuestionQuestionToken && e.operatorToken.kind !== K.BarBarToken)) return null;
		const right = ts.skipOuterExpressions(e.right, ts.OuterExpressionKinds.Parentheses);
		const state = right.kind === K.NullKeyword ? 'null' : ts.isIdentifier(right) && right.text === 'undefined' ? 'undefined' : null;
		if (!state) return null;
		const t = b.typeOf(e);
		return emptyInto(t) === 'widen' && (t.kind === 'object' || t.kind === 'tuple' || t.kind === 'value') ? state : null;
	},

	/** An `emptyDefault`, or a conditional one of whose branches is one. */
	mayGiveEmptyDefault(this: ValueStates, e: ts.Expression): boolean {
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		return ts.isConditionalExpression(e) ? this.mayGiveEmptyDefault(e.whenTrue) || this.mayGiveEmptyDefault(e.whenFalse) : !!this.emptyDefault(e);
	},

	/** A closure literal one of whose results `mayGiveEmptyDefault`: its result holds that empty state as well. */
	givesEmptyDefault(this: ValueStates, fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
		if (!fn.body) return false;
		const gives = (e: ts.Expression) => this.mayGiveEmptyDefault(e);
		if (!ts.isBlock(fn.body)) return gives(fn.body);
		let found = false;
		const visit = (n: ts.Node): void => {
			if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
			if (ts.isReturnStatement(n) && n.expression && gives(n.expression)) {
				found = true;
				return;
			}
			ts.forEachChild(n, visit);
		};
		ts.forEachChild(fn.body, visit);
		return found;
	},

	/** What a `lenientAsync` candidate's promise gives where it gives nothing. */
	lenientGiven(this: ValueStates, fn: ts.FunctionDeclaration | ts.MethodDeclaration): ReturnType<typeof nothingGiven> {
		return isAsync(fn) ? nothingGiven(fn, this.checker) : resolvedGiven(fn, this.checker);
	},

	/** A `new Promise(executor)` or `Promise.resolve(x)` returned by a non-async `lenientAsync` function: a promise of the function's optional. */
	widenedPromise(this: ValueStates, e: ts.Expression): ts.FunctionDeclaration | ts.MethodDeclaration | null {
		if (!(isPromiseNew(e) || isPromiseResolve(e)) || !ts.isReturnStatement(ts.walkUpParenthesizedExpressions(e.parent))) return null;
		const fn = ts.findAncestor(e.parent, ts.isFunctionLike);
		return fn && !isAsync(fn) && this.lenientAsync(fn) ? fn : null;
	},

	/** A call of a `lenientAsync` function. */
	lenientAsyncCall(this: ValueStates, e: ts.Expression): boolean {
		if (!this.backend.lenientApp) return false;
		e = ts.skipOuterExpressions(e);
		if (!ts.isCallExpression(e)) return false;
		const d = this.checker.getResolvedSignature(e)?.getDeclaration();
		return !!d && !ts.isJSDocSignature(d) && this.lenientAsync(d);
	},

	/** A promise an async function returns that is its own promise's type: adopted as it is. */
	returnedAsIs(this: ValueStates, e: ts.CallExpression): boolean {
		if (!ts.isReturnStatement(ts.walkUpParenthesizedExpressions(e.parent))) return false;
		const outer = ts.findAncestor(e.parent, ts.isFunctionLike);
		const d = this.checker.getResolvedSignature(e)?.getDeclaration();
		return !!outer && !!d && !ts.isJSDocSignature(d) && isAsync(outer) && sameType(this.backend.returnTypeOf(outer as ts.SignatureDeclaration), this.backend.returnTypeOf(d));
	},

	/**
	 * Library code's value whose one nil is null wherever the program gives it one: an object given by a call of a
	 * function giving only null where it gives nothing (`nullResult`), `a && b` of such a value and a string, number or
	 * boolean held present (whose falsy result is `a`'s null), or a variable given such a value or `null` and otherwise
	 * only present values (`onlyNullOrPresent`; one declared without a value, where its read is `assignedBefore`). A
	 * string, number or boolean variable is one only where the program gives it such an `a && b`.
	 */
	libraryNull(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend,
			bare = ts.skipOuterExpressions(e);
		if (ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
			const right = this.checker.getTypeAtLocation(bare.right);
			return !(right.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && !!(right.flags & PRIMITIVE) && !b.optional(b.typeOf(bare.right)) && this.libraryNull(bare.left);
		}
		const t = this.checker.getTypeAtLocation(bare);
		const object = !!(t.flags & ts.TypeFlags.Object) && !t.getCallSignatures().length;
		if (!object && !(ts.isIdentifier(bare) && primitiveType(t))) return false;
		if (ts.isCallExpression(bare)) return this.nullResult(bare);
		if (!this.libraryNullVariable(bare)?.only) return false;
		const d = b.resolve(bare as ts.Identifier)!.valueDeclaration as ts.VariableDeclaration;
		return !!d.initializer || assignedBefore(d, bare, this.checker);
	},

	/**
	 * A library variable read by `e` that the program gives null (`null`, a `nullResult` call), and whether only null
	 * where it gives nothing (`onlyNullOrPresent`). Null for any other read.
	 */
	libraryNullVariable(this: ValueStates, e: ts.Expression): { only: boolean } | null {
		const d = ts.isIdentifier(e) ? this.backend.resolve(e)?.valueDeclaration : undefined;
		if (!d || !ts.isVariableDeclaration(d)) return null;
		let found = this.libraryNullVars.get(d);
		if (found === undefined) {
			this.libraryNullVars.set(d, null);
			const and = (v: ts.Expression) => ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && this.libraryNull(v);
			const primitive = primitiveType(this.checker.getTypeAtLocation(d.name));
			const nullOnly = (v: ts.Expression) => (!ts.isAwaitExpression(v) && this.nullResult(v)) || and(v);
			found = givenBy(d, this.checker, primitive ? and : (v) => v.kind === ts.SyntaxKind.NullKeyword || nullOnly(v)) ? { only: onlyNullOrPresent(d, this.checker, nullOnly, true) } : null;
			this.libraryNullVars.set(d, found);
		}
		return found;
	},

	/**
	 * Lenient code's string, number or boolean field (static or instance) the program initializes to null or writes null
	 * to (`static X: string = null`, `this.s = null`): held optional, its nil null, as JavaScript holds it. Every other
	 * such field holds its type's zero for an empty value. Asked of the declaration, its name, or a read of it. A non-strict
	 * app's instance fields are its class plan's (`nullFields`): only its static ones are these.
	 */
	lenientNullField(this: ValueStates, n: ts.Node | undefined): boolean {
		if (!n) return false;
		const b = this.backend;
		if (!b.library && !b.lenientApp) return false;
		const named = ts.isPropertyAccessExpression(n) ? n.name : ts.isPropertyDeclaration(n) ? n.name : n;
		if (!ts.isIdentifier(named) && !ts.isPrivateIdentifier(named)) return false;
		const d = ts.isPropertyDeclaration(n) ? n : (this.checker.getSymbolAtLocation(named) ?? b.resolve(named))?.valueDeclaration;
		return !!d && ts.isPropertyDeclaration(d) && this.lenientNullFields().has(d);
	},

	/**
	 * A read of a library object's `lenientNullField` declared without a value (a compound assignment's or an increment's
	 * target included): undefined until its key is made, null where nil once it is, which only its read by key tells
	 * apart. A static's is its `unsetNullStatic` written flag.
	 */
	unsetNullField(this: ValueStates, e: ts.Expression): e is ts.PropertyAccessExpression {
		if (!this.backend.library || !ts.isPropertyAccessExpression(e) || e.questionDotToken || e.expression.kind === ts.SyntaxKind.SuperKeyword) return false;
		const p = ts.walkUpParenthesizedExpressions(e.parent);
		const compound = ts.isBinaryExpression(p) && ts.skipOuterExpressions(p.left) === e && p.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment;
		const counted = (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken);
		if (isWriteTarget(e) && !compound && !counted) return false;
		const d = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
		return !!d && ts.isPropertyDeclaration(d) && !d.initializer && this.lenientNullFields().has(d) && (!isStatic(d) || ts.isIdentifier(d.name));
	},

	/**
	 * A library static `lenientNullField` declared without a value: a static has no key to make, so a flag beside it
	 * (`writtenFlag`), set by every write, tells undefined (never written) from null.
	 */
	unsetNullStatic(this: ValueStates, d: ts.PropertyDeclaration): boolean {
		return !!this.backend.library && isStatic(d) && !d.initializer && ts.isIdentifier(d.name) && this.lenientNullFields().has(d);
	},

	/** Every `lenientNullField`: one pass over the program's initializers and writes. */
	lenientNullFields(this: ValueStates): Set<ts.PropertyDeclaration> {
		if (this.lenientNullFieldSet) return this.lenientNullFieldSet;
		const b = this.backend,
			found = new Set<ts.PropertyDeclaration>();
		const field = (d: ts.Declaration | undefined): d is ts.PropertyDeclaration => {
			if (!d || !ts.isPropertyDeclaration(d) || !ts.isClassLike(d.parent) || d.getSourceFile().isDeclarationFile || b.trust.strictFile(d.getSourceFile()) || (!b.library && !isStatic(d))) return false;
			if (ts.getDecorators(d)?.length || d.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword || m.kind === ts.SyntaxKind.AbstractKeyword)) return false;
			return primitiveType(this.checker.getTypeAtLocation(d.name));
		};
		// `a = b = null` gives null to both.
		const isNull = (e: ts.Expression): boolean => {
			const bare = ts.skipOuterExpressions(e);
			return bare.kind === ts.SyntaxKind.NullKeyword || (ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.EqualsToken && isNull(bare.right));
		};
		const visit = (n: ts.Node): void => {
			if (ts.isPropertyDeclaration(n) && n.initializer && isNull(n.initializer) && field(n)) found.add(n);
			if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isNull(n.right)) {
				const target = ts.skipOuterExpressions(n.left);
				const d = ts.isPropertyAccessExpression(target) ? this.checker.getSymbolAtLocation(target.name)?.valueDeclaration : undefined;
				if (field(d)) found.add(d);
			}
			ts.forEachChild(n, visit);
		};
		for (const f of b.sourceFiles) if (!f.isDeclarationFile) visit(f);
		return (this.lenientNullFieldSet = found);
	},

	/** A call of a function whose result is optional and whose body gives only null where it gives nothing, awaited when async, or of a `nullOnlyResult`. */
	nullResult(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend;
		const awaited = ts.isAwaitExpression(e);
		const call = awaited ? ts.skipOuterExpressions(e.expression) : e;
		if (!ts.isCallExpression(call)) return false;
		const d = this.checker.getResolvedSignature(call)?.getDeclaration();
		if (!awaited && d && !ts.isJSDocSignature(d) && this.nullOnlyResult(d)) return true;
		if (!d || ts.isJSDocSignature(d) || !(ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) || !d.body || (!awaited && isAsync(d))) return false;
		if (awaited ? !this.lenientAsync(d) : !b.resultHoldsNull(d)) return false;
		const given = awaited ? this.lenientGiven(d) : nothingGiven(d, this.checker);
		return given.null && !given.missing && !given.unknown;
	},
};

export type LenientMethods = typeof lenientMethods;

/** The name of an `unsetNullStatic`'s written flag. */
export const writtenFlag = (name: string): string => `__written_${name}`;
