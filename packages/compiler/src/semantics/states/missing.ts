// A value missing at a read: held types and optionals, spreads that may be empty, narrowed or observed reads and widened objects.
import ts from 'typescript';
import { assigned, assignedParameter, fieldLike } from './predicates.ts';
import type { Held } from '../conversion.ts';
import { givenBy, reassigned } from '../nullish.ts';
import { accessedDeclaration } from '../lang.ts';
import { isWriteTarget } from '../ast.ts';
import type { ValueStates } from './value-states.ts';

export const missingMethods = {
	/**
	 * The receiver of a member read, call or index whose value is a string, number or boolean the program may leave
	 * missing at this read though its type says present: JavaScript's TypeError there (`reading 'k'`). Answered from the
	 * read's kind and the value's form: an array's element or a string's character, a record's entry, `Map.get`,
	 * `pop`/`shift`/`find`/`findLast`/`at`, `x!`, a non-strict optional parameter or member, and a name or call the backend
	 * holds optional. An over-answer costs a check that passes. Answered in library code and the app's strict code, not
	 * in a lenient app's: its conversions can leave missing a value JavaScript has (a wrong-class object).
	 */
	missingAtRead(this: ValueStates, target: ts.Expression): 'undefined' | 'null' | null {
		const b = this.backend,
			c = this.checker;
		let outer: ts.Node = target;
		while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
		const p = outer.parent;
		if (!p || !(ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) || p.expression !== outer || p.questionDotToken || assigned(p)) return null;
		const x = ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses);
		const libraryResult = this.libraryResultMissing(x);
		if (libraryResult) return libraryResult;
		if (!b.library && (b.lenient || !this.appCode(target))) return null;
		// A held slot's read is untyped, or narrowed by a test of its type to a present value (`narrowedRead`).
		if ((ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) && this.heldSource(x)) return null;
		if (this.narrowedMissing(x)) return 'undefined';
		if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && this.missingObject(x)) return 'undefined';
		const untyped = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
		const primitive = (t: ts.Type) => !(t.flags & untyped) && !!(c.getNonNullableType(t).flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike));
		const empty = (t: ts.Type) => ((t.isUnion() ? t.types : [t]).some((u) => u.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) ? 'undefined' : (t.isUnion() ? t.types : [t]).some((u) => u.flags & ts.TypeFlags.Null) ? 'null' : null);
		const strict = b.trust.strictFile(x.getSourceFile());
		if (ts.isNonNullExpression(x)) {
			const t = c.getTypeAtLocation(x.expression);
			if (!primitive(t)) return null;
			if (strict) return empty(t);
			const f = this.forms().formOf(x.expression);
			return f.undefined ? 'undefined' : f.null ? 'null' : null;
		}
		const t = c.getTypeAtLocation(x);
		const recvType = (e: ts.Expression) => c.getNonNullableType(c.getTypeAtLocation(e));
		const record = (e: ts.Expression) => {
			const r = recvType(e);
			return !c.isArrayType(r) && !c.isTupleType(r) && !(r.flags & ts.TypeFlags.StringLike) && c.getIndexInfosOfType(r).length > 0;
		};
		// An object-valued record's entry: undefined for a key never set, whatever its value type.
		const entryRead = ts.isElementAccessExpression(x) || (ts.isPropertyAccessExpression(x) && !c.getSymbolAtLocation(x.name)?.valueDeclaration);
		const objectEntry = entryRead && !x.questionDotToken && !(t.flags & (untyped | ts.TypeFlags.TypeParameter)) && !primitive(t) && !empty(t) && record(x.expression);
		if (objectEntry) return this.forms().formOf(x).undefined ? 'undefined' : null;
		// A loop variable or callback parameter taking a container's optional elements (`optionalBinding`).
		if (ts.isIdentifier(x) && !primitive(t) && !empty(t) && !(t.flags & (untyped | ts.TypeFlags.TypeParameter))) {
			const name = (c.getSymbolAtLocation(x)?.valueDeclaration as ts.NamedDeclaration | undefined)?.name;
			if (name && ts.isIdentifier(name) && this.optionalBinding(name)) return 'undefined';
		}
		if (!primitive(t) && !empty(t) && !(t.flags & (untyped | ts.TypeFlags.TypeParameter)) && !(x.flags & ts.NodeFlags.OptionalChain) && !t.getCallSignatures().length) {
			const given = this.widenedObject(x);
			if (given) return given;
			const emptied = this.presentTypedEmpty(x);
			if (emptied) return emptied;
		}
		if (!primitive(t) || empty(t) || x.flags & ts.NodeFlags.OptionalChain) return null;
		// A name declared untyped reads as a string, number or boolean only past a test of its type.
		if (ts.isIdentifier(x)) {
			const sym = c.getSymbolAtLocation(x);
			if (sym && c.getTypeOfSymbol(sym).flags & untyped) return null;
		}
		const form = this.forms().formOf(x);
		if (!form.undefined) return null;
		if (ts.isElementAccessExpression(x)) {
			const r = recvType(x.expression);
			return (c.isArrayType(r) && !c.isTupleType(r)) || !!(r.flags & ts.TypeFlags.StringLike) || record(x.expression) ? 'undefined' : null;
		}
		if (ts.isPropertyAccessExpression(x)) {
			const d = c.getSymbolAtLocation(x.name)?.valueDeclaration;
			if (!d || ts.isIndexSignatureDeclaration(d) || ts.isMappedTypeNode(d)) return record(x.expression) ? 'undefined' : null;
			if ((ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && this.looseSlots.has(d)) return 'undefined';
			return !strict && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && !!d.questionToken ? 'undefined' : null;
		}
		if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && !x.questionDotToken) {
			const r = recvType(x.expression.expression),
				name = x.expression.name.text;
			if ((c.isArrayType(r) && ['find', 'findLast', 'pop', 'shift', 'at'].includes(name)) || (['Map', 'ReadonlyMap'].includes(r.getSymbol()?.name ?? '') && name === 'get')) return 'undefined';
		}
		if (ts.isIdentifier(x) && !strict) {
			const d = c.getSymbolAtLocation(x)?.valueDeclaration;
			if (d && ts.isParameter(d) && d.questionToken && !d.initializer) return 'undefined';
		}
		return (ts.isIdentifier(x) || ts.isCallExpression(x)) && b.shapes.question(() => this.heldOptional(x)) ? 'undefined' : null;
	},

	/** What the backend holds `x`'s value as (`placement`'s `from`), keeping nothing that spelling types on the way would emit. */
	heldType(this: ValueStates, x: ts.Expression): Held {
		return this.backend.shapes.question(() => this.backend.heldType(x));
	},

	/**
	 * Whether the backend holds what `x` reads optional or untyped, whatever TypeScript types it: the one answer for an
	 * absent read, a chain's links and heads, and a receiver's check, on both backends.
	 */
	heldOptional(this: ValueStates, x: ts.Expression): boolean {
		return this.backend.heldType(x).rep !== 'present';
	},

	/** A spread operand that may be undefined or null, which spreads nothing: its type says so, or non-strict code declares it optional. */
	spreadMayBeEmpty(this: ValueStates, e: ts.Expression): boolean {
		const c = this.checker,
			t = c.getTypeAtLocation(e);
		if (c.getNonNullableType(t) !== t) return true;
		if (!this.backend.lenient && !this.backend.lenientApp) return false;
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		const d = (ts.isPropertyAccessExpression(e) ? c.getSymbolAtLocation(e.name) : ts.isIdentifier(e) ? c.getSymbolAtLocation(e) : undefined)?.valueDeclaration;
		return !!d && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d) || ts.isParameter(d)) && !!d.questionToken;
	},

	/**
	 * A variable or parameter read the checker narrows to present though it may hold the program's own missing value
	 * there: an assignment narrows to the assigned value's type, which a read past an array's end or a record's entry
	 * types present. A name no assignment narrows (a parameter never assigned, a variable never reassigned whose
	 * initializer's type keeps the empty state) is narrowed by a guard only, and isn't answered.
	 */
	narrowedMissing(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend,
			c = this.checker;
		if (b.library || b.lenient || !ts.isIdentifier(e) || isWriteTarget(e) || !this.appCode(e) || !b.trust.strictFile(e.getSourceFile())) return false;
		const sym = c.getSymbolAtLocation(e),
			d = sym?.valueDeclaration;
		if (!sym || !d || !(ts.isVariableDeclaration(d) || ts.isParameter(d)) || d.getSourceFile().isDeclarationFile) return false;
		const empty = (t: ts.Type) => (t.isUnion() ? t.types : [t]).some((u) => u.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void));
		if (!empty(c.getTypeOfSymbol(sym)) || empty(c.getTypeAtLocation(e))) return false;
		if (ts.isParameter(d) ? !assignedParameter(d, c) : !reassigned(d, c) && (!d.initializer || empty(c.getTypeAtLocation(d.initializer)))) return false;
		const form = this.forms().formOfSlot(d);
		return form.undefined && form.absent;
	},

	/**
	 * A read JavaScript takes as it is, missing or not: a test of its truth, `typeof`, `!`, an operand of an equality or
	 * identity comparison, `instanceof`'s left, `??`'s left, `?.`'s receiver, and a `??`, `&&` or `||` right operand or a
	 * `?:` branch whose whole is read so. A missing object here is neither unwrapped nor required present.
	 */
	observedAsIs(this: ValueStates, e: ts.Expression): boolean {
		let n: ts.Node = e;
		while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
		const p = n.parent,
			K = ts.SyntaxKind;
		if (!p) return false;
		if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === n) return true;
		if (ts.isForStatement(p) && p.condition === n) return true;
		if (ts.isConditionalExpression(p)) return p.condition === n || this.observedAsIs(p);
		if (ts.isTypeOfExpression(p) || (ts.isPrefixUnaryExpression(p) && p.operator === K.ExclamationToken)) return true;
		if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === n) return !!p.questionDotToken;
		if (!ts.isBinaryExpression(p)) return false;
		const op = p.operatorToken.kind;
		if ([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(op)) return true;
		if (op === K.InstanceOfKeyword) return p.left === n;
		if ([K.QuestionQuestionToken, K.AmpersandAmpersandToken, K.BarBarToken].includes(op)) return p.left === n || this.observedAsIs(p);
		return false;
	},

	/**
	 * A read of an object strict app code types present that may be the program's own missing value there (its form
	 * undefined and absent: a read past an array's end, a record's entry never set, a slot such a value reaches). `typeof`
	 * reads such an object as it is; where the backend holds it present it never is missing.
	 */
	missingObject(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend,
			c = this.checker;
		if (b.library || b.lenient || b.lenientApp || !this.appCode(e) || !b.trust.strictFile(e.getSourceFile())) return false;
		const t = c.getTypeAtLocation(e);
		const parts = t.isUnion() ? t.types : [t];
		const notObject = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike;
		if (parts.some((u) => u.flags & notObject || u.getCallSignatures().length)) return false;
		const form = this.forms().formOf(e);
		return form.undefined && form.absent;
	},

	/**
	 * A non-strict app's variable, parameter or field its type says holds an object, that the program gives null or
	 * undefined (`Form.given`: `const item: Item = null`, a field never assigned): held as the optional its type lets the
	 * backend hold. An injected service, a template's parameter and a field only ever assigned a value are present.
	 */
	presentTypedEmpty(this: ValueStates, x: ts.Expression): 'undefined' | 'null' | null {
		const b = this.backend;
		if (b.library || b.lenient || !(ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) || (ts.isPropertyAccessExpression(x) && x.questionDotToken) || b.trust.strictFile(x.getSourceFile())) return null;
		const d = accessedDeclaration(this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x));
		const slot = !!d && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d));
		if (!slot || d.getSourceFile().isDeclarationFile || !this.appCode(d)) return null;
		const f = this.forms().formOf(x);
		if (!f.given) return null;
		return f.undefined ? 'undefined' : f.null ? 'null' : null;
	},

	/**
	 * A non-strict app's field its type says holds an object, declared without a value, that a read may find unset:
	 * undefined, never null there, so `typeof` tells it by its presence.
	 */
	typedUnset(this: ValueStates, x: ts.Expression): boolean {
		const b = this.backend;
		if (b.library || b.lenient || !ts.isPropertyAccessExpression(x) || x.questionDotToken || b.trust.strictFile(x.getSourceFile())) return false;
		const d = accessedDeclaration(this.checker.getSymbolAtLocation(x.name));
		if (!d || !ts.isPropertyDeclaration(d) || d.initializer || d.getSourceFile().isDeclarationFile || !this.appCode(d)) return false;
		const f = this.forms().formOf(x);
		return f.undefined && !f.null;
	},

	/**
	 * An object a `widenedResult` gives: its call, or a variable such calls are given to that the backend holds optional.
	 * Its empty state: null where every such result holds null only.
	 */
	widenedObject(this: ValueStates, x: ts.Expression): 'undefined' | 'null' | null {
		const results = (e: ts.Expression): ts.SignatureDeclaration[] => {
			if (ts.isAwaitExpression(e)) {
				const inner = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
				if (!ts.isCallExpression(inner)) return [];
				const d = this.checker.getResolvedSignature(inner)?.getDeclaration();
				return d && !ts.isJSDocSignature(d) && (this.lenientAsync(d) || !this.appCode(d)) ? [d] : [];
			}
			if (!ts.isCallExpression(e)) return [];
			const d = this.checker.getResolvedSignature(e)?.getDeclaration();
			return d && !ts.isJSDocSignature(d) && this.widenedResult(d) ? [d] : [];
		};
		let fns = results(x);
		if (ts.isIdentifier(x)) {
			const d = this.checker.getSymbolAtLocation(x)?.valueDeclaration;
			if (!d || !ts.isVariableDeclaration(d)) return null;
			let found = this.widenedGiven.get(d);
			if (!found) {
				const all: ts.SignatureDeclaration[] = [];
				givenBy(d, this.checker, (v) => {
					all.push(...results(v));
					return false;
				});
				this.widenedGiven.set(d, (found = all));
			}
			fns = found.length && this.backend.shapes.question(() => this.backend.declaredOptional(x)) ? found : [];
		}
		return !fns.length ? null : fns.every((f) => this.nullOnlyResult(f)) ? 'null' : 'undefined';
	},

	/** Strict code's declaration holding a string, number or boolean an untrusted value is placed in (see `looseSlots`). */
	looseDeclaration(this: ValueStates, n: ts.Node | undefined): boolean {
		const b = this.backend;
		if (b.library || !n) return false;
		let d: ts.Node | undefined = n;
		if (b.ledger.looseReads) {
			const named = ts.isPropertyAccessExpression(n) ? n.name : ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertySignature(n) || ts.isBindingElement(n) ? n.name : n;
			if (!ts.isIdentifier(named) && !ts.isPrivateIdentifier(named)) return false;
			d = (this.checker.getSymbolAtLocation(named) ?? b.resolve(named))?.valueDeclaration;
			if (!d) return false;
		}
		return this.looseSlots.has(d as ts.Declaration) || (ts.isParameter(d) && this.scriptCalledParameter(d)) || !!this.parameterChecks()?.unsetElement(d) || (!b.ledger.looseReads && this.widenedFieldRead(n));
	},

	/** A read (or the declaration) of a `widenedField`, where reads aren't resolved to their slot for `looseSlots`. */
	widenedFieldRead(this: ValueStates, n: ts.Node): boolean {
		const named = ts.isPropertyAccessExpression(n) ? n.name : ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) || ts.isParameter(n) ? n.name : n;
		if (!ts.isIdentifier(named)) return false;
		const d = (this.checker.getSymbolAtLocation(named) ?? this.backend.resolve(named))?.valueDeclaration;
		return !!d && fieldLike(d) && this.widenedField(d);
	},
};

export type MissingMethods = typeof missingMethods;
