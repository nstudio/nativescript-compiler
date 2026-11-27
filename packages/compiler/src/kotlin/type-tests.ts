// Type tests as Kotlin: instanceof, typeof and truth decided statically.
import ts from 'typescript';
import { ERRORS, UNSUPPORTED_LIB_GLOBALS } from '../semantics/globals.ts';
import { LIB_CONSTANTS } from './library.ts';
import { isUnsupportedLibStatic } from '../semantics/apis/statics.ts';
import { IOS_TYPINGS, ident, isNullable, kotlinString, optionalType, typeofName, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { mergedInterfaceMemberOf, neverDefined } from '../semantics/lang.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { implementationOf } from '../semantics/ast.ts';

export const typeTestsMethods = {
	/**
	 * `x instanceof C` where x's class decides it (C itself, or a class outside C's hierarchy): Kotlin calls such an `is`
	 * always true or false, though an unset value (null) still fails it.
	 */
	decidedInstanceOf(this: Translator, e: ts.BinaryExpression): boolean {
		const own = this.typeOf(e.left);
		if (ERRORS[e.right.getText()] === own) return true;
		const sym = this.resolve(ts.isPropertyAccessExpression(e.right) ? e.right.name : e.right);
		const leftSym = this.checker.getTypeAtLocation(e.left).getSymbol();
		if (isUntyped(spelledType(own)) || own === 'Any' || !sym || !(sym.flags & ts.SymbolFlags.Class) || !leftSym || !(leftSym.flags & ts.SymbolFlags.Class)) return false;
		const left = this.checker.getTypeAtLocation(e.left),
			right = this.checker.getDeclaredTypeOfSymbol(sym);
		return this.checker.isTypeAssignableTo(left, right) || !this.checker.isTypeAssignableTo(right, left);
	},

	/** An expression that only reads: pure, or `typeof` and comparisons of such reads. */
	readsOnly(this: Translator, e: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (ts.isTypeOfExpression(e)) return ts.isIdentifier(e.expression);
		if (ts.isBinaryExpression(e) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) return this.readsOnly(e.left) && this.readsOnly(e.right);
		return this.pure(e);
	},

	/** An argument of a call to a function a package's source declares (`combineLatest([a$, b$])`). */
	packageArgument(this: Translator, e: ts.Expression): boolean {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const call = x.parent;
		if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || !call.arguments?.includes(x as ts.Expression)) return false;
		const d = this.checker.getResolvedSignature(call)?.getDeclaration();
		return !!d && this.pluginFiles.has(d.getSourceFile().fileName);
	},

	/** A program's generic function named as a value (`identity`), which Kotlin holds by its erased declaration's type. */
	genericFunctionRef(this: Translator, e: ts.Expression): boolean {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		const d = ts.isIdentifier(x) ? this.resolve(x)?.valueDeclaration : undefined;
		return !!d && ts.isFunctionDeclaration(d) && !d.getSourceFile().isDeclarationFile && !!d.typeParameters?.length;
	},

	/** A constructor or function of the language's library (`Symbol`, `Map`, `Promise`), which the runtime always has. */
	libCallable(this: Translator, e: ts.Expression): boolean {
		const decls = ts.isIdentifier(e) ? this.resolve(e)?.declarations : undefined;
		if (!decls?.length || !decls.every((d) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(d.getSourceFile().fileName))) return false;
		if (ts.isIdentifier(e) && UNSUPPORTED_LIB_GLOBALS.has(e.text)) return false;
		const t = this.checker.getTypeAtLocation(e);
		return t.getConstructSignatures().length > 0 || t.getCallSignatures().length > 0;
	},

	/** What `typeof x` gives where x's type decides it (`typeof size` of a number), or null. */
	typeofConstant(this: Translator, e: ts.TypeOfExpression): string | null {
		if (neverDefined(e.expression, this.checker)) return 'undefined';
		const read = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		// Feature-probing an unsupported static method on a built-in (`typeof (Uint8Array as any).fromBase64`): always `"undefined"`.
		if (isUnsupportedLibStatic(this, read, (k) => !!LIB_CONSTANTS[k])) return 'undefined';
		if (ts.isPropertyAccessExpression(read) && mergedInterfaceMemberOf(read, this.checker)) return null;
		const decls = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.declarations : undefined;
		if (decls?.length && decls.every((d) => IOS_TYPINGS.test(d.getSourceFile().fileName))) return 'undefined';
		if (ts.isIdentifier(e.expression) && UNSUPPORTED_LIB_GLOBALS.has(e.expression.text) && decls?.length && decls.every((d) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(d.getSourceFile().fileName))) return 'undefined';
		if (this.namesClass(e.expression) || this.libCallable(e.expression)) return 'function';
		const param = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.valueDeclaration : undefined;
		if (param && ts.isParameter(param) && (this.typeTested(param) || this.untypedNarrowed(param))) return null;
		const t = this.typeOf(e.expression);
		const base = t.replace(/\?$/, '');
		if (base === 'Unit') return 'undefined';
		const known = typeofName(base);
		if (isUntyped(spelledType(t)) || !known || t.endsWith('?') || this.heldNullable(e.expression, t)) return null;
		return this.maybeUndefined(e.expression) ? null : known;
	},

	/**
	 * Library mode: a read the checker's types call present that Kotlin holds nullable, as unchecked code may leave it
	 * undefined (an optional parameter, an unset `let enabled: boolean`, a boolean function that returns undefined).
	 */
	heldNullable(this: Translator, e: ts.Expression, t: string): boolean {
		if (!this.library) {
			const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
			if (this.lenientApp && ts.isIdentifier(x) && this.declaredTypeOf(x) === optionalType(t)) return true;
			if (ts.isPropertyAccessExpression(x) && this.isLenientOptionalMember(x)) return true;
			if (this.lenientMissingMember(x)) return true;
			const d = ts.isCallExpression(x) ? this.checker.getResolvedSignature(x)?.getDeclaration() : ts.isIdentifier(x) || ts.isPropertyAccessExpression(x) ? this.resolve(ts.isPropertyAccessExpression(x) ? x.name : x)?.valueDeclaration : undefined;
			return !!d && !ts.isJSDocSignature(d) && this.states.looseDeclaration(d);
		}
		if (ts.isIdentifier(e)) {
			if (this.declaredTypeOf(e) === optionalType(t)) return true;
			// A copy of such a call's result, which flow analysis may ask about before its declaration is translated.
			const d = this.resolve(e)?.valueDeclaration;
			return !!d && ts.isVariableDeclaration(d) && !!d.initializer && ts.isCallExpression(ts.skipOuterExpressions(d.initializer)) && this.heldNullable(ts.skipOuterExpressions(d.initializer), t);
		}
		if (!ts.isCallExpression(e)) return false;
		const d = this.checker.getResolvedSignature(e)?.getDeclaration();
		return !!d && !ts.isJSDocSignature(d) && this.nullablePrimitiveReturn(implementationOf(d) ?? d);
	},

	/**
	 * The value a condition always has where the program's types decide it (`typeof size === 'number'` of a number,
	 * a number or boolean compared with undefined, which Kotlin's never is), or undefined.
	 */
	staticTruth(this: Translator, e: ts.Expression): boolean | undefined {
		const fixed = this.reach?.constant(e);
		if (fixed !== undefined) return fixed;
		const K = ts.SyntaxKind;
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (e.kind === K.TrueKeyword) return true;
		if (e.kind === K.FalseKeyword) return false;
		if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) {
			const inner = this.staticTruth(e.operand);
			return inner === undefined ? undefined : !inner;
		}
		if (!ts.isBinaryExpression(e)) return undefined;
		const op = e.operatorToken.kind;
		if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
			const l = this.staticTruth(e.left);
			if (l === (op === K.BarBarToken)) return l;
			if (l !== undefined) return this.staticTruth(e.right);
			// `typeof Reflect === 'object' && typeof Reflect.construct === 'function'` of an API Android lacks: the read alone decides nothing.
			const r = this.staticTruth(e.right);
			return r === (op === K.BarBarToken) && this.readsOnly(e.left) ? r : undefined;
		}
		if (![K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(op)) return undefined;
		const negate = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
		const skip = (x: ts.Expression) => {
			while (ts.isParenthesizedExpression(x)) x = x.expression;
			return x;
		};
		const [a, b] = [skip(e.left), skip(e.right)];
		const typeofAgainst = (t: ts.Expression, lit: ts.Expression) => (ts.isTypeOfExpression(t) && ts.isStringLiteralLike(lit) ? this.typeofConstant(t) : null);
		const known = typeofAgainst(a, b) ?? typeofAgainst(b, a);
		if (known !== null) return (known === (ts.isStringLiteralLike(b) ? b.text : (a as ts.StringLiteral).text)) !== negate;
		const nullish = (x: ts.Expression) => x.kind === K.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		const operand = nullish(b) ? a : nullish(a) ? b : null;
		// A read that cannot throw (a variable, `this.x`) of a number or boolean Kotlin holds as one: never null.
		const plain = operand && (ts.isIdentifier(operand) || (ts.isPropertyAccessExpression(operand) && operand.expression.kind === K.ThisKeyword && !operand.questionDotToken));
		if (plain && ['Double', 'Boolean'].includes(this.typeOf(operand)) && ['Double', 'Boolean'].includes(this.declaredTypeOf(operand) ?? this.typeOf(operand)) && !this.maybeUndefined(operand) && !this.states.nullishRead(operand)) return negate;
		return undefined;
	},

	typeofExpr(this: Translator, e: ts.TypeOfExpression): string {
		if (neverDefined(e.expression, this.checker)) return '"undefined"';
		const read = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		// Feature-probing an unsupported static method on a built-in (`typeof (Uint8Array as any).fromBase64`): always `"undefined"`.
		if (isUnsupportedLibStatic(this, read, (k) => !!LIB_CONSTANTS[k])) return '"undefined"';
		if (ts.isPropertyAccessExpression(read) && !ts.isOptionalChain(read) && mergedInterfaceMemberOf(read, this.checker)) return `${RT.jsTypeof}(${RT.jsGet}(${this.expr(read.expression)}, ${kotlinString(read.name.text)}))`;
		if (ts.isPropertyAccessExpression(read) && this.augmentedMember(read)) return `${RT.jsTypeof}(${this.augmentedRead(read)})`;
		// An iOS API (`typeof NSDate`) or omitted ES global (`typeof FinalizationRegistry`): undefined without throwing.
		const decls = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.declarations : undefined;
		if (decls?.length && decls.every((d) => IOS_TYPINGS.test(d.getSourceFile().fileName))) return '"undefined"';
		if (ts.isIdentifier(e.expression) && UNSUPPORTED_LIB_GLOBALS.has(e.expression.text) && decls?.length && decls.every((d) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(d.getSourceFile().fileName))) return '"undefined"';
		if (this.namesClass(e.expression) || this.libCallable(e.expression)) return '"function"';
		// A parameter callers give other values than its type (`typeTested`): what it holds, never its declared type's.
		const tested = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.valueDeclaration : undefined;
		if (tested && ts.isParameter(tested) && (this.typeTested(tested) || this.untypedNarrowed(tested))) return `${RT.jsTypeof}(${ident((e.expression as ts.Identifier).text)})`;
		if (this.states.nullDistinct(e.expression)) return `${RT.jsTypeof}(${this.observe(e.expression)})`;
		if (this.lenientMissingMember(read)) return this.rawTypeof(read);
		const untyped = this.untypedMemberRead(read);
		if (untyped) return `${RT.jsTypeof}(${untyped})`;
		const t = this.typeOf(e.expression);
		const base = t.replace(/\?$/, '');
		if (base === 'Unit') return '"undefined"';
		const known = typeofName(base);
		if (isUntyped(spelledType(t)) || !known) return `${RT.jsTypeof}(${this.expr(e.expression)})`;
		// Code unchecked for null, or a parameter of a function script calls: undefined when left out, though read as its type.
		const param = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.valueDeclaration : undefined;
		if (param && ts.isParameter(param) && (this.library || this.lenient || this.lenientApp || this.states.scriptCalledParameter(param)) && !t.endsWith('?') && this.declaredTypeOf(e.expression as ts.Identifier) === optionalType(t)) return this.rawTypeof(e.expression);
		// A call whose result Kotlin holds nullable though its type says present: what it gives.
		const callee = ts.isCallExpression(e.expression) && !this.library ? this.checker.getResolvedSignature(e.expression)?.getDeclaration() : undefined;
		if (callee && !ts.isJSDocSignature(callee) && !callee.getSourceFile().isDeclarationFile && !t.endsWith('?') && this.returnTypeOf(callee) === optionalType(t)) return `${RT.jsTypeof}(${this.expr(e.expression)})`;
		// `a && b` of an object `a` held nullable: `a`'s nil where it is missing, whatever `b`'s type.
		if (!t.endsWith('?') && ts.isBinaryExpression(read) && read.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && this.isObjectType(this.typeOf(read.left)) && isNullable(this.declaredTypeOf(read.left) ?? this.typeOf(read.left))) return `${RT.jsTypeof}(${this.coerce(read, 'Any?')})`;
		const maybe = this.maybeUndefined(e.expression);
		// A value that may be missing: the runtime's typeof, as a test before it may already prove it present.
		if (maybe) return `${RT.jsTypeof}(${maybe})`;
		if (!t.endsWith('?') && this.heldNullable(e.expression, t)) return this.rawTypeof(e.expression);
		if (!t.endsWith('?') && this.states.missingObject(e.expression)) return `${RT.jsTypeof}(${this.observe(e.expression, 'asIs')})`;
		if (!t.endsWith('?') && known === 'object' && this.states.typedUnset(read)) return this.rawTypeof(e.expression);
		return t.endsWith('?') ? `${RT.jsTypeof}(${this.expr(e.expression)})` : kotlinString(known);
	},

	/**
	 * Lenient code: a parameter Kotlin holds untyped (`val: string | string[]`) that the checker narrows to one type, which
	 * unchecked for null leaves undefined possible (`Array.isArray(val)` false).
	 */
	untypedNarrowed(this: Translator, p: ts.ParameterDeclaration): boolean {
		return this.lenient && ts.isIdentifier(p.name) && isUntyped(spelledType(this.declaredTypeOf(p.name)));
	},

	/** `typeof x` of a value Kotlin holds nullable, read as it is held. */
	rawTypeof(this: Translator, e: ts.Expression): string {
		this.nullOk.add(e);
		try {
			return `${RT.jsTypeof}(${this.expr(e)})`;
		} finally {
			this.nullOk.delete(e);
		}
	},
};
