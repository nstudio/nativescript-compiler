// Reads of a value that may be nullish: keyed fields, members, fallbacks (`a ?? b`), narrowed reads and the held source a read comes from.
import ts from 'typescript';
import { CONVERTING, sameReference } from './predicates.ts';
import type { Form } from '../forms/forms.ts';
import { isTemplateMethod } from '../trust.ts';
import { accessedDeclaration } from '../lang.ts';
import { isAsync } from '../throws.ts';
import { nullishSignalType } from '../signals.ts';
import { isWriteTarget } from '../ast.ts';
import type { ValueStates } from './value-states.ts';

export const readsMethods = {
	/** The `nullishHeld` field or accessor pair a literal-key element write (`b['item'] = v`) stores into: the slot the same write by name takes. */
	nullishKeyedField(this: ValueStates, left: ts.Expression): ts.PropertyDeclaration | ts.GetAccessorDeclaration | null {
		if (this.backend.library || this.backend.lenient || !ts.isElementAccessExpression(left) || !ts.isStringLiteralLike(left.argumentExpression)) return null;
		const d = accessedDeclaration(this.checker.getNonNullableType(this.checker.getTypeAtLocation(left.expression)).getProperty(left.argumentExpression.text), false);
		return d && (ts.isPropertyDeclaration(d) || ts.isGetAccessorDeclaration(d)) && this.nullishHeld(d) ? d : null;
	},

	/** A read of a `nullishHeld` slot (a name, a field read by name, or a call giving such a result): the slot's declaration. */
	/** A read of a `nullishHeld` slot as script holds it: non-strict app code reads it untyped, as it reads every value its type may not hold. */
	nullishReadUntyped(this: ValueStates, e: ts.Node): boolean {
		if (!this.backend.lenientApp || !ts.isExpression(e) || !e.parent || ts.isPropertyAccessExpression(e) || ((ts.isParameter(e.parent) || ts.isVariableDeclaration(e.parent)) && e.parent.name === e)) return false;
		return !!this.nullishRead(e);
	},
	nullishRead(this: ValueStates, e: ts.Expression): ts.ParameterDeclaration | ts.VariableDeclaration | ts.SignatureDeclaration | ts.PropertyDeclaration | ts.PropertySignature | null {
		const bare = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (this.backend.library || this.backend.lenient) return null;
		if (ts.isCallExpression(bare)) {
			// A signal's read (`this.note()`): the signal's own declaration, whose value is held as `JSNullish<T>`.
			if (!bare.arguments.length && nullishSignalType(this.checker, this.checker.getTypeAtLocation(bare.expression), (name) => this.backend.framework.signalKind(name))) {
				const own = ts.isPropertyAccessExpression(bare.expression) ? bare.expression.name : bare.expression;
				const d = this.checker.getSymbolAtLocation(own)?.valueDeclaration;
				if (d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isParameter(d) || ts.isVariableDeclaration(d))) return d;
			}
			const d = this.checker.getResolvedSignature(bare)?.getDeclaration();
			return d && !ts.isJSDocSignature(d) && this.nullishHeld(d) ? d : null;
		}
		if (ts.isPropertyAccessExpression(bare)) {
			const sym = this.checker.getSymbolAtLocation(bare.name),
				d = sym?.valueDeclaration;
			const getter = accessedDeclaration(sym, false);
			if (getter && ts.isGetAccessorDeclaration(getter)) return this.nullishHeld(getter) ? getter : null;
			return d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && this.nullishHeld(d) ? d : null;
		}
		if (!ts.isIdentifier(bare)) return null;
		const d = this.checker.getSymbolAtLocation(bare)?.valueDeclaration;
		return d && (ts.isParameter(d) || ts.isVariableDeclaration(d)) && this.nullishHeld(d) ? d : null;
	},

	/**
	 * How a typed read of a field held as `JSNullish<T>` (`this.f`, a `nullishRead` property access) is used, which
	 * both backends read it as: 'member' where script reads a member of it, indexes it or calls it (its `present`:
	 * JavaScript's TypeError on null or undefined); 'converted' where script converts it to a number, a string or a
	 * key (untyped: the conversion tells null from undefined); else 'value', its `T?`, which a slot holding neither
	 * takes through `present` (`nullishPlacement`).
	 */
	nullishFieldUse(this: ValueStates, e: ts.Expression): 'member' | 'converted' | 'value' {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === x) return p.questionDotToken ? 'value' : 'member';
		if (ts.isElementAccessExpression(p) || ts.isTemplateSpan(p)) return 'converted';
		if (ts.isPrefixUnaryExpression(p)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(p.operator) ? 'converted' : 'value';
		return ts.isBinaryExpression(p) && CONVERTING.has(p.operatorToken.kind) ? 'converted' : 'value';
	},

	/**
	 * The key a 'member' use of a field read reads or sets, which its TypeError names (the field's own for a call or a
	 * computed key), and whether script sets it (`this.f.x = v`), which names setting it.
	 */
	nullishMemberKey(this: ValueStates, e: ts.PropertyAccessExpression): { key: string; set: boolean } {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent)) x = x.parent;
		const p = x.parent;
		const set = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && ts.isBinaryExpression(p.parent) && p.parent.left === p && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
		if (ts.isPropertyAccessExpression(p)) return { key: p.name.text, set };
		if (ts.isElementAccessExpression(p) && (ts.isStringLiteralLike(p.argumentExpression) || ts.isNumericLiteral(p.argumentExpression))) return { key: p.argumentExpression.text, set };
		return { key: e.name.text, set };
	},

	/** A variable, parameter, or call result whose slot may hold null and undefined both: held untyped (`nullishSlots`). */
	heldNullish(this: ValueStates, n: ts.Node): boolean {
		// A conditional or a default giving a held value (`key in saved ? saved[key] : fallback`).
		if (ts.isParenthesizedExpression(n)) return this.heldNullish(n.expression);
		if (ts.isConditionalExpression(n)) return this.heldNullish(n.whenTrue) || this.heldNullish(n.whenFalse);
		if (ts.isBinaryExpression(n) && this.fallbackWidens(n)) return true;
		if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return this.heldNullish(n.right);
		// A member of a held value, read by name: whatever the object it is has (`field.hint` of a SearchBar is undefined).
		if (ts.isPropertyAccessExpression(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) return this.heldMember(n.name) || (!this.classMethodReceiver(n) && this.heldNullish(n.expression));
		if (ts.isElementAccessExpression(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) return this.heldNullish(n.expression);
		// A held variable's assertion (`const field = view as TextField`), or one read for a member in place: the value as it is, unchecked as script leaves it.
		if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
			const holder = ts.findAncestor(n.parent, (p) => !ts.isParenthesizedExpression(p));
			return (!!holder && ts.isVariableDeclaration(holder) && this.nullish().held.has(holder)) || (!this.backend.library && !this.backend.lenient && this.heldCasts().receivers.has(n));
		}
		if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
			const d = this.checker.getResolvedSignature(n)?.getDeclaration();
			return !!d && !ts.isJSDocSignature(d) && (this.nullish().held.has(d) || this.fallbackResult(d));
		}
		if (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) return this.nullish().held.has(n);
		if (!ts.isIdentifier(n) || ts.isShorthandPropertyAssignment(n.parent)) return false;
		const d = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
		if (d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isPropertyAssignment(d)) && d.name === n) return this.nullish().held.has(d);
		return !!d && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)) && (this.nullish().held.has(d) || this.fallbackVariable(d));
	},

	/** A variable declaring no type whose initializer is such a `??`, `&&` or `||` (`fallbackWidens`): held untyped. */
	fallbackVariable(this: ValueStates, d: ts.Declaration): boolean {
		if (!ts.isVariableDeclaration(d) || d.type || !ts.isIdentifier(d.name) || !d.initializer) return false;
		let found = this.fallbackVariables.get(d);
		if (found !== undefined) return found;
		this.fallbackVariables.set(d, false);
		const init = ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses);
		found = ts.isBinaryExpression(init) && this.fallbackWidens(init);
		this.fallbackVariables.set(d, found);
		return found;
	},

	/**
	 * A `??`, `&&` or `||` whose whole TypeScript types present, so as its operands' types, while JavaScript can give an
	 * operand the backend holds missing (a field narrower than the optional member it implements): `a ?? b` with such an
	 * `a` and a `b` of another type, `a && b` with such an `a`, and `a && b` or `a || b` with such a `b`.
	 */
	fallbackWidens(this: ValueStates, n: ts.BinaryExpression): boolean {
		const b = this.backend,
			c = this.checker,
			K = ts.SyntaxKind,
			op = n.operatorToken.kind;
		if (b.library || ![K.QuestionQuestionToken, K.AmpersandAmpersandToken, K.BarBarToken].includes(op)) return false;
		const present = (t: ts.Type) => !(t.isUnion() ? t.types : [t]).some((u) => u.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
		const widened = (x: ts.Expression) => present(c.getTypeAtLocation(x)) && this.widenedFieldRead(x) && this.heldOptional(x);
		const left = ts.skipOuterExpressions(n.left, ts.OuterExpressionKinds.Parentheses);
		if (op === K.QuestionQuestionToken) return present(c.getTypeAtLocation(left)) && !c.isTypeAssignableTo(c.getTypeAtLocation(n.right), c.getTypeAtLocation(n)) && this.heldOptional(left);
		if (!present(c.getTypeAtLocation(n))) return false;
		return (op === K.AmpersandAmpersandToken && widened(left)) || widened(ts.skipOuterExpressions(n.right, ts.OuterExpressionKinds.Parentheses));
	},

	/**
	 * A function or method of the program declaring no result type that returns such a `??`, `&&` or `||` (`fallbackWidens`): its
	 * result is held untyped, as its calls read it.
	 */
	fallbackResult(this: ValueStates, fn: ts.Node): boolean {
		const b = this.backend;
		if (b.library || !(ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) || fn.type || !fn.body || fn.asteriskToken || isAsync(fn)) return false;
		if (ts.isMethodDeclaration(fn) && !isTemplateMethod(fn) && !b.ownSignature(fn)) return false;
		let found = this.fallbackResults.get(fn);
		if (found !== undefined) return found;
		found = false;
		const visit = (n: ts.Node): void => {
			if (found || (ts.isFunctionLike(n) && n !== fn) || ts.isClassLike(n)) return;
			if (ts.isReturnStatement(n) && n.expression) {
				const r = ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses);
				if (ts.isBinaryExpression(r) && this.fallbackWidens(r)) found = true;
			}
			ts.forEachChild(n, visit);
		};
		visit(fn.body);
		this.fallbackResults.set(fn, found);
		return found;
	},

	/**
	 * A read of a slot held untyped for its foreign value that a test of its own type guards: inside the then
	 * branch of `typeof r === 'string'` (or number, boolean), or of `r instanceof C`. The form it is read as, a checked
	 * convert's that cannot throw there; null elsewhere, where it is read untyped. `in`, `Array.isArray` and `typeof …
	 * 'object'` tell no class or element type, so their reads stay untyped.
	 */
	narrowedRead(this: ValueStates, e: ts.Node): Form | null {
		const b = this.backend;
		if (b.library || b.lenient || !(ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) || !this.heldSource(e) || isWriteTarget(e)) return null;
		for (let n: ts.Node = e, p = e.parent; p; n = p, p = p.parent) {
			if (ts.isFunctionLike(p) || ts.isClassLike(p) || ts.isSourceFile(p)) return null;
			const cond = ts.isIfStatement(p) && p.thenStatement === n ? p.expression : ts.isConditionalExpression(p) && p.whenTrue === n ? p.condition : ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === n ? p.left : null;
			const type = cond && this.testedType(cond, e);
			if (type) return { type, undefined: false, null: false, hole: false, foreign: true, missing: false, absent: false, given: false, untyped: false, observed: false, typeObserved: false };
		}
		return null;
	},

	/** A held variable, parameter or binding read by name, or a held member read (`heldMember`). */
	heldSource(this: ValueStates, e: ts.Identifier | ts.PropertyAccessExpression): boolean {
		if (ts.isPropertyAccessExpression(e)) return this.heldMember(e.name);
		const d = this.checker.getSymbolAtLocation(e)?.valueDeclaration;
		return !!d && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)) && this.nullish().held.has(d) && !this.untypedDeclaration(d);
	},

	/** The type a condition's own test establishes for `r` where it holds, through `&&` and parentheses. */
	testedType(this: ValueStates, cond: ts.Expression, r: ts.Expression): ts.Type | null {
		const c = ts.skipOuterExpressions(cond, ts.OuterExpressionKinds.Parentheses);
		if (!ts.isBinaryExpression(c)) return null;
		const op = c.operatorToken.kind;
		if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.testedType(c.right, r) ?? this.testedType(c.left, r);
		if (op === ts.SyntaxKind.InstanceOfKeyword) {
			if (!sameReference(c.left, r, this.checker)) return null;
			const cls = this.checker.getSymbolAtLocation(c.right)?.valueDeclaration;
			return cls && ts.isClassDeclaration(cls) && !cls.getSourceFile().isDeclarationFile && !this.packaged(cls) ? this.checker.getTypeAtLocation(cls.name ?? cls) : null;
		}
		if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsToken) return null;
		const [test, lit] = ts.isTypeOfExpression(ts.skipOuterExpressions(c.left)) ? [ts.skipOuterExpressions(c.left), c.right] : [ts.skipOuterExpressions(c.right), c.left];
		if (!ts.isTypeOfExpression(test) || !ts.isStringLiteralLike(lit) || !sameReference(test.expression, r, this.checker)) return null;
		return lit.text === 'string' ? this.checker.getStringType() : lit.text === 'number' ? this.checker.getNumberType() : lit.text === 'boolean' ? this.checker.getBooleanType() : null;
	},

	/**
	 * A held value's member typed as a class's instance, whose method is called (`nav.bar.setVisibility(…)`): read as that
	 * class, as a destructuring of it is, so the call is the class's own; read by name, an app class's method is not found.
	 */
	classMethodReceiver(this: ValueStates, n: ts.PropertyAccessExpression): boolean {
		const p = n.parent;
		if (!ts.isPropertyAccessExpression(p) || p.expression !== n || !ts.isCallExpression(p.parent) || p.parent.expression !== p) return false;
		const sym = this.checker.getNonNullableType(this.checker.getTypeAtLocation(n)).getSymbol();
		return !!sym && !!(sym.flags & ts.SymbolFlags.Class) && !!this.checker.getSymbolAtLocation(p.name)?.declarations?.some((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d));
	},

	/** A member name read of a field, getter or parameter property held untyped for its foreign value. */
	heldMember(this: ValueStates, name: ts.MemberName): boolean {
		const b = this.backend;
		if (b.library || b.lenient) return false;
		const d = accessedDeclaration(this.checker.getSymbolAtLocation(name));
		return !!d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isGetAccessorDeclaration(d) || ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d) || (ts.isParameter(d) && ts.isParameterPropertyDeclaration(d, d.parent))) && this.nullish().held.has(d);
	},
};

export type ReadsMethods = typeof readsMethods;
