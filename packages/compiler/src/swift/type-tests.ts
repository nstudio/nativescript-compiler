// Type tests as Swift: typeof, presence and the conditional operator.
import ts from 'typescript';
import { isLibGlobal } from '../semantics/globals.ts';
import { inOptionalChain, isNullish, swiftString, RT } from './syntax.ts';
import type { Translator, TypeofCell } from './translator.ts';
import { mergedInterfaceMemberOf, neverDefined } from '../semantics/lang.ts';
import { notedField } from '../semantics/shapes.ts';
import { numberArrayElement } from '../semantics/sharing.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const typeTestsMethods = {
	/** `typeof x === 'number'` where Swift knows x's type: decided now (a branch TypeScript narrows to never never runs). */
	staticTypeof(this: Translator, e: ts.Expression): boolean | undefined {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		const K = ts.SyntaxKind;
		// A literal (a bundler define written in: `__UI_USE_XML_PARSER__` is `(true)`), or two literal strings compared.
		if (e.kind === K.TrueKeyword || e.kind === K.FalseKeyword) return e.kind === K.TrueKeyword;
		if (ts.isBinaryExpression(e) && [K.EqualsEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.ExclamationEqualsToken].includes(e.operatorToken.kind)) {
			const [a, b] = [e.left, e.right].map((x) => ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses));
			if (ts.isStringLiteral(a) && ts.isStringLiteral(b)) return (a.text === b.text) === [K.EqualsEqualsEqualsToken, K.EqualsEqualsToken].includes(e.operatorToken.kind);
		}
		if (ts.isBinaryExpression(e) && (e.operatorToken.kind === K.AmpersandAmpersandToken || e.operatorToken.kind === K.BarBarToken)) {
			// `a && b` decided by b alone only where a has no effect to keep.
			const harmless = (x: ts.Expression): boolean => {
				x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
				if (ts.isTypeOfExpression(x)) return this.pure(x.expression);
				return ts.isBinaryExpression(x) && x.operatorToken.kind !== K.EqualsToken ? harmless(x.left) && harmless(x.right) : this.pure(x);
			};
			const decisive = e.operatorToken.kind === K.BarBarToken;
			const left = this.staticTypeof(e.left),
				right = this.staticTypeof(e.right);
			if (left === decisive || (right === decisive && (left !== undefined || harmless(e.left)))) return decisive;
			return left === !decisive ? right : undefined;
		}
		if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) {
			const inner = this.staticTypeof(e.operand);
			return inner === undefined ? undefined : !inner;
		}
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.InstanceOfKeyword && this.pure(e.left) && this.heldInstance(e) === 'always') return true;
		if (!ts.isBinaryExpression(e) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(e.operatorToken.kind)) return undefined;
		const absent = this.neverNullish(e);
		if (absent !== undefined) return absent;
		const [t, lit] = ts.isTypeOfExpression(e.left) ? [e.left, e.right] : ts.isTypeOfExpression(e.right) ? [e.right, e.left] : [null, null];
		if (!t || !lit || !ts.isStringLiteral(lit)) return undefined;
		const c = this.typeofCell(t);
		if (c.cell !== 'known' || this.maybeUndefined(t.expression)) return undefined;
		const same = c.type === lit.text;
		return e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ? same : !same;
	},

	/**
	 * Whether Swift holds a value that cannot be missing where it is read: a parameter it takes as no optional, a local
	 * made with a value (an object made, a literal, or a string, number, boolean or native struct) and never assigned
	 * again, or a field of such a value initialized so. A variable declared without a value is held implicitly unwrapped.
	 */
	definitelyPresent(this: Translator, x: ts.Expression): boolean {
		x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
		const t = this.typeOf(x);
		const value = ['String', 'Bool', 'Double'].includes(t) || this.native.isStructType(t) || this.native.isEnumType(t);
		if (ts.isIdentifier(x)) {
			const sym = this.resolve(x);
			const d = sym?.valueDeclaration;
			if (!sym || !d || this.undefinedVars.has(sym)) return false;
			if (ts.isParameter(d)) return !d.dotDotDotToken && !/[?!]$/.test(this.paramType(d)) && !this.states.mayBeNull(d) && (value || !this.lenient);
			if (!ts.isVariableDeclaration(d) || !d.initializer || isNullish(d.initializer) || this.writtenIn(d.getSourceFile(), false).vars.has(sym)) return false;
			const init = ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses);
			if (ts.isCallExpression(init) && this.libMayBeUndefined(init)) return false;
			return ts.isNewExpression(init) || ts.isLiteralExpression(init) || ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || (value && !this.maybeUndefined(d.initializer));
		}
		if (ts.isPropertyAccessExpression(x) && !x.questionDotToken) {
			// A native property Swift declares as no optional.
			const native = !inOptionalChain(x) ? this.native.propertyType(x) : null;
			if (native) return !/[?!]$/.test(native);
			const d = this.resolve(x.name)?.valueDeclaration;
			return !!d && ts.isPropertyDeclaration(d) && !d.questionToken && !!d.initializer && !isNullish(d.initializer) && value && this.pure(d.initializer);
		}
		return false;
	},

	/**
	 * `x == null` (and `!=`, `===`, `!==`) of a value Swift holds as a string, a boolean, a native struct or enum, which cannot be
	 * missing: what the test always gives. Undefined where the value may be missing.
	 */
	neverNullish(this: Translator, e: ts.BinaryExpression): boolean | undefined {
		const K = ts.SyntaxKind;
		const nullish = (x: ts.Expression) => x.kind === K.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		const x = nullish(e.right) ? e.left : nullish(e.left) ? e.right : null;
		if (!x || nullish(x) || notedField(this.states, x)) return undefined;
		const negate = e.operatorToken.kind === K.ExclamationEqualsEqualsToken || e.operatorToken.kind === K.ExclamationEqualsToken;
		if (!this.definitelyPresent(x) || inOptionalChain(x) || this.maybeUndefined(x)) return undefined;
		const t = this.typeOf(x);
		const declared = this.declaredTypeOf(x);
		if (declared && declared !== t) return undefined;
		if (!(t === 'String' || t === 'Bool' || this.native.isStructType(t) || this.native.isEnumType(t))) return undefined;
		// A native read Swift has as optional, unwrapped where it is read.
		const code = this.expr(x);
		if (this.marks.isUnwrap(code)) return undefined;
		return negate;
	},

	/** `c ? a : b` of a value of type `t`; a test of the iOS version is `#available`, so the newer branch may use what it tests for. */
	ternary(this: Translator, e: ts.ConditionalExpression, t: string, branch: (x: ts.Expression) => string): string {
		const fixed = this.staticTypeof(e.condition);
		if (fixed !== undefined) return branch(fixed ? e.whenTrue : e.whenFalse);
		const gate = this.availabilityTest(e.condition);
		if (!gate) return `(${this.cond(e.condition)} ? ${branch(e.whenTrue)} : ${branch(e.whenFalse)})`;
		const [newer, older] = gate.present ? [e.whenTrue, e.whenFalse] : [e.whenFalse, e.whenTrue];
		const saved = this.refinedVersion;
		this.refinedVersion = Math.max(saved, gate.version);
		const a = branch(newer);
		this.refinedVersion = saved;
		const b = branch(older);
		const throws = this.tryPrefix(newer) || this.tryPrefix(older);
		return `({ () ${throws ? 'throws ' : ''}-> ${t} in if #available(iOS ${gate.version}, *) { return ${this.tryPrefix(newer)}${a} } else { return ${this.tryPrefix(older)}${b} } }())`;
	},

	typeofExpr(this: Translator, e: ts.TypeOfExpression): string {
		const c = this.typeofCell(e);
		return c.cell === 'known' ? swiftString(c.type) : c.cell === 'presence' ? `(${c.tested} == nil ? "undefined" : ${swiftString(c.type)})` : c.code;
	},

	typeofCell(this: Translator, e: ts.TypeOfExpression): TypeofCell {
		const known = (type: string): TypeofCell => ({ cell: 'known', type });
		const code = (code: string): TypeofCell => ({ cell: 'code', code });
		// One of the app's own Swift classes: a class, as NativeScript's runtime exposes it.
		if (this.appNativeOf(e.expression)) return known('function');
		if (neverDefined(e.expression, this.checker)) return known('undefined');
		// A member of an untyped object is whatever script put there, whatever its declared type says.
		const read = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		if (ts.isPropertyAccessExpression(read) && !ts.isOptionalChain(read) && ((this.isAny(read.expression) && !(ts.isIdentifier(read.expression) && isLibGlobal(this, read.expression))) || mergedInterfaceMemberOf(read, this.checker)) && !this.isAny(read)) return code(`${RT.jsTypeof}(${RT.jsGet}(${this.expr(read.expression)}, ${swiftString(read.name.text)}))`);
		if (ts.isPropertyAccessExpression(read) && this.augmentedMember(read)) return code(`${RT.jsTypeof}(${this.augmentedRead(read)})`);
		const newer = this.native.introducedAfterDeployment(e.expression);
		if (newer) return code(`(${RT.jsOSAtLeast}(${newer}) ? "function" : "undefined")`);
		// A constructor or function of the language's library (`Symbol`, `Map`, `Promise`), which the kit always has.
		const lib = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.declarations : undefined;
		const callable = this.checker.getTypeAtLocation(e.expression);
		if (lib?.length && lib.every((d) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(d.getSourceFile().fileName)) && (callable.getConstructSignatures().length || callable.getCallSignatures().length)) return known('function');
		if (this.states.nullDistinct(e.expression)) return code(`${RT.jsTypeof}(${this.observe(e.expression)})`);
		if (numberArrayElement(read, this.checker)) return code(`${RT.jsTypeof}(${this.maybeUndefined(e.expression) ?? this.expr(e.expression)} as Any?)`);
		const t = this.typeOf(e.expression);
		// A variable held untyped and narrowed (`val: string | string[]` past `Array.isArray(val)`): the narrowing does not exclude undefined.
		if (ts.isIdentifier(read) && !isUntyped(spelledType(t)) && !this.subst.has(read) && isUntyped(spelledType(this.declaredTypeOf(read)))) return code(`${RT.jsTypeof}(${this.refName(read)})`);
		// A class, held by its name or typed as one (`typeof View`): a constructor, which is a function.
		if (!(callable.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && callable.getConstructSignatures().length && !isUntyped(spelledType(t)) && !t.endsWith('?')) return known('function');
		const base = t.replace(/\?$/, '');
		if (base === 'Void') return known('undefined');
		const type = base === 'Double' ? 'number' : base === 'String' ? 'string' : base === 'Bool' ? 'boolean' : base === 'JSSymbol' ? 'symbol' : base === 'JSBigInt' ? 'bigint' : base.includes('->') ? 'function' : base === 'Any' ? null : 'object';
		const generic = this.checker.getTypeAtLocation(e.expression).flags & ts.TypeFlags.TypeParameter;
		if (isUntyped(spelledType(t)) || !type || generic) return code(`${RT.jsTypeof}(${this.expr(e.expression)})`);
		const maybe = this.maybeUndefined(e.expression);
		const held = ts.isIdentifier(e.expression) ? this.resolve(e.expression) : undefined;
		if (maybe && held && isUntyped(spelledType(this.undefinedVars.get(held)))) return code(`${RT.jsTypeof}(${maybe})`);
		// Lenient code reads an undefined number as NaN (an omitted `atIndex`), the only value typeof can tell it by; an optional one is undefined either way.
		const absent = (tested: string): TypeofCell => (this.lenient && type === 'number' ? code(`(((${tested}).map { $0.isNaN } ?? true) ? "undefined" : "number")`) : { cell: 'presence', tested, type });
		if (maybe) return absent(maybe);
		if (t.endsWith('?')) return absent(this.expr(e.expression));
		const missing = type === 'object' && this.states.missingObject(read) ? this.heldMissing(read) : null;
		if (missing) return { cell: 'presence', tested: missing, type };
		if (this.lenient && type === 'number' && (ts.isIdentifier(e.expression) || this.optionalMember(read))) return code(`(${this.expr(e.expression)}.isNaN ? "undefined" : "number")`);
		// Lenient code holds an object implicitly unwrapped: undefined until assigned.
		if ((this.lenient || this.lenientAppOptional(read) || this.states.typedUnset(read)) && type === 'object') return { cell: 'presence', tested: `(${this.expr(e.expression)} as Any?)`, type };
		// Lenient code holds a function variable, parameter or field optional too; a function or method declared is always there.
		const d = this.resolve(ts.isPropertyAccessExpression(read) ? read.name : read)?.valueDeclaration;
		if (this.lenient && type === 'function' && d && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && this.lenientRef(t) !== t) {
			return { cell: 'presence', tested: `(${this.expr(e.expression)} as Any?)`, type };
		}
		return known(type);
	},
};
