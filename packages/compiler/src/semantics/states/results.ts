// Widened results: a function's result that may be empty where its declared type says a value, and the contexts that widen it.
import ts from 'typescript';
import { mentionsTypeParameter, truthyAt } from './predicates.ts';
import type { Form } from '../forms/forms.ts';
import { isTemplateMethod } from '../trust.ts';
import { alwaysEnds } from '../lang.ts';
import { isAsync } from '../throws.ts';
import type { ValueStates } from './value-states.ts';

export const resultsMethods = {
	widened(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend;
		if (!this.formDecides(p)) return false;
		let found = this.widenedParams.get(p);
		if (found === undefined) this.widenedParams.set(p, (found = (b.ledger.checkedParameters || b.nullableParameter(b.typeOf(p.name))) && this.givenEmpty(p)));
		return found;
	},

	/**
	 * An app function's result whose form holds null or undefined its declared type leaves out: a value its returns may
	 * leave missing (an element past the end, `find`, `Map.get`, a record's entry, a widened call's result, an untyped
	 * value) or, in non-strict code, `return null`/`return undefined`. The form is its group's (overrides, the interface
	 * member or function type it is given for), so every place that spells a member of the group asks this. Not for a
	 * result typed by a type parameter, an async function's or generator's, or one whose group holds a fixed
	 * point (a kit's or platform's callback type), nor one a front end writes for a template (`$b…`, `$e…`),
	 * whose only reader is the template glue. A result whose type already holds null or undefined keeps the empty state
	 * it is held with.
	 */
	widenedResult(this: ValueStates, fn: ts.SignatureDeclaration): boolean {
		const b = this.backend;
		if (b.library || b.lenient || ts.isJSDocSignature(fn as ts.Node) || fn.getSourceFile().isDeclarationFile || this.packaged(fn) || !this.appCode(fn)) return false;
		if (ts.isConstructorDeclaration(fn) || ts.isAccessor(fn) || isAsync(fn) || (fn as ts.FunctionLikeDeclaration).asteriskToken || isTemplateMethod(fn)) return false;
		let found = this.widenedResults.get(fn);
		if (found !== undefined) return found;
		found = false;
		// A literal given for a library's callback whose result is a type parameter (`map`'s `U`).
		const context = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? this.checker.getContextualType(fn)?.getNonNullableType().getCallSignatures()[0]?.getDeclaration() : undefined;
		const contextResult = context && !ts.isJSDocSignature(context) && context.getSourceFile().isDeclarationFile ? this.checker.getSignatureFromDeclaration(context)?.getReturnType() : undefined;
		if (contextResult && mentionsTypeParameter(this.checker, contextResult)) {
			this.widenedResults.set(fn, false);
			return false;
		}
		const t = this.checker.getSignatureFromDeclaration(fn)?.getReturnType();
		const none = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
		// A boolean's undefined reads as false wherever a boolean is tested, which a library's callback (`filter`) does.
		if (t && !(t.flags & (none | ts.TypeFlags.BooleanLike)) && !(t.isUnion() && t.types.some((u) => u.flags & none)) && !mentionsTypeParameter(this.checker, t)) {
			const forms = this.forms();
			if (!forms.fixedSlot(fn)) {
				const declared = forms.declaredForm(fn),
					form = forms.formOfSlot(fn);
				found = !declared.foreign && !form.foreign && ((form.null && !declared.null) || (form.undefined && !declared.undefined));
				// A function declaration is its group's only member with a body; what its returns give after their guards decides.
				if (found && ts.isFunctionDeclaration(fn) && fn.body) found = this.returnsGiveEmpty(fn, declared);
			}
		}
		this.widenedResults.set(fn, found);
		return found;
	},

	/**
	 * Whether a function's own returns may give null or undefined `declared` leaves out. A name a guard has tested truthy
	 * where it is returned (`if (!x) throw …; return x`, `if (x) return x`) gives its value, which the form, blind to
	 * narrowing, counts empty.
	 */
	returnsGiveEmpty(this: ValueStates, fn: ts.FunctionDeclaration, declared: Form): boolean {
		let empty = false;
		if (!alwaysEnds(fn.body!)) empty = !declared.undefined;
		const gives = (e: ts.Expression): boolean => {
			e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
			if (ts.isConditionalExpression(e)) return gives(e.whenTrue) || gives(e.whenFalse);
			if (ts.isCallExpression(e) && this.checker.getResolvedSignature(e)?.getDeclaration() === fn) return false;
			if (truthyAt(e, e, this.checker)) return false;
			const f = this.forms().formOf(e);
			return (f.null && !declared.null) || (f.undefined && !declared.undefined) || f.foreign;
		};
		const visit = (n: ts.Node): void => {
			if (empty || (n !== fn.body && ts.isFunctionLike(n))) return;
			if (ts.isReturnStatement(n)) {
				if (!n.expression) {
					empty ||= !declared.undefined;
					return;
				}
				empty ||= gives(n.expression);
				return;
			}
			ts.forEachChild(n, visit);
		};
		visit(fn.body!);
		return empty;
	},

	/** A widened result (`widenedResult`) whose only empty state is null: its nil is null. */
	nullOnlyResult(this: ValueStates, fn: ts.SignatureDeclaration): boolean {
		if (!this.widenedResult(fn)) return false;
		const form = this.forms().formOfSlot(fn);
		return form.null && !form.undefined;
	},

	/** A function literal typed by nothing of its own (`() => null`, non-strict) given for a widened function type: that type. */
	widenedContext(this: ValueStates, fn: ts.SignatureDeclaration): ts.SignatureDeclaration | null {
		if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.type) return null;
		const own = this.checker.getSignatureFromDeclaration(fn)?.getReturnType();
		if (!own || !(own.flags & (ts.TypeFlags.Any | ts.TypeFlags.Null | ts.TypeFlags.Undefined))) return null;
		const ctx = this.checker.getContextualType(fn)?.getNonNullableType().getCallSignatures()[0]?.getDeclaration();
		return ctx && !ts.isJSDocSignature(ctx) && this.widenedResult(ctx) ? ctx : null;
	},
};

export type ResultsMethods = typeof resultsMethods;
