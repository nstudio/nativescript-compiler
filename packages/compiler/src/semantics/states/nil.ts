// Null against undefined at a read: whether nil reads as null or as undefined, defaults of bindings and parts, nulled reads and nullish elements.
import ts from 'typescript';
import { bothEmpty, onlyNull } from './predicates.ts';
import { ONE_ELEMENT } from '../forms/flow.ts';
import { assignedByArrayPattern, assignedInOtherFunction } from '../nullish.ts';
import { admitsUndefined } from '../lang.ts';
import { notedField } from '../shapes.ts';
import { isWriteTarget } from '../ast.ts';
import { isStatic } from '../throws.ts';
import { writtenFlag } from './lenient.ts';
import type { PartDefault, NulledRead, ValueStates } from './value-states.ts';

export const nilMethods = {
	/**
	 * Strict code's value typed `T | null` (or narrowed to null), held as an optional: its empty value is null, as its type
	 * has no undefined. A field without an initializer is undefined until assigned, whatever its type says. Lenient code's
	 * types say neither: its `lenientNullField` reads and library code's `libraryNull` values.
	 */
	nilIsNull(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend;
		const bare = ts.skipOuterExpressions(e);
		if ((b.library || b.lenientApp) && ts.isPropertyAccessExpression(bare) && this.lenientNullField(bare)) return !this.unsetNullField(bare);
		if (b.library) return this.libraryNull(e);
		if (b.lenient || b.library || this.plugin(e)) return false;
		if (b.lenientApp && (this.nullResult(bare) || (ts.isIdentifier(bare) && this.nullVars.has(b.resolve(bare)!)))) return true;
		if (bare.kind === ts.SyntaxKind.NullKeyword || !onlyNull(this.checker.getTypeAtLocation(e)) || this.heldNullish(bare)) return false;
		if (this.nullBranches(bare)) return false;
		if (ts.isIdentifier(bare)) {
			const d = b.resolve(bare)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && !onlyNull(this.checker.getTypeAtLocation(d.name)) && (assignedInOtherFunction(d, this.checker) || assignedByArrayPattern(d, this.checker))) return false;
		}
		if (ts.isPropertyAccessExpression(bare)) {
			const d = this.checker.getSymbolAtLocation(bare.name)?.valueDeclaration;
			if (d && ((ts.isPropertyDeclaration(d) && !d.initializer) || this.nullish().fields.has(d) || (this.widenedField(d) && this.forms().formOfSlot(d).undefined))) return false;
		}
		return true;
	},

	/** `partDefault` of a binding element's default: the part its pattern reads of the value it destructures. */
	bindingDefault(this: ValueStates, el: ts.BindingElement): PartDefault {
		if (!el.initializer) return 'empty';
		const pattern = el.parent,
			name = el.propertyName ?? el.name;
		const key = ts.isArrayBindingPattern(pattern) ? pattern.elements.indexOf(el) : ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
		return this.partDefault(el, this.checker.getTypeAtLocation(pattern), key);
	},

	/**
	 * What a destructuring default meets in the part of `source` it reads (`key`: a property's name or an element's index),
	 * where JavaScript applies it to undefined alone. A part strict code types as null and not undefined holds null in its
	 * empty value; one typed with both is read by its key, untyped, to tell them apart.
	 */
	partDefault(this: ValueStates, at: ts.Node, source: ts.Type, key: string | number | null): PartDefault {
		const b = this.backend;
		if (b.lenient || b.library || this.plugin(at) || key === null) return 'empty';
		const c = this.checker;
		const whole = c.getNonNullableType(source);
		const array = typeof key === 'number' && !c.isTupleType(whole);
		let part: ts.Type | undefined;
		if (typeof key === 'string') {
			const prop = whole.getProperty(key);
			if (!prop) return 'empty';
			// A field without an initializer is undefined until assigned, whatever its type says.
			const d = prop.valueDeclaration;
			if (d && ts.isPropertyDeclaration(d) && !d.initializer) return 'empty';
			part = c.getTypeOfSymbolAtLocation(prop, at);
		} else part = c.isTupleType(whole) ? c.getTypeArguments(whole as ts.TypeReference)[key] : c.isArrayType(whole) ? c.getTypeArguments(whole as ts.TypeReference)[0] : undefined;
		if (!part) return 'empty';
		if (onlyNull(part)) return array ? 'element' : 'never';
		return !array && typeof key === 'string' && bothEmpty(part) ? 'keyed' : 'empty';
	},

	/** Strict code's value typed `T | undefined`, or a call of a widened result holding no null, held as an optional: its empty value is undefined, never null. */
	nilIsUndefined(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend;
		if (b.lenient || b.library || this.plugin(e)) return false;
		const bare = ts.skipOuterExpressions(e);
		const d = ts.isCallExpression(bare) ? this.checker.getResolvedSignature(bare)?.getDeclaration() : undefined;
		if (d && !ts.isJSDocSignature(d) && this.widenedResult(d) && !this.forms().formOfSlot(d).null) return true;
		if (b.lenientApp) return false;
		const t = this.checker.getTypeAtLocation(e);
		const parts = t.isUnion() ? t.types : [t];
		return parts.some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) && !parts.some((x) => x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	},

	/**
	 * A number held optional, read as an arithmetic operand: its untyped read where only that tells undefined from null
	 * (`unsetNullField`), or whether its nil is null (0) rather than undefined (NaN).
	 */
	heldNumberNil(this: ValueStates, e: ts.Expression, code: () => string): { keyed: string } | { isNull: boolean } {
		const keyed = this.unsetNullField(e) && this.nullableEntry(e, code);
		return keyed ? { keyed } : { isNull: this.nilIsNull(e) };
	},

	/**
	 * `nulledRead`'s value read untyped. `code` builds the value's untyped translation; call it only when needed, since
	 * building it changes how later reads compile.
	 */
	nullableEntry(this: ValueStates, e: ts.Expression, code: () => string): string | null {
		const read = this.nulledRead(e);
		return read && this.backend.nulledEntry(read, code);
	},

	/**
	 * An array element or Map value of strict code's `T | null` values, or a field noted null, whose untyped read tells
	 * null from undefined, where its optional alone does not: missing is undefined, an empty value held null.
	 */
	nulledRead(this: ValueStates, e: ts.Expression): NulledRead | null {
		const b = this.backend;
		const bare = ts.skipOuterExpressions(e);
		if (this.unsetNullField(bare)) {
			const d = this.checker.getSymbolAtLocation(bare.name)?.valueDeclaration;
			return d && ts.isPropertyDeclaration(d) && isStatic(d) ? { kind: 'static', read: bare, name: bare.name.text, flag: writtenFlag(bare.name.text) } : { kind: 'field', read: bare, name: bare.name.text };
		}
		if (b.lenient || b.library || this.plugin(e)) return null;
		const held = (t: ts.Type, k: number): ts.Type | undefined => this.checker.getTypeArguments(t as ts.TypeReference)?.[k];
		if (ts.isElementAccessExpression(bare)) {
			const t = this.checker.getTypeAtLocation(bare.expression),
				el = !bare.questionDotToken && this.checker.isArrayType(t) ? held(t, 0) : undefined;
			return el && onlyNull(el) ? { kind: 'element', read: bare } : null;
		}
		if (ts.isCallExpression(bare)) {
			const callee = bare.expression;
			if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || callee.name.text !== 'get' || bare.arguments.length !== 1) return null;
			const t = this.checker.getTypeAtLocation(callee.expression),
				value = t.getSymbol()?.name === 'Map' ? held(t, 1) : undefined;
			return value && onlyNull(value) ? { kind: 'entry', read: bare } : null;
		}
		if (!ts.isPropertyAccessExpression(bare) || isWriteTarget(bare)) return null;
		// An optional field that may hold null or undefined: the literal's shape notes which (`jsNulls`), read by key. Through
		// `?.` too: the chain is undefined only where its base is empty, otherwise the field's value, null included.
		const chained = !!bare.questionDotToken;
		const name = notedField(this, bare, chained) ? bare.name.text : this.nullishShapeField(bare, false, chained);
		return name ? { kind: 'field', read: bare, name } : null;
	},

	/**
	 * A conditional whose one branch gives null and whose other may give an undefined its type doesn't say
	 * (`i < 0 ? null : NAMES[i]`): its one nil can't tell them apart, so each branch is converted, or noted, on its own.
	 */
	nullBranches(this: ValueStates, e: ts.Expression): { cond: ts.ConditionalExpression; nulls: ts.Expression[] } | null {
		const b = this.backend;
		if (b.lenient || b.library || this.plugin(e)) return null;
		const bare = ts.skipOuterExpressions(e);
		if (!ts.isConditionalExpression(bare)) return null;
		const branches = [bare.whenTrue, bare.whenFalse];
		const nulls = branches.filter((x) => ts.skipOuterExpressions(x).kind === ts.SyntaxKind.NullKeyword || this.nilIsNull(x));
		return nulls.length && branches.some((x) => !nulls.includes(x) && !admitsUndefined(this.checker.getTypeAtLocation(x)) && this.forms().formOf(x).undefined) ? { cond: bare, nulls } : null;
	},

	/** A typed value whose untyped read tells null from undefined, where its optional alone does not. */
	nullDistinct(this: ValueStates, e: ts.Expression): boolean {
		return this.nilIsNull(e) || !!this.nullishRead(e) || this.nullishElementRead(e) || !!this.nulledRead(e);
	},

	/**
	 * A read of one element or value of an array, Set or Map whose elements are held as `JSNullish<T>` (`nullishElements`):
	 * an index, `at`/`find`/`pop`/…, a Map's `get`.
	 */
	nullishElementRead(this: ValueStates, e: ts.Expression): boolean {
		const bare = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (ts.isElementAccessExpression(bare)) return this.nullishElements(bare.expression);
		if (!ts.isCallExpression(bare) || !ts.isPropertyAccessExpression(bare.expression)) return false;
		const recv = bare.expression.expression,
			name = bare.expression.name.text;
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(recv));
		const one = this.checker.isArrayType(t) ? ONE_ELEMENT.has(name) : ['Map', 'ReadonlyMap'].includes(t.getSymbol()?.name ?? '') && name === 'get';
		return one && this.nullishElements(recv);
	},

	/** A `nullishElementRead` whose member is read or called: its `JSNullish<T>` read as the optional. */
	nullishElementReceiver(this: ValueStates, e: ts.Expression): boolean {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		return (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === x && this.nullishElementRead(e);
	},

	/**
	 * The element type an array literal is spelled with where its contextual type isn't an array: a `new Set(…)`'s, or the
	 * receiver's for `concat`, whatever the literal's own elements are (`[null]`).
	 */
	literalElementType(this: ValueStates, e: ts.ArrayLiteralExpression): ts.Type | null {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (ts.isNewExpression(p) && p.arguments?.[0] === x && ts.isIdentifier(p.expression) && p.expression.text === 'Set') {
			const t = this.checker.getTypeAtLocation(p);
			return t.getSymbol()?.name === 'Set' ? this.forms().elementOf(t) : null;
		}
		if (ts.isCallExpression(p) && p.arguments.includes(x as ts.Expression) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'concat') {
			const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(p.expression.expression));
			return this.checker.isArrayType(t) ? this.forms().elementOf(t) : null;
		}
		return null;
	},

	/** A member that may hold null or undefined both, by its type or as `nullishSlots` finds; written, one that may hold null. */
	nullishMember(this: ValueStates, e: ts.PropertyAccessExpression, write = false, chained = false): boolean {
		if ((e.questionDotToken && !chained) || e.expression.kind === ts.SyntaxKind.SuperKeyword) return false;
		const sym = this.checker.getSymbolAtLocation(e.name),
			d = sym?.valueDeclaration;
		if (d && ts.isPropertySignature(d) && (this.nullish().fields.has(d) || (this.widenedField(d) && this.forms().formOfSlot(d).null))) return true;
		// A chained read's type has the chain's undefined: the member's own type says whether it holds both.
		const parts = ((t) => (t.isUnion() ? t.types : [t]))(e.questionDotToken && sym ? this.checker.getTypeOfSymbol(sym) : this.checker.getTypeAtLocation(e));
		return parts.some((x) => x.flags & ts.TypeFlags.Null) && (write || parts.some((x) => x.flags & ts.TypeFlags.Undefined)) && !!d && (ts.isPropertySignature(d) || ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d));
	},

	/** An object type's field that may hold null or undefined, which its shape notes (`jsNulls`) and is read and written by key: its name. */
	nullishShapeField(this: ValueStates, e: ts.PropertyAccessExpression, write = false, chained = false): string | null {
		return this.nullishMember(e, write, chained) ? this.backend.optionalShapeField(e) : null;
	},
};

export type NilMethods = typeof nilMethods;
