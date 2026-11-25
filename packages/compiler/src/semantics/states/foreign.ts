// Values that enter from outside the program's types (an assertion, a native or library result): the form each enters as.
import ts from 'typescript';
import { isGeneric } from '../forms/flow.ts';
import type { Form } from '../forms/forms.ts';
import { elementStoreOf, isElementStore, patternSource, storeOf, type Store } from '../placement.ts';
import type { ValueStates } from './value-states.ts';
import { isAsync } from '../throws.ts';
import { strictOnlyRoute } from './predicates.ts';

export const foreignMethods = {
	/**
	 * An untyped value asserted to a concrete type (`x as T`, `JSON.parse(s) as T`) in the app's own code: the form the
	 * value enters as, for the backend's checked convert. Null where the assertion is no such entry, or where the type of
	 * what it enters is tested, which is held untyped rather than checked.
	 */
	foreignEntry(this: ValueStates, e: ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression): Form | null {
		const b = this.backend,
			untyped = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
		if (b.library || this.packaged(e) || !(this.checker.getTypeAtLocation(e.expression).flags & untyped)) return null;
		const t = this.checker.getTypeAtLocation(e);
		if (t.flags & untyped || isGeneric(t)) return null;
		const form = this.forms().formOf(e);
		return form.foreign && !form.typeObserved ? this.withElements(form, this.forms().elementsTypeObserved(e)) : null;
	},

	/**
	 * A foreign array of strings, numbers or booleans: its elements are foreign too, checked as they enter, unless their
	 * type is tested (`observed`, or its own element form says so).
	 */
	withElements(this: ValueStates, form: Form, observed: boolean): Form {
		const t = form.type,
			el = this.checker.isArrayType(t) ? this.forms().elementOf(t) : null;
		const primitive = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike;
		if (!el || !(this.checker.getNonNullableType(el).flags & primitive)) return form;
		if (observed || form.element?.typeObserved) return { ...form, element: { ...(form.element ?? form), type: el, typeObserved: true } };
		return { ...form, element: { ...(form.element ?? form), type: this.checker.getNonNullableType(el), foreign: true, typeObserved: false, element: undefined } };
	},

	/**
	 * An untyped value placed in a slot of the app's own code that holds its declared type: a variable's
	 * initializer or assignment, an argument (group 2), a function's result (group 3), a field, or an element of an array,
	 * Set or Map (group 4). The form the
	 * value enters as, for the backend's checked convert. Null where the slot is held untyped or the value or slot is no
	 * such one: a slot whose type is tested but whose group can't be held converts checked too.
	 */
	foreignPlacement(this: ValueStates, a: ts.Expression): Form | null {
		return this.foreignForm(a, () => this.placementForm(a));
	},

	/**
	 * `foreignPlacement` of a call's untyped result: also a strict file's call of the program's own method on an untyped
	 * receiver, whatever function the value holds by that name, checked where its slot holds its declared type though no
	 * form sees a foreign value reach that slot.
	 */
	foreignResult(this: ValueStates, e: ts.CallExpression): Form | null {
		const found = this.foreignPlacement(e);
		if (found || this.backend.lenientApp || !this.backend.trust.strictFile(e.getSourceFile()) || this.checker.getTypeAtLocation(e).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return found;
		const d = this.checker.getResolvedSignature(e)?.getDeclaration();
		if (!d || ts.isJSDocSignature(d) || d.getSourceFile().isDeclarationFile || !(ts.isMethodDeclaration(d) || ts.isMethodSignature(d))) return null;
		if (!ts.isPropertyAccessExpression(e.expression) || e.questionDotToken || !this.appCode(e) || !this.untypedValue(e.expression.expression)) return null;
		const form = this.placementForm(e);
		if (!form || form.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || isGeneric(form.type)) return null;
		return this.withElements(form, false);
	},

	/** `foreignPlacement` of `a` given as the `k`th argument of `call`, decided from the call and its parameter. */
	foreignArgument(this: ValueStates, call: ts.CallExpression | ts.NewExpression, k: number, a: ts.Expression): Form | null {
		return this.foreignForm(a, () => this.argumentForm(call, k));
	},

	/** `foreignPlacement` of `a` stored by `at` (a declaration, an object literal's field, an assignment's target), decided from the store. */
	foreignStore(this: ValueStates, at: Store, a: ts.Expression): Form | null {
		return this.foreignForm(a, () => this.storeForm(at));
	},

	foreignForm(this: ValueStates, a: ts.Expression, slotForm: () => Form | null): Form | null {
		const b = this.backend;
		if (b.library || b.lenient || !this.appCode(a) || !this.untypedValue(a) || (!this.strictCode(a) && strictOnlyRoute(a))) return null;
		const form = slotForm();
		if (!form || !form.foreign || form.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || isGeneric(form.type)) return null;
		return this.withElements(form, false);
	},

	/**
	 * A field of the app's own code (its declaration `at`) written by name (`obj[key] = v`, a binding's write), where
	 * only the backend's code has the value, untyped: the form it enters as, as `foreignStore` gives a stored value's.
	 * Only a field forms already see a foreign value reach is checked: XML attribute strings, two-way bindings and
	 * `Object.assign` from JSON write the rest by name by design.
	 */
	foreignCodeStore(this: ValueStates, at: ts.PropertyDeclaration | ts.PropertySignature | ts.PropertyAssignment): Form | null {
		const b = this.backend;
		if (b.library || b.lenient || !ts.isIdentifier(at.name) || b.lenientApp || !b.trust.strictFile(at.getSourceFile())) return null;
		const form = this.declaredSlot(at);
		if (!form || !form.foreign || form.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || isGeneric(form.type)) return null;
		return this.withElements({ ...form, foreign: true }, false);
	},

	/** The form of the slot of the app's own code `a` is placed in by its parent, if it is one M6 checks. */
	placementForm(this: ValueStates, a: ts.Expression): Form | null {
		let x: ts.Node = a;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		const slot = (d: ts.Declaration | undefined) => this.declaredSlot(d);
		const element = elementStoreOf(this.checker, a);
		if (element) return this.storeForm(element);
		if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== x) return this.argumentForm(p, p.arguments!.indexOf(x as ts.Expression));
		if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === x)) {
			const fn = ts.isArrowFunction(p) ? p : ts.getContainingFunction(p);
			if (!fn || ('asteriskToken' in fn && fn.asteriskToken) || ts.isConstructorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) return null;
			const form = slot(fn),
				result = this.checker.getSignatureFromDeclaration(fn)?.getReturnType();
			if (!form || !result) return null;
			if (!isAsync(fn)) return { ...form, type: this.checker.getNonNullableType(result) };
			const awaited = this.checker.getAwaitedType(result);
			return form.element && awaited && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) ? { ...form.element, type: this.checker.getNonNullableType(awaited) } : null;
		}
		const store = storeOf(a);
		return store ? this.storeForm(store) : null;
	},

	/** The form of the slot of the app's own code `at` stores a value in, if it is one M6 checks. */
	storeForm(this: ValueStates, at: Store): Form | null {
		const slot = (d: ts.Declaration | undefined) => this.declaredSlot(d);
		if (isElementStore(this.checker, at)) return this.elementForm(at);
		if (ts.isVariableDeclaration(at)) return ts.isIdentifier(at.name) ? slot(at) : null;
		if (ts.isPropertyDeclaration(at) || (ts.isPropertySignature(at) && this.strictCode(at))) return this.fieldSlot(at, slot);
		if (ts.isPropertyAssignment(at) || (ts.isShorthandPropertyAssignment(at) && this.strictCode(at))) {
			const literal = ts.isObjectLiteralExpression(at.parent) && this.checker.getContextualType(at.parent);
			const name = ts.isIdentifier(at.name) || ts.isStringLiteral(at.name) ? at.name.text : null;
			return literal && name ? this.fieldSlot(this.checker.getNonNullableType(literal).getProperty(name)?.valueDeclaration, slot) : null;
		}
		if (ts.isParameter(at)) return null;
		if (ts.isCallExpression(at)) return this.strictCode(at) ? this.argumentForm(at, 0) : null;
		const left = ts.skipOuterExpressions(at, ts.OuterExpressionKinds.Parentheses);
		if (ts.isIdentifier(left)) {
			const d = this.checker.getSymbolAtLocation(left)?.valueDeclaration;
			return d && (ts.isVariableDeclaration(d) || (ts.isParameter(d) && !ts.isParameterPropertyDeclaration(d, d.parent))) ? slot(d) : null;
		}
		if (ts.isPropertyAccessExpression(left) && left.name.text === 'value' && this.signalKind(left.expression) === 'ref') return !this.strictCode(at) ? null : this.signalForm(this.checker.getTypeAtLocation(left));
		if (ts.isPropertyAccessExpression(left)) return this.fieldSlot(this.checker.getSymbolAtLocation(left.name)?.valueDeclaration, slot);
		if (ts.isElementAccessExpression(left) && this.collection(left.expression) === 'Array' && this.checker.getTypeAtLocation(left.argumentExpression).flags & ts.TypeFlags.NumberLike) return this.forms().formOf(left.expression).element ?? null;
		return null;
	},

	/**
	 * The form of a slot of the app's own code. A group's form is typed by one of its members; the slot holds its own
	 * declared type. One sharing a declaration file's form (not held untyped) takes an untyped value as that
	 * declaration's type, checked.
	 */
	declaredSlot(this: ValueStates, d: ts.Declaration | undefined): Form | null {
		if (!d || d.getSourceFile().isDeclarationFile || !this.appCode(d) || this.nullish().held.has(d)) return null;
		const form = this.forms().formOfSlot(d);
		return { ...form, foreign: form.foreign || this.forms().fixedSlot(d), type: this.checker.getNonNullableType(this.checker.getTypeAtLocation((d as ts.NamedDeclaration).name ?? d)) };
	},

	/** The form of the `k`th argument's slot of `call`, if it is one M6 checks: the app's parameter. */
	argumentForm(this: ValueStates, call: ts.CallExpression | ts.NewExpression, k: number): Form | null {
		if (ts.isCallExpression(call) && k === 0 && ts.isPropertyAccessExpression(call.expression) && call.arguments.length === 1) {
			const kind = this.signalKind(call.expression.expression),
				method = call.expression.name.text;
			const t = (kind === 'writable' && method === 'set') || (kind === 'input' && method === '$assign') ? this.checker.getContextualType(call.arguments[0]) : undefined;
			if (kind) return t && this.strictCode(call) ? this.signalForm(t) : null;
		}
		const sig = this.checker.getResolvedSignature(call)?.getDeclaration();
		if (!sig || ts.isJSDocSignature(sig) || sig.getSourceFile().isDeclarationFile) return null;
		const param = sig.parameters[k];
		return param && !param.dotDotDotToken && ts.isIdentifier(param.name) && !ts.isParameterPropertyDeclaration(param, param.parent) ? this.declaredSlot(param) : null;
	},

	/**
	 * A variable a destructuring pattern binds from an untyped value (`const { a }: { a: string } = raw`, nested parts
	 * too), named by a pattern whose type says what it holds, or a variable a destructuring assignment or a `for…of` over
	 * existing variables writes from one (`({ a } = raw)`): the form its value enters as, as `foreignPlacement` gives a
	 * placement's.
	 */
	foreignBinding(this: ValueStates, at: ts.BindingElement | ts.Expression): Form | null {
		const b = this.backend;
		if (b.library || b.lenient || !this.appCode(at)) return null;
		const source = patternSource(at);
		if (!source || !this.untypedValue(source.whole)) return null;
		let form: Form | null;
		if (ts.isBindingElement(at)) {
			if (at.dotDotDotToken || !ts.isIdentifier(at.name) || this.nullish().held.has(at) || source.iterated || !source.declaration?.type) return null;
			form = { ...this.forms().formOfSlot(at), type: this.checker.getNonNullableType(this.checker.getTypeAtLocation(at.name)) };
		} else {
			// A shorthand target's own symbol is the literal's property, not the variable it writes.
			const short = ts.isIdentifier(at) && ts.isShorthandPropertyAssignment(at.parent) && at.parent.name === at ? (this.checker.getShorthandAssignmentValueSymbol(at.parent)?.valueDeclaration ?? null) : undefined;
			form = short === undefined ? this.storeForm(at) : short && (ts.isVariableDeclaration(short) || ts.isParameter(short)) ? this.declaredSlot(short) : null;
		}
		if (!form || !form.foreign || form.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || isGeneric(form.type)) return null;
		return this.withElements(form, false);
	},
};

export type ForeignMethods = typeof foreignMethods;
