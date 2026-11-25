// Checked reads and conversions as Swift: which reads throw, and values converted, placed or bound where their type is checked at run time.
import ts from 'typescript';
import { nullishField, type Store, bindingSlot, type ParamSlot, type StoreSlot } from '../semantics/placement.ts';
import { assignmentValue, functionsReferTo, hasTopLevelArrow, isFunctionType, isNullish, isOptional, refersTo, FOREIGN_SLOT, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { uncheckedMatch } from '../semantics/lang.ts';
import { slotOf } from '../semantics/trust.ts';
import { isStatic } from '../semantics/throws.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { isKit, isUntyped, spelledType, parseNativeType } from '../semantics/types.ts';
import type { Form } from '../semantics/forms/forms.ts';
import { plan, type Slot } from '../semantics/conversion.ts';

export const checkedMethods = {
	/** What `Throws` asks of each node: whether the translation checks a missing value there (see `loose`). */
	checkedThrows(this: Translator, n: ts.Node): boolean {
		// `Throws` asks of any file while another is translated: lenient code is the asking node's file's.
		const file = n.getSourceFile().fileName,
			saved = this.currentFile;
		this.currentFile = file;
		try {
			return this.shapes.question(() => this.checkedHere(n));
		} finally {
			this.currentFile = saved;
		}
	},

	/** A field of a type with no zero that a shape holds present, which an untyped spread's value is checked for (see `object`). */
	spreadChecked(this: Translator, type: string): boolean {
		const held = this.shapeHeld({ type });
		return !isOptional(held) && !isUntyped(spelledType(held)) && this.zero(held) === null && this.nullableRef(held) !== held;
	},

	/** Lenient code: an object literal spreading an untyped value into a type with a field `spreadChecked` checks. */
	spreadThrows(this: Translator, n: ts.Node): boolean {
		if (!this.lenient || !ts.isObjectLiteralExpression(n) || !n.properties.some((p) => ts.isSpreadAssignment(p) && this.isAny(p.expression))) return false;
		const type = this.checker.getContextualType(n) ?? this.checker.getTypeAtLocation(n);
		if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
		try {
			return this.checker
				.getNonNullableType(type)
				.getProperties()
				.some((p) => !(p.flags & ts.SymbolFlags.Optional) && !(p.flags & ts.SymbolFlags.Method) && this.spreadChecked(this.type(this.checker.getTypeOfSymbolAtLocation(p, n), n)));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/**
	 * Lenient code: a value Swift holds optional resolving a promise of an object (`resolve(ret as never)` in an executor,
	 * `Promise.resolve(info)`), which the promise holds present: checked as `coerce` writes it.
	 */
	promiseValueThrows(this: Translator, n: ts.Node): boolean {
		if (!this.lenient || !ts.isCallExpression(n) || n.arguments.length !== 1) return false;
		const callee = n.expression;
		let promise: ts.Type | undefined;
		if (ts.isIdentifier(callee)) {
			const d = this.resolve(callee)?.valueDeclaration;
			const executor = d && ts.isParameter(d) && d.parent.parameters[0] === d ? d.parent : undefined;
			const made = executor && (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) && ts.isNewExpression(executor.parent) && executor.parent.arguments?.[0] === executor ? executor.parent : undefined;
			if (!made || !ts.isIdentifier(made.expression) || made.expression.text !== 'Promise' || !isLibGlobal(this, made.expression)) return false;
			promise = this.checker.getTypeAtLocation(made);
		} else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Promise' && isLibGlobal(this, callee.expression)) {
			promise = this.checker.getContextualType(n);
		}
		if (!promise) return false;
		let value: ts.Expression = n.arguments[0];
		while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)) value = value.expression;
		try {
			const v = /^JSPromise<(.*)>$/.exec(this.type(promise, n))?.[1],
				held = this.typeOf(value);
			return !!v && !isOptional(v) && !isUntyped(spelledType(v)) && this.nullableRef(v) !== v && isOptional(held) && !isUntyped(spelledType(held)) && !isKit(spelledType(held), 'JSPromise');
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** A read or write of a cyclic module-level `let`/`const` guarded by a throwing TDZ check. */
	tdzAccess(this: Translator, n: ts.Node): boolean {
		if (!this.facts.tdzBindings().size || !ts.isIdentifier(n)) return false;
		const p = n.parent;
		if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isTypeReferenceNode(p)) return false;
		if (ts.isVariableDeclaration(p) && p.name === n) return false;
		if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
		const d = this.resolve(n)?.valueDeclaration;
		return !!d && ts.isVariableDeclaration(d) && this.facts.tdzBindings().has(d);
	},

	checkedHere(this: Translator, n: ts.Node): boolean {
		if (this.tdzAccess(n)) return true;
		if (nullishField(this, n) && this.nullishPresent(n)) return true;
		if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) && !n.questionDotToken && nullishField(this, ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses))) return true;
		return (
			(ts.isParameter(n) && this.states.destructuresEmpty(n)) ||
			this.spreadThrows(n) ||
			this.requiredField(n) ||
			this.requiredNarrowed(n) ||
			this.promiseValueThrows(n) ||
			((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && (this.looseReceiverKey(n.expression) !== null || this.assertedReceiverKey(n.expression) !== null || this.states.missingAtRead(n.expression) !== null)) ||
			(ts.isExpression(n) && !(assignmentValue(n) && this.lenient) && this.loose(n) && !this.looseTolerated(n)) ||
			(ts.isCallExpression(n) && this.heldFunctionCall(n)) ||
			(ts.isExpression(n) && (this.untypedPresentThrows(n) || this.native.foreignArgument(n)))
		);
	},

	/**
	 * An object read `narrowedMissing` answers, placed where Swift needs it present: `narrowed` checks it with
	 * `jsObjectRequired`. Not a receiver (`receiver` checks it), a read `observedAsIs`, or a placement taking it untyped,
	 * which read the optional.
	 */
	requiredNarrowed(this: Translator, n: ts.Node): boolean {
		if (!ts.isIdentifier(n) || !this.states.narrowedMissing(n) || this.states.observedAsIs(n)) return false;
		let x: ts.Node = n;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === x) return false;
		try {
			if (['String', 'Double', 'Bool'].includes(this.typeOf(n))) return false;
			const slot = slotOf(n as ts.Identifier, this.checker);
			return !(slot && (ts.isParameter(slot) || ts.isVariableDeclaration(slot)) && this.isAny(slot.name));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** A value Swift holds optional placed in a field it holds present (`placedField`): `coerce` checks it with `jsRequired`. */
	requiredField(this: Translator, n: ts.Node): boolean {
		if (!ts.isExpression(n)) return false;
		const field = this.states.placedField(n);
		if (!field) return false;
		try {
			const t = this.typeOf(n),
				want = ts.isFunctionLike(field.decl) ? this.returnTypeOf(field.decl as ts.SignatureDeclaration) : this.typeOf((field.decl as ts.NamedDeclaration).name!);
			return ((isOptional(t) && !isUntyped(spelledType(t))) || this.optionalResult(n)) && !isOptional(want) && !isUntyped(spelledType(want)) && !isFunctionType(want);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** A constant made present (`const view = UIView.new()`, `const list = []`): Swift holds it as its type, not optional. */
	madePresent(this: Translator, d: ts.VariableDeclaration): boolean {
		if (!this.lenient || !ts.isIdentifier(d.name) || !d.initializer || !(d.parent.flags & ts.NodeFlags.Const) || !ts.findAncestor(d, ts.isFunctionLike)) return false;
		let init: ts.Expression = d.initializer;
		while (ts.isParenthesizedExpression(init)) init = init.expression;
		// One whose own initializer refers to it is declared first and assigned after (see `variableDecl`): optional.
		const sym = this.checker.getSymbolAtLocation(d.name);
		if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && refersTo(init, sym, this.checker)) return false;
		if ((ts.isObjectLiteralExpression(init) || ts.isNewExpression(init) || ts.isCallExpression(init)) && functionsReferTo(init, sym, this.checker)) return false;
		return ts.isNewExpression(init) || ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init) || init.kind === ts.SyntaxKind.ThisKeyword || this.nativeConstruction(init);
	},

	/** A module's constant Swift declares as its type with its value (`let DEFAULTS: Object_duration = …`), not optional. */
	presentConstant(this: Translator, d: ts.VariableDeclaration): boolean {
		if (!this.lenient || !d.initializer || !ts.isIdentifier(d.name) || !(d.parent.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(d.parent.parent) || !ts.isSourceFile(d.parent.parent.parent)) return false;
		if (isNullish(d.initializer) || this.framework.memoCall(d.initializer, this.checker) || (!this.library && this.facts.tdzBindings().has(d))) return false;
		if (this.presentConstants.has(d)) return this.presentConstants.get(d)!;
		// Assumed not while deciding, for a constant whose value refers back to it.
		this.presentConstants.set(d, false);
		const present = this.pure(d.initializer) && this.constantInit(d.initializer) && !this.loose(d.initializer) && !this.maybeUndefined(d.initializer);
		this.presentConstants.set(d, present);
		return present;
	},

	/** `UIView.new()`, `UIView.alloc().initWithFrame(r)`: a native object made, which Swift's initializer gives present. */
	nativeConstruction(this: Translator, e: ts.Expression): boolean {
		if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
		const name = e.expression.name.text,
			target = e.expression.expression;
		// Only the plain initializer: Swift imports one taking arguments (`initWithData`) as failable.
		if ((name === 'new' || name === 'alloc') && !e.arguments.length) return !!((this.resolve(target)?.flags ?? 0) & ts.SymbolFlags.Class);
		return name === 'init' && !e.arguments.length && ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'alloc' && !!((this.resolve(target.expression.expression)?.flags ?? 0) & ts.SymbolFlags.Class);
	},

	/**
	 * A call of a function a property holds (`this.onDone(x)`), where Swift holds it optional: in lenient code, or declared
	 * optional. Undefined is V8's "is not a function" TypeError.
	 */
	heldFunctionCall(this: Translator, e: ts.CallExpression): boolean {
		const callee = e.expression;
		if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return false;
		const held = this.checker.getSymbolAtLocation(callee.name)?.valueDeclaration;
		if (!held || held.getSourceFile().isDeclarationFile) return false;
		const property = ts.isPropertyDeclaration(held) || ts.isPropertySignature(held) || (ts.isParameter(held) && !!ts.getModifiers(held)?.length);
		const literalMethod = ts.isMethodDeclaration(held) && ts.isObjectLiteralExpression(held.parent);
		if (!property && !(this.lenient && (ts.isVariableDeclaration(held) || ts.isPropertyAssignment(held) || ts.isShorthandPropertyAssignment(held) || ts.isParameter(held) || literalMethod))) return false;
		let declared: string, own: string;
		try {
			declared = this.declaredTypeOf(callee) ?? '';
			own = this.typeOf(callee);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
		if (isOptional(declared) && hasTopLevelArrow(declared.replace(/^\((.*)\)\?$/, '$1'))) return true;
		return (this.lenient && isFunctionType(own)) || this.lenientValue(callee);
	},

	/** Whether `e` is the target of a plain assignment (`x.y = v`), which V8 words as setting where its object is missing. */
	assigned(this: Translator, e: ts.Expression): boolean {
		const p = e.parent;
		return ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === e;
	},

	/**
	 * Lenient code: an untyped value read as objects (`items = value` of an array of views), whose elements are checked as
	 * Swift's array holds no undefined; or as one object where Swift needs it present.
	 */
	untypedPresentThrows(this: Translator, n: ts.Expression): boolean {
		if (!this.lenient || ts.isOmittedExpression(n) || n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === 'undefined')) return false;
		// A value read (not a callee, nor an assignment, whose operand is what converts).
		if (!(ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n))) return false;
		if ((ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.expression === n) return false;
		// A pattern's source stays untyped: its members are read by name.
		if ((ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent)) && n.parent.initializer === n && !ts.isIdentifier(n.parent.name)) return false;
		let target: string;
		try {
			if (!['Any?', 'JSArray<Any?>'].includes(this.typeOf(n))) return false;
			const context = this.checker.getContextualType(n);
			if (!context) return false;
			target = this.type(context, n);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
		const element = /^JSArray<(.+)>$/.exec(target)?.[1];
		if (element) return this.nullableRef(element) !== element;
		const p = n.parent;
		// A native or library function converts what it takes itself.
		const callee = ts.isCallExpression(p) || ts.isNewExpression(p) ? this.checker.getResolvedSignature(p)?.getDeclaration() : undefined;
		const argument = (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== n && !!callee && !ts.isJSDocSignature(callee) && !callee.getSourceFile().isDeclarationFile;
		return argument && this.isAny(n) && this.nullableRef(target) !== target && !this.looseTolerated(n);
	},

	/** `x!.member` of an optional `x`: the member, whose read or write of a missing `x` is JavaScript's TypeError, not a trap. */
	assertedReceiverKey(this: Translator, e: ts.Expression): string | null {
		const p = e.parent;
		if (!ts.isNonNullExpression(e) || !p || !(ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) || p.expression !== e || ts.isOptionalChain(p)) return null;
		if (!this.typeOf(e.expression).endsWith('?')) return null;
		if (ts.isPropertyAccessExpression(p)) return p.name.text;
		const k = p.argumentExpression;
		return ts.isStringLiteralLike(k) || ts.isNumericLiteral(k) ? k.text : k.getText();
	},

	/** Whether a member read's receiver, as `expr` writes it, throws: its own evaluation, or the check of a loose receiver (`jsUnwrap(x, key)`). */
	receiverThrows(this: Translator, e: ts.Expression): boolean {
		return this.throwsInfo.expr(e) || this.looseReceiverKey(e) !== null || nullishField(this, ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses));
	},

	/** The member a loose value is the receiver of (`x.key`, `x[0]`), which is read through `jsUnwrap`; null where it is no such receiver. */
	looseReceiverKey(this: Translator, e: ts.Expression): string | null {
		const p = e.parent;
		if (!p || !(ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) || p.expression !== e || !this.loose(e) || uncheckedMatch(e, this.checker)) return null;
		// Inside an optional chain Swift's own `?.` carries the link, except after an untyped value, which the runtime reads.
		if (ts.isOptionalChain(p) && (p.questionDotToken || !(ts.isPropertyAccessExpression(e) && this.isAny(e.expression)))) return null;
		if (ts.isPropertyAccessExpression(p)) return p.name.text;
		const k = p.argumentExpression;
		return ts.isStringLiteralLike(k) || ts.isNumericLiteral(k) ? k.text : k.getText();
	},

	isDeclaredFunctionValue(this: Translator, e: ts.Expression): boolean {
		if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
		if (ts.isCallExpression(e.parent) && e.parent.expression === e) return false;
		return !!this.resolve(ts.isPropertyAccessExpression(e) ? e.name : e)?.declarations?.some((d) => ts.isFunctionDeclaration(d) || (ts.isMethodDeclaration(d) && isStatic(d)));
	},

	/**
	 * A stored property's or global's initializer. One holding a declared function as a value (`static let f = g`)
	 * runs in a closure isolated to the main actor: Swift lets only isolated code drop the function's isolation from
	 * its type, and an initializer is not that, though it may call one.
	 */
	storedInit(this: Translator, e: ts.Expression, t: string, present = false, at?: Store): string {
		const saved = this.isolatedInit,
			savedPresent = this.presentSlot,
			savedInit = this.inStoredInit;
		this.isolatedInit = false;
		this.inStoredInit = true;
		this.presentSlot = present;
		try {
			const code = at ? this.stored(e, at, t) : this.coerce(e, t);
			const held = this.lenient && !present ? this.lenientRef(t) : t;
			return this.isolatedInit ? `{ @MainActor () -> ${held.replace(/!$/, '?')} in ${code} }()` : code;
		} finally {
			this.isolatedInit = saved;
			this.presentSlot = savedPresent;
			this.inStoredInit = savedInit;
		}
	},

	/**
	 * The one conversion of a foreign value into the form it enters as: a value of the form's type passes, an
	 * empty state as the slot holds it, any other is JavaScript's TypeError. Null where the form's type has none yet.
	 */
	checkedConvert(this: Translator, code: string, to: Form, at: ts.Node, optional = false): string | null {
		const checked: Record<string, string> = { String: RT.jsCheckedString, Double: RT.jsCheckedNumber, Bool: RT.jsCheckedBool };
		const t = this.type(to.type, at),
			fn = checked[t];
		if (fn) return this.marks.ownTried(`${fn}${optional ? 'OrNil' : ''}(${code})`);
		const element = /^JSArray<(\w+)>$/.exec(t)?.[1];
		if (!element || !checked[element] || !to.element?.foreign || to.element.typeObserved) return null;
		return optional ? this.marks.ownTried(`${RT.jsUnlessNullish}(${code}) { try ${RT.jsCheckedArray}($0) { try ${checked[element]}($0) } }`) : this.marks.ownTried(`${RT.jsCheckedArray}(${code}) { try ${checked[element]}($0) }`);
	},

	/** An untyped value placed where its slot holds its declared type (`foreignPlacement`): converted checked, or null. */
	checkedPlacement(this: Translator, a: ts.Expression, to: string, code?: string, slot?: ParamSlot | StoreSlot): string | null {
		const entry = slot ? this.checkedEntry(a, slot.checked) : this.checkedPlacementEntry(a);
		return entry ? this.checkedCell(() => code ?? this.expr(a), entry, a, to) : null;
	},

	/** A variable a pattern binds or assigns from an untyped value (`bindingSlot`): its value `code` converted checked, or null. */
	checkedBinding(this: Translator, at: ts.BindingElement | ts.Expression, code: string, to: string): string | null {
		if (this.lenient || this.library) return null;
		const slot = bindingSlot(this, to, at);
		return slot.checked ? this.checkedCell(() => code, slot.checked, at, to) : null;
	},

	/** A call's untyped result `code`, of the program's type `to`: checked where its slot takes a foreign value (`foreignResult`), else converted leniently. */
	untypedResult(this: Translator, e: ts.CallExpression, code: string, to: string): string {
		const entry = this.lenient || this.library ? null : this.states.foreignResult(e);
		return (entry && this.checkedCell(() => code, entry, e, to)) ?? this.fromAnyCode(code, to, true);
	},

	/** An untyped value only Swift's code has, stored in a field `slot` (`placeCode`): converted checked, or null. */
	checkedCode(this: Translator, code: string, slot: StoreSlot): string | null {
		const base = slot.target.replace(/[?!]$/, '');
		// A class's field refuses a value of another class itself (`storeFromAny`).
		if (base === slot.target && this.appClass(slot.checked!.type) && !this.checkedConvert('', slot.checked!, slot.at)) return null;
		return this.checkedCell(() => code, slot.checked!, slot.at, slot.target);
	},

	/** The checked convert of an untyped value into `to`, the slot's type, entering as `entry`: an app class's instance too; null where it has none. */
	checkedCell(this: Translator, code: () => string, entry: Form, at: ts.Node, to: string): string | null {
		const base = to.replace(/[?!]$/, '');
		if (this.type(entry.type, at) !== base) return null;
		const value = code();
		return this.checkedConvert(value, entry, at, base !== to) ?? (this.appClass(entry.type) ? this.marks.ownTried(`${base !== to ? RT.jsCast : RT.jsCastPresent}(${value}, ${base}.self)`) : null);
	},

	checkedPlacementEntry(this: Translator, a: ts.Expression): Form | null {
		if (this.lenient || this.library) return null;
		try {
			return this.checkedEntry(a, this.states.foreignPlacement(a));
		} catch (e) {
			rethrowUnlessRefused(e);
			return null;
		}
	},

	/** `entry` where the untyped value `a` converts checked to it, or null. */
	checkedEntry(this: Translator, a: ts.Expression, entry: Form | null | undefined): Form | null {
		try {
			return entry && this.isAny(a) && (this.checkedConvert('', entry, a) || this.appClass(entry.type)) ? entry : null;
		} catch (e) {
			rethrowUnlessRefused(e);
			return null;
		}
	},

	/** A held read its own type test narrows (`ValueStates.narrowedRead`), read as that type through its checked convert. */
	narrowedHeld(this: Translator, n: ts.Node): Form | null {
		if (this.lenient || this.library || this.rawHeld.has(n)) return null;
		const form = this.states.narrowedRead(n);
		return form && (this.checkedConvert('', form, n) || this.appClass(form.type)) ? form : null;
	},

	/** A class of the app's own code that no platform class roots: an object of another class is never one. */
	appClass(this: Translator, t: ts.Type): boolean {
		const d = this.checker.getNonNullableType(t).getSymbol()?.valueDeclaration;
		return !!d && ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile && !this.states.packaged(d) && !this.native.classExtendsNative(d);
	},

	/** An untyped value asserted to a type `checkedConvert` checks, held as that type: the form it enters as. */
	checkedAssertion(this: Translator, e: ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression): Form | null {
		if (this.lenient || this.library) return null;
		try {
			if (!this.isAny(e.expression)) return null;
			const entry = this.states.foreignEntry(e);
			return entry && this.type(entry.type, e) === this.typeOf(e) && this.checkedConvert('', entry, e) ? entry : null;
		} catch (e) {
			rethrowUnlessRefused(e);
			return null;
		}
	},

	/** Whether `fromAny` writes a cast to `type` that `checkedCast` makes throw (or may, an over-approximation). */
	castChecks(this: Translator, type: string): boolean {
		return plan(FOREIGN_SLOT, this.typeSlot(type), 'checked').throws;
	},

	/** A slot of Swift type `type`, known by its spelling. */
	typeSlot(this: Translator, type: string): Slot {
		const t = parseNativeType(type);
		const base = type.replace(/^\((.*)\)$/, '$1');
		if (hasTopLevelArrow(type)) t.kind = 'function';
		// A geometry struct or native enum is built from any value.
		else if (['CGRect', 'CGSize', 'CGPoint', 'UIEdgeInsets'].includes(base) || this.native.isEnumType(base)) t.kind = 'value';
		// Swift casts to a Foundation collection (`[UIView]`), a number but `Double` (`Int`, `CGFloat`) or a cell class (`FunctionCell_…`), which can fail.
		else if (type.startsWith('[') || (t.kind === 'number' && type !== 'Double') || t.kind === 'function') t.kind = 'object';
		return { rep: t.kind === 'any' ? 'foreign' : t.optional || t.implicit ? 'undefined' : 'present', type: t, kind: 'variable' };
	},
};
