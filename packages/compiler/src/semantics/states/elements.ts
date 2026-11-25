// Which empty states the elements of an array, Set or Map may hold, and how a read of one gives them.
import ts from 'typescript';
import { ELEMENT_CALLBACKS, isGeneric, isMatchArray } from '../forms/flow.ts';
import { representation } from '../forms/forms.ts';
import type { ValueStates } from './value-states.ts';
import { admitsUndefined, evolvingArrayType } from '../lang.ts';
import { bothEmpty } from './predicates.ts';
import { elementStoreOf } from '../placement.ts';
import { isAsync } from '../throws.ts';
import { rethrowUnlessRefused } from '../refusals.ts';
import { presentOf } from '../types.ts';
import { regexpMayLeaveGroupUnset } from '../regexp.ts';

export const elementsMethods = {
	/**
	 * An array, Set or Map (a declaration, its name, or an expression giving one) whose elements or values may be null or
	 * undefined both, which the program tells apart: its elements are held as `JSNullish<T>`.
	 */
	nullishElements(this: ValueStates, n: ts.Node): boolean {
		if (!this.nullish() || !this.nullishElementSet.size) return false;
		const d = ts.isIdentifier(n) && n.parent && (ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertySignature(n.parent)) && n.parent.name === n ? n.parent : n;
		if (!ts.isExpression(d) && !ts.isVariableDeclaration(d) && !ts.isParameter(d) && !ts.isPropertyDeclaration(d) && !ts.isPropertySignature(d) && !(ts.isFunctionLike(d) && !isAsync(d))) return false;
		const type = ts.isFunctionLike(d) ? this.checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration)?.getReturnType() : this.checker.getTypeAtLocation(ts.isExpression(d) ? d : ((d as ts.NamedDeclaration).name ?? d));
		// A record's values are held one nil, read as undefined.
		if (type && !this.checker.isArrayType(this.checker.getNonNullableType(type)) && !['Set', 'ReadonlySet', 'Map', 'ReadonlyMap'].includes(this.checker.getNonNullableType(type).getSymbol()?.name ?? '')) return false;
		const element = type && this.forms().elementOf(type);
		// A literal or a new Set is spelled as the slot it goes to, which a conditional or a call between hides from its own form.
		const to = (ts.isArrayLiteralExpression(d) || ts.isNewExpression(d)) && this.placement(d);
		if (to && this.nullishElements(to)) return true;
		if (!element || !bothEmpty(element)) return false;
		const form = ts.isExpression(d) ? this.forms().formOf(d) : this.forms().formOfSlot(d);
		return !!form.element && representation(form.element) === 'nullish';
	},

	/**
	 * An app's array, Set, Map or record (a declaration, its name, or an expression giving one) whose element type admits
	 * neither null nor undefined, but whose elements or values may be an undefined the program itself gives (an element
	 * past an array's end, a missing entry, a value it leaves out): its elements are held optional, nil read as undefined.
	 * One sharing its storage with a platform's or library's slot keeps the declared form.
	 */
	optionalElements(this: ValueStates, n: ts.Node): boolean {
		const b = this.backend;
		if (b.library || b.lenient) return false;
		let found = this.optionalElementSet.get(n);
		if (found === undefined) this.optionalElementSet.set(n, (found = this.holdsOptionalElements(n)));
		return found;
	},

	holdsOptionalElements(this: ValueStates, n: ts.Node): boolean {
		const d = ts.isIdentifier(n) && n.parent && (ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertySignature(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isShorthandPropertyAssignment(n.parent)) && n.parent.name === n ? n.parent : n;
		if (!ts.isExpression(d) && !ts.isVariableDeclaration(d) && !ts.isParameter(d) && !ts.isPropertyDeclaration(d) && !ts.isPropertySignature(d) && !ts.isPropertyAssignment(d) && !ts.isShorthandPropertyAssignment(d) && !(ts.isFunctionLike(d) && !isAsync(d))) return false;
		const file = d.getSourceFile() as ts.SourceFile | undefined;
		// A node the translation synthesizes has no file: it keeps the declared form.
		if (!file || file.isDeclarationFile || !this.appCode(d)) return false;
		if (ts.isElementAccessExpression(d) && !this.checker.isTupleType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(d.expression))) && this.optionalNestedElements(d.expression)) return true;
		// A read of what packaged or library code declares is held as that code spells it.
		if (ts.isExpression(d)) {
			const x = ts.skipOuterExpressions(d, ts.OuterExpressionKinds.Parentheses);
			const source = ts.isCallExpression(x) ? this.checker.getResolvedSignature(x)?.getDeclaration() : (ts.isPropertyAccessExpression(x) ? this.checker.getSymbolAtLocation(x.name) : ts.isIdentifier(x) ? this.checker.getSymbolAtLocation(x) : undefined)?.valueDeclaration;
			const splitUnset = ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'split' && !!x.arguments[0] && regexpMayLeaveGroupUnset(x.arguments[0], this.checker);
			if (source && !ts.isJSDocSignature(source) && (source.getSourceFile().isDeclarationFile || !this.appCode(source)) && !splitUnset) return false;
		}
		// A literal, a new collection, an assertion or a choice of them is spelled as the slot it goes to, whatever its own type
		// (`[untyped()]` is an `any[]`).
		const to = (ts.isArrayLiteralExpression(d) || ts.isObjectLiteralExpression(d) || ts.isNewExpression(d) || ts.isAsExpression(d) || ts.isTypeAssertionExpression(d) || ts.isConditionalExpression(d)) && this.placement(d);
		if (to) return this.optionalElements(to);
		// An evolving `const xs = []` is the `T[]` it is stated as where it goes.
		const stated = ts.isVariableDeclaration(d) ? evolvingArrayType(d, this.checker) : null;
		const type = stated ?? (ts.isFunctionLike(d) ? this.checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration)?.getReturnType() : ts.isPropertyAssignment(d) ? this.checker.getTypeAtLocation(d.initializer) : this.checker.getTypeAtLocation(ts.isExpression(d) ? d : ((d as ts.NamedDeclaration).name ?? d)));
		const element = type && this.forms().elementOf(type);
		if (!element || isGeneric(element) || element.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || admitsUndefined(element) || (element.isUnion() ? element.types : [element]).some((x) => x.flags & ts.TypeFlags.Null)) return false;
		if (ts.isExpression(d) && this.forms().untypedPlacements().has(ts.skipOuterExpressions(d, ts.OuterExpressionKinds.Parentheses))) return false;
		// A function literal's own slot is its result, as a declaration's is.
		const form = ts.isExpression(d) && !ts.isFunctionLike(d) ? this.forms().formOf(d) : this.forms().formOfSlot(d as ts.Declaration);
		const el = form.element;
		// Holes are held by the array itself (`JSArray.holes`), not as undefined elements. A foreign element keeps the
		// declared representation, checked where it enters, so it is held optional as well.
		// Nil is undefined only: elements the program may also give null keep the declared form.
		if (!el || !el.undefined || (el.null && !el.foreign) || el.hole || !(el.missing || el.absent || el.given)) return false;
		return !this.forms().elementsPinned(d as ts.Declaration | ts.Expression);
	},

	/** An app array of arrays (`string[][]`, e.g. `Object.values({ p: s.split(re) })`) whose inner elements hold undefined. */
	optionalNestedElements(this: ValueStates, n: ts.Node): boolean {
		const b = this.backend;
		if (b.library || b.lenient || this.nullishElements(n) || this.optionalElements(n)) return false;
		let found = this.optionalNestedElementSet.get(n);
		if (found === undefined) this.optionalNestedElementSet.set(n, (found = this.holdsOptionalNestedElements(n)));
		return found;
	},

	holdsOptionalNestedElements(this: ValueStates, n: ts.Node): boolean {
		const d = ts.isIdentifier(n) && n.parent && (ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertySignature(n.parent)) && n.parent.name === n ? n.parent : n;
		if (!ts.isExpression(d) && !ts.isVariableDeclaration(d) && !ts.isParameter(d) && !ts.isPropertyDeclaration(d) && !ts.isPropertySignature(d) && !(ts.isFunctionLike(d) && !isAsync(d))) return false;
		const file = d.getSourceFile() as ts.SourceFile | undefined;
		if (!file || file.isDeclarationFile || !this.appCode(d)) return false;
		if (ts.isExpression(d)) {
			const x = ts.skipOuterExpressions(d, ts.OuterExpressionKinds.Parentheses);
			const source = ts.isCallExpression(x) ? this.checker.getResolvedSignature(x)?.getDeclaration() : (ts.isPropertyAccessExpression(x) ? this.checker.getSymbolAtLocation(x.name) : ts.isIdentifier(x) ? this.checker.getSymbolAtLocation(x) : undefined)?.valueDeclaration;
			const objectValues = ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === 'Object' && x.expression.name.text === 'values';
			if (source && !ts.isJSDocSignature(source) && (source.getSourceFile().isDeclarationFile || !this.appCode(source)) && !objectValues) return false;
		}
		const type = ts.isFunctionLike(d) ? this.checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration)?.getReturnType() : this.checker.getTypeAtLocation(ts.isExpression(d) ? d : ((d as ts.NamedDeclaration).name ?? d));
		const outer = type && this.checker.isArrayType(this.checker.getNonNullableType(type)) ? this.forms().elementOf(type) : null;
		const inner = outer && this.checker.isArrayType(this.checker.getNonNullableType(outer)) ? this.forms().elementOf(outer) : null;
		if (!inner || isGeneric(inner) || inner.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || admitsUndefined(inner) || (inner.isUnion() ? inner.types : [inner]).some((x) => x.flags & ts.TypeFlags.Null)) return false;
		if (ts.isExpression(d) && this.forms().untypedPlacements().has(ts.skipOuterExpressions(d, ts.OuterExpressionKinds.Parentheses))) return false;
		const form = ts.isExpression(d) && !ts.isFunctionLike(d) ? this.forms().formOf(d) : this.forms().formOfSlot(d as ts.Declaration);
		const el = form.element?.element;
		if (!el || !el.undefined || (el.null && !el.foreign) || el.hole || !(el.missing || el.absent || el.given)) return false;
		return !this.forms().elementsPinned(d as ts.Declaration | ts.Expression);
	},

	/**
	 * An index or key read or write of a container `optionalElements` holds (`xs[i]`, `record[k]`, `record.key`): its
	 * value is the optional element, though the checker types it present.
	 */
	optionalElementRead(this: ValueStates, e: ts.Node): boolean {
		if (this.backend.library || this.backend.lenient || !e.parent) return false;
		if (ts.isElementAccessExpression(e)) return !this.checker.isTupleType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression))) && this.optionalElements(e.expression);
		if (!ts.isPropertyAccessExpression(e) || this.checker.getSymbolAtLocation(e.name)) return false;
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression));
		return !!(t.getStringIndexType() ?? t.getNumberIndexType()) && !t.getProperties().length && this.optionalElements(e.expression);
	},

	/** An array, Set or Map whose element or value nil is undefined only: held optional (`optionalElements`) or typed `T | undefined` without null. */
	elementNilIsUndefined(this: ValueStates, e: ts.Expression): boolean {
		if (this.backend.library || this.backend.lenient || !e.parent) return false;
		if (this.optionalElements(e)) return true;
		const el = this.forms().elementOf(this.checker.getTypeAtLocation(e));
		return !!el && admitsUndefined(el) && !(el.isUnion() ? el.types : [el]).some((x) => x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	},

	/**
	 * A loop variable or callback parameter that takes the elements or values of a container `optionalElements` holds:
	 * `x` of `for (const x of xs)` and of `xs.map((x) => …)`, `v` of `for (const [k, v] of map)` or of
	 * `Object.entries(record)`. Held optional.
	 */
	optionalBinding(this: ValueStates, name: ts.Identifier): boolean {
		if (this.backend.library || this.backend.lenient) return false;
		const d = name.parent;
		if (ts.isParameter(d) && d.name === name) return this.optionalElementParameter(d);
		if (ts.isVariableDeclaration(d) && d.name === name && ts.isForOfStatement(d.parent.parent)) return this.iteratesOptional(d.parent.parent.expression, false);
		if (!ts.isBindingElement(d) || d.name !== name || d.dotDotDotToken || !ts.isArrayBindingPattern(d.parent) || d.parent.elements.indexOf(d) !== 1) return false;
		const decl = d.parent.parent;
		return ts.isVariableDeclaration(decl) && ts.isForOfStatement(decl.parent.parent) && this.iteratesOptional(decl.parent.parent.expression, true);
	},

	/**
	 * An app's variable typed a string, number or boolean that the program gives an undefined its type leaves out (a value
	 * left out, a read past an array's end, an optional's undefined), or that starts with a value the platform or the kit
	 * may give as nil: held as the optional it may be, as JavaScript keeps it. A foreign value's form is checked where it
	 * enters, not here.
	 */
	optionalVariable(this: ValueStates, d: ts.Declaration): boolean {
		const b = this.backend;
		if (b.library || b.lenient || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || !d.initializer || !ts.isVariableStatement(d.parent.parent) || d.getSourceFile().isDeclarationFile || !this.appCode(d)) return false;
		let found = this.optionalVars.get(d);
		if (found === undefined) {
			const forms = this.forms(),
				form = forms.formOfSlot(d);
			this.optionalVars.set(d, (found = this.primitive(b.typeOf(d.name)) && !forms.declaredForm(d).undefined && ((form.undefined && !form.foreign && (form.missing || form.absent || form.given)) || this.primitiveNil(d.initializer))));
		}
		return found;
	},

	/** A string, number or boolean the platform's binding or the kit may give as nil (`Application.systemAppearance()`), through an assertion. */
	primitiveNil(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend;
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses | ts.OuterExpressionKinds.Assertions);
		if (!(ts.isCallExpression(x) || ts.isPropertyAccessExpression(x)) || ts.isOptionalChain(x)) return false;
		try {
			const d = ts.isCallExpression(x) ? this.checker.getResolvedSignature(x)?.getDeclaration() : this.checker.getSymbolAtLocation(x.name)?.valueDeclaration;
			const held = b.typeOf(x);
			if (!d || ts.isJSDocSignature(d) || held.implicit || !this.primitive(presentOf(held))) return false;
			return b.trust.nativeDeclaration(d) ? !!b.native?.holdsNil?.(d) : !!b.kitNil?.(x);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/**
	 * A string, number or boolean a declaration's array pattern binds from an array's element or an iterator's value, with
	 * no default (`const [a, b] = s.split(' ')`, `const [x, y] = gen()`): held as the optional its form says it may be
	 * (undefined past the end), in app and plugin code. A tuple's element is there, and a match's group is held so by the
	 * backends' own rule.
	 */
	arrayPiece(this: ValueStates, d: ts.Declaration): boolean {
		if (this.backend.library || !ts.isBindingElement(d) || !ts.isIdentifier(d.name) || d.initializer || d.dotDotDotToken || !ts.isArrayBindingPattern(d.parent)) return false;
		const decl = d.parent.parent;
		if (!ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isVariableStatement(decl.parent.parent)) return false;
		const c = this.checker,
			source = c.getNonNullableType(c.getTypeAtLocation(d.parent));
		const iterated = iteratedObject(source);
		if (c.isTupleType(source) || !(c.isArrayType(source) || iterated) || !this.primitive(this.backend.typeOf(d.name))) return false;
		const form = this.forms().formOfSlot(d);
		return form.undefined && form.missing;
	},

	/** A value stored as it is into a container `optionalElements` holds: by index or key, `push`/`unshift`/`set`/`add`, or as an array literal's element. */
	storedOptional(this: ValueStates, e: ts.Expression): boolean {
		if (!e.parent) return false;
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent) || (ts.isConditionalExpression(x.parent) && x.parent.condition !== x)) x = x.parent;
		const p = x.parent;
		if (ts.isBinaryExpression(p) && p.right === x && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return this.optionalElementRead(p.left);
		const store = elementStoreOf(this.checker, x as ts.Expression);
		return !!store && this.optionalElements(ts.isArrayLiteralExpression(store) ? store : (store.expression as ts.PropertyAccessExpression).expression);
	},

	/** A value an optional element takes as it is: stored into one (`storedOptional`), or searched for in a container `optionalElements` holds (`xs.indexOf(v)`). */
	optionalElementValue(this: ValueStates, e: ts.Expression): boolean {
		if (this.storedOptional(e)) return true;
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		return ts.isCallExpression(p) && p.arguments[0] === x && ts.isPropertyAccessExpression(p.expression) && ['indexOf', 'lastIndexOf', 'includes', 'has'].includes(p.expression.name.text) && this.optionalElements(p.expression.expression);
	},

	/** A binding whose value its scope stores as it is into a container `optionalElements` holds (`storedOptional`): held optional, as the element is. */
	storesOptional(this: ValueStates, name: ts.Identifier): boolean {
		if (this.backend.library || this.backend.lenient) return false;
		const sym = this.checker.getSymbolAtLocation(name);
		const scope = sym && ts.findAncestor(name.parent, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n));
		if (!scope) return false;
		const visit = (n: ts.Node): boolean => (ts.isIdentifier(n) && n !== name && this.checker.getSymbolAtLocation(n) === sym && this.storedOptional(n)) || !!ts.forEachChild(n, visit);
		return visit(scope);
	},

	/**
	 * A callback's element parameter, where the callback is a literal (or a choice of them) given to a container `optionalElements` holds:
	 * `x` of `xs.map((x) => …)`, `forEach`, `filter`, `find`…, the value of `map.forEach((v) => …)`, `reduce`'s element.
	 */
	optionalElementParameter(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const fn = p.parent;
		if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
		let x: ts.Node = fn;
		while (ts.isParenthesizedExpression(x.parent) || (ts.isConditionalExpression(x.parent) && x.parent.condition !== x)) x = x.parent;
		const call = x.parent;
		if (!ts.isCallExpression(call) || call.arguments[0] !== x || !ts.isPropertyAccessExpression(call.expression)) return false;
		const name = call.expression.name.text,
			recv = call.expression.expression;
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(recv));
		const kind = this.checker.isArrayType(t) ? 'Array' : (t.getSymbol()?.name ?? '');
		const k = fn.parameters.indexOf(p);
		const at = kind === 'Array' && ['reduce', 'reduceRight'].includes(name) ? 1 : ['Array', 'Set', 'ReadonlySet', 'Map', 'ReadonlyMap'].includes(kind) && (ELEMENT_CALLBACKS.has(name) || (kind !== 'Array' && name === 'forEach')) ? 0 : -1;
		return k === at && this.optionalElements(recv);
	},

	/** `optionalElements` of a value, or of either branch of a choice giving it. */
	optionalElementsOf(this: ValueStates, e: ts.Expression): boolean {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		return ts.isConditionalExpression(x) ? this.optionalElementsOf(x.whenTrue) || this.optionalElementsOf(x.whenFalse) : this.optionalElements(x);
	},

	/** Whether iterating `e` gives the optional elements or values of a container `optionalElements` holds: as values, or as `[key, value]` entries. */
	iteratesOptional(this: ValueStates, e: ts.Expression, entries: boolean): boolean {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (ts.isConditionalExpression(x)) return this.iteratesOptional(x.whenTrue, entries) || this.iteratesOptional(x.whenFalse, entries);
		const kind = (n: ts.Expression) => {
			const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(n));
			return this.checker.isArrayType(t) ? 'Array' : (t.getSymbol()?.name ?? '');
		};
		if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
			const name = x.expression.name.text,
				recv = x.expression.expression;
			if (ts.isIdentifier(recv) && recv.text === 'Object' && x.arguments.length === 1 && name === (entries ? 'entries' : 'values')) return this.optionalElementsOf(x.arguments[0]);
			if (!x.arguments.length && name === (entries ? 'entries' : 'values') && ['Map', 'ReadonlyMap', 'Set', 'ReadonlySet', 'Array'].includes(kind(recv))) return this.optionalElements(recv);
			return false;
		}
		return (entries ? ['Map', 'ReadonlyMap'] : ['Array', 'Set', 'ReadonlySet']).includes(kind(x)) && this.optionalElements(x);
	},
};

export type ElementsMethods = typeof elementsMethods;

/** An object a pattern reads through its iterator (a generator, a Set, a class's own): not a string, a match or an array. */
function iteratedObject(t: ts.Type): boolean {
	if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown) || isMatchArray(t)) return false;
	return (t.isUnion() ? t.types : [t]).every((x) => !!(x.flags & ts.TypeFlags.Object) && x.getProperties().some((p) => (p.escapedName as string).startsWith('__@iterator')));
}
