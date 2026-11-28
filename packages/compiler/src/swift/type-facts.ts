// Facts of Swift types: nullish storage, setters and widened parameters, declared types and shapes, and small tests of a type.
import ts from 'typescript';
import { implicitType, isFunctionType, isNullish, isOptional, nullishType, optionalType, shapeName } from './syntax.ts';
import type { ShapeField, Translator } from './translator.ts';
import { shapePlanOfLiteral } from '../semantics/shapes.ts';
import { accessedDeclaration, assignedValues, wellKnownMember } from '../semantics/lang.ts';
import { isLibDeclaration, isWriteTarget } from '../semantics/ast.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { isStatic } from '../semantics/throws.ts';
import { memberName, programSymbolKey } from '../program/stable-names.ts';
import { programBase, spellCollectionBase, spellInstantiatedCollection } from '../semantics/classes.ts';

export const typeFactsMethods = {
	/** `signal<Person>(null)` where null checks are off: the signal holds the null its type does not admit. */
	holdingNull(this: Translator, t: string, n: ts.Node): string {
		return /^Signal<.*[^?]>$/.test(t) && t !== 'Signal<Any?>' && !t.startsWith('Signal<JSNullish<') && this.madeHoldingNull(n) ? t.replace(/>$/, '?>') : t;
	},

	/** Whether `n` is, names or declares a `signal(null)` or `signal(undefined)`. */
	madeHoldingNull(this: Translator, n: ts.Node): boolean {
		const declaration = (ts.isVariableDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent)) && n.parent.name === n ? n.parent : ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) ? this.resolve(n)?.valueDeclaration : undefined;
		const made = ts.isCallExpression(n) ? n : declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) ? declaration.initializer : undefined;
		// A field given a signal that holds null (`this.morning = s.morning`) is that signal, whatever type it declares.
		if (!made && declaration && ts.isPropertyDeclaration(declaration) && !this.holdingNullVisits.has(declaration)) {
			this.holdingNullVisits.add(declaration);
			try {
				return assignedValues(declaration).some((v) => this.madeHoldingNull(v));
			} finally {
				this.holdingNullVisits.delete(declaration);
			}
		}
		if (!made || !ts.isCallExpression(made) || this.calleeName(made) !== 'signal' || !this.resolve(made.expression)?.declarations?.[0]?.getSourceFile().isDeclarationFile) return false;
		const value = made.arguments[0];
		return !!value && (value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined'));
	},

	/** The kit collection a program's class extending Array, Set or Map subclasses (`JSArray<Any?>` for `extends Array`), directly or through its program bases. */
	collectionBase(this: Translator, cls: ts.ClassLikeDeclaration): string | null {
		return spellCollectionBase(cls, this.checker, (t, n) => this.type(t, n));
	},

	/** The kit collection an instantiated expression type extends (`JSMap<String, Double>` for `TrackedMap<string, number>`). */
	instantiatedCollection(this: Translator, e: ts.Expression): string | null {
		return spellInstantiatedCollection(this.checker.getTypeAtLocation(e), this.checker, (t) => this.type(t, e));
	},

	/** The collection a receiver's class inherits the member read from it from, where that member is the library's (`touches.splice`, `this[i]`). */
	inheritedCollection(this: Translator, e: ts.Expression): string | null {
		const base = this.instantiatedCollection(e);
		if (!base) return null;
		const parent = e.parent as ts.PropertyAccessExpression | ts.ElementAccessExpression;
		if (ts.isElementAccessExpression(parent)) return base;
		const member = this.checker.getSymbolAtLocation(parent.name);
		return member?.declarations?.every(isLibDeclaration) ? base : null;
	},

	/**
	 * Lenient code: a field, variable or parameter declared `T | undefined`, which the checker reads as `T`,
	 * holds undefined apart from any `T` (`private pending: boolean | undefined`); so does a variable it initializes.
	 */
	declaredUndefined(this: Translator, n: ts.Node): boolean {
		const named = ts.isPropertyAccessExpression(n) ? n.name : ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) ? n.name : n;
		if (!ts.isIdentifier(named) && !ts.isPrivateIdentifier(named)) return false;
		const sym = this.checker.getSymbolAtLocation(named);
		// A getter declared to give undefined (`get namespace(): string | undefined`).
		const getter = sym?.declarations?.find(ts.isGetAccessorDeclaration);
		if (getter && ts.isPropertyAccessExpression(n)) return this.mayReturnUndefined(getter);
		const d = sym?.valueDeclaration;
		if (!d || !(ts.isPropertyDeclaration(d) || ts.isVariableDeclaration(d) || ts.isParameter(d))) return false;
		if (d.type && ts.isUnionTypeNode(d.type) && d.type.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword))) return true;
		// Lenient code testing a variable it read untyped against undefined or null (`let result: string = cache[key];
		// if (result === undefined)`): the test means what it says only where the variable can hold undefined.
		if (this.lenient && ts.isVariableDeclaration(d) && d.initializer && this.isAny(d.initializer) && this.comparedWithNullish(d)) return true;
		if (d.type) return false;
		if (!ts.isVariableDeclaration(d) || !d.initializer || d.initializer === n) return false;
		let init: ts.Expression = d.initializer;
		while (ts.isParenthesizedExpression(init)) init = init.expression;
		return (ts.isPropertyAccessExpression(init) || ts.isIdentifier(init)) && this.declaredUndefined(init);
	},
	/** Whether code in the variable's scope compares it with undefined or null (`===`, `!==`, `==`, `!=`). */
	comparedWithNullish(this: Translator, d: ts.VariableDeclaration): boolean {
		let found = this.nullishTested.get(d);
		if (found !== undefined) return found;
		found = false;
		const sym = ts.isIdentifier(d.name) ? this.checker.getSymbolAtLocation(d.name) : undefined;
		const scope = ts.findAncestor(d, (x) => ts.isFunctionLike(x) || ts.isSourceFile(x));
		const K = ts.SyntaxKind;
		const visit = (x: ts.Node): void => {
			if (found) return;
			if (ts.isBinaryExpression(x) && [K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(x.operatorToken.kind)) {
				const holds = (e: ts.Expression) => ts.isIdentifier(e) && this.checker.getSymbolAtLocation(e) === sym;
				if ((holds(x.left) && isNullish(x.right)) || (holds(x.right) && isNullish(x.left))) {
					found = true;
					return;
				}
			}
			ts.forEachChild(x, visit);
		};
		if (sym && scope) visit(scope);
		this.nullishTested.set(d, found);
		return found;
	},
	/**
	 * Lenient code: a setter testing what script gives it (`set style(value: Style) { if (typeof value === 'string') … }`):
	 * its parameter holds any value, through a method of its own that script's writes reach as they are.
	 */
	typeofTestedSetter(this: Translator, fn: ts.SetAccessorDeclaration): boolean {
		const p = fn.parameters[0];
		if (!this.lenient || !fn.body || !p || !ts.isIdentifier(p.name) || ['String', 'Double', 'Bool', 'Any?'].includes(this.type(this.checker.getTypeAtLocation(p.name), p))) return false;
		const sym = this.checker.getSymbolAtLocation(p.name);
		const tests = (x: ts.Node): boolean => (ts.isTypeOfExpression(x) && ts.isIdentifier(x.expression) && this.checker.getSymbolAtLocation(x.expression) === sym) || !!ts.forEachChild(x, tests);
		return tests(fn.body);
	},

	/**
	 * A setter taking values its getter's type can't hold: one testing what script gives it (`typeofTestedSetter`), or one
	 * declaring a wider type (`set tint(value: Color | string)`). Its body is a method of its own, `__set_<name>`, taking any
	 * value, which every write reaches.
	 */
	setterTakesAny(this: Translator, set: ts.SetAccessorDeclaration): boolean {
		if (this.typeofTestedSetter(set)) return true;
		const p = set.parameters[0];
		if (!p || !set.body || isStatic(set) || !ts.isClassLike(set.parent)) return false;
		const get = set.parent.members.find((m): m is ts.GetAccessorDeclaration => ts.isGetAccessorDeclaration(m) && m.name.getText() === set.name.getText() && !isStatic(m));
		// A destructured parameter takes apart whatever object it is given (`set offset({ x, y })` beside `get offset(): Point`).
		if (!ts.isIdentifier(p.name)) return !!get?.body && this.typeOf(p.name) !== this.returnTypeOf(get);
		return !!get?.body && this.isAny(p.name) && !isUntyped(spelledType(this.returnTypeOf(get)));
	},

	/** An app object's accessor read and written by name (`subscript(jsKey:)`). */
	byNameAccessor(this: Translator, cls: ts.ClassLikeDeclaration, a: ts.AccessorDeclaration): boolean {
		return !this.library && (((this.pluginFiles.has(cls.getSourceFile().fileName) || this.appMembersByName || this.states.byNameClass(cls)) && this.states.byNameMember(cls, a.name.getText())) || this.states.viewedMember(cls, a.name.getText())) && !isStatic(a) && !this.symbolMember(a.name);
	},

	/** An accessor whose typed reads or writes, and writes by name, call its throwing body (`throwingGetter`, `throwingSetter`), so that they throw what it throws. */
	throwingBodyOf(this: Translator, a: ts.AccessorDeclaration): boolean {
		return this.throwingAccessor(a) && this.throwsInfo.fn(a);
	},

	/** Whether a program base class's accessor of this kind and name has a throwing body (`throwingBodyOf`), which this class's overrides. */
	baseThrowingBody(this: Translator, cls: ts.ClassLikeDeclaration, name: string, kind: ts.SyntaxKind.GetAccessor | ts.SyntaxKind.SetAccessor): boolean {
		for (let b = programBase(cls, this.checker); b; b = programBase(b, this.checker)) {
			const a = b.members.find((m): m is ts.AccessorDeclaration => m.kind === kind && m.name?.getText() === name && !isStatic(m));
			if (a && this.throwingBodyOf(a)) return true;
		}
		return false;
	},

	/** Whether a base class of `cls` declares `__set_<name>` (`setterTakesAny`): the program's, or the kit's. */
	baseSetterMethod(this: Translator, cls: ts.ClassLikeDeclaration, name: string): boolean {
		for (let b = programBase(cls, this.checker); b; b = programBase(b, this.checker)) {
			const set = b.members.find((m): m is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(m) && m.name.getText() === name && !isStatic(m));
			const get = b.members.find((m): m is ts.GetAccessorDeclaration => ts.isGetAccessorDeclaration(m) && m.name.getText() === name && !isStatic(m));
			if (set && (get ?? set).body && this.setterTakesAny(set)) return true;
		}
		const kitRoot = this.library ? null : this.kitRootOf(cls);
		return !!kitRoot && this.core.kitMember(kitRoot, `__set_${name.replace(/\W/g, '_')}`)?.kind === 'func';
	},

	/**
	 * Lenient code: a function literal's parameter typed a string, number or boolean where its slot passes
	 * any value (`scale: (value: number) => ({ property: 'scale', value })` stored where a `Pair | number` is
	 * passed): JavaScript passes the value through unconverted, so the parameter holds it untyped.
	 */
	widenedParameter(this: Translator, n: ts.Identifier): boolean {
		if (!this.lenient) return false;
		const d = ts.isParameter(n.parent) && n.parent.name === n ? n.parent : this.resolve(n)?.valueDeclaration;
		if (!d || !ts.isParameter(d) || !ts.isIdentifier(d.name) || d.dotDotDotToken) return false;
		let found = this.widenedParameters.get(d);
		if (found !== undefined) return found;
		found = false;
		const fn = d.parent;
		if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
			const own = this.type(this.checker.getTypeAtLocation(d.name), d);
			const k = fn.parameters.indexOf(d);
			const slot = this.slotOf(fn)?.getParameters()[k];
			found = (own === 'Double' || own === 'String' || own === 'Bool') && !!slot && isUntyped(spelledType(this.type(this.checker.getTypeOfSymbolAtLocation(slot, fn), fn)));
		} else if (ts.isSetAccessorDeclaration(fn)) {
			found = this.typeofTestedSetter(fn);
		} else if (ts.isMethodDeclaration(fn) && ts.isComputedPropertyName(fn.name) && fn.body && this.native.isClassType(this.checker.getTypeAtLocation(d.name))) {
			// `[colorProperty.setNative](value: UIColor) { … value instanceof Color ? value.ios : value }`: the property
			// system passes the program's class the body tests for, which the native class it declares cannot hold.
			const sym = this.checker.getSymbolAtLocation(d.name);
			const ownClass = (e: ts.Expression) => {
				const s = this.checker.getSymbolAtLocation(e);
				return !!(s && s.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(s) : s)?.declarations?.some((x) => ts.isClassDeclaration(x) && !x.getSourceFile().isDeclarationFile);
			};
			const tests = (x: ts.Node): boolean => (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(x.left) && this.checker.getSymbolAtLocation(x.left) === sym && ownClass(x.right)) || !!ts.forEachChild(x, tests);
			found = tests(fn.body);
		}
		this.widenedParameters.set(d, found);
		return found;
	},
	/**
	 * A local array that is only indexed and read back with `for…in`
	 * (`parsed[time] = keyframe` at times 0, 0.5 and 1): JavaScript holds it as a map from
	 * each number's string form to a value, which an array of the element type cannot be.
	 * The element type when it is one, held as a record of it.
	 */
	numberKeyedArray(this: Translator, n: ts.Identifier | ts.VariableDeclaration): string | null {
		const d = ts.isVariableDeclaration(n) ? n : ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent : this.resolve(n)?.valueDeclaration;
		if (!d || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || !d.initializer) return null;
		let found = this.numberKeyedArrays.get(d);
		if (found !== undefined) return found;
		this.numberKeyedArrays.set(d, null);
		let init: ts.Expression = d.initializer;
		while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
		const empty = (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'Array' && !init.arguments?.length) || (ts.isArrayLiteralExpression(init) && !init.elements.length);
		const scope = ts.findAncestor(d, (x) => ts.isFunctionLike(x) || ts.isSourceFile(x));
		const el = this.checker.getTypeAtLocation(d.name).getNumberIndexType();
		if (!empty || !scope || !el) return null;
		const sym = this.checker.getSymbolAtLocation(d.name);
		let ok = true,
			iterated = false;
		const visit = (x: ts.Node): void => {
			if (!ok) return;
			if (ts.isIdentifier(x) && x !== d.name && this.checker.getSymbolAtLocation(x) === sym) {
				const p = x.parent;
				if (ts.isElementAccessExpression(p) && p.expression === x) return;
				if (ts.isForInStatement(p) && p.expression === x) {
					iterated = true;
					return;
				}
				ok = false;
				return;
			}
			ts.forEachChild(x, visit);
		};
		visit(scope);
		found = ok && iterated ? this.type(el, d) : null;
		this.numberKeyedArrays.set(d, found);
		return found;
	},
	/**
	 * A record a literal starts (`{ [NSFontAttributeName]: font }`) that values of another type are written to
	 * (`attributes[key] = color.ios`, untyped or by a lax check) and whose elements nothing reads: it holds any value.
	 */
	untypedRecord(this: Translator, n: ts.Identifier | ts.VariableDeclaration): boolean {
		const d = ts.isVariableDeclaration(n) ? n : ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent : this.resolve(n)?.valueDeclaration;
		if (!d || !ts.isVariableDeclaration(d) || d.type || !d.initializer || !ts.isObjectLiteralExpression(d.initializer) || !ts.isIdentifier(d.name)) return false;
		let found = this.untypedRecords.get(d);
		if (found !== undefined) return found;
		const element = this.checker.getTypeAtLocation(d.name).getStringIndexType();
		const sym = this.checker.getSymbolAtLocation(d.name);
		let written = false,
			read = false;
		const visit = (x: ts.Node): void => {
			if (ts.isElementAccessExpression(x) && ts.isIdentifier(x.expression) && this.checker.getSymbolAtLocation(x.expression) === sym) {
				const write = ts.isBinaryExpression(x.parent) && x.parent.left === x && x.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
				const value = write ? this.checker.getTypeAtLocation(x.parent.right) : null;
				if (value && (value.flags & ts.TypeFlags.Any || !(this.checker as any).isTypeAssignableTo?.(value, element))) written = true;
				else if (!write) read = true;
			}
			ts.forEachChild(x, visit);
		};
		if (element && !(element.flags & ts.TypeFlags.Any)) visit(d.parent.parent.parent);
		found = written && !read;
		this.untypedRecords.set(d, found);
		return found;
	},

	plainDeclaredTypeOf(this: Translator, e: ts.Expression): string | null {
		if (this.states.heldNullish(e)) return 'Any?';
		if (ts.isElementAccessExpression(e) && isNamed(spelledType(this.typeOf(e.expression)), 'JSRecord<Any?>')) return 'Any?';
		if ((this.library && this.holdsMethods(e)) || this.holdsFunctionObject(e)) return 'Any?';
		const sym = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
		// A member of a mapped type (`Partial<T>`): optional where `T` declares it required.
		if (sym && !sym.valueDeclaration && sym.flags & ts.SymbolFlags.Optional && sym.declarations?.length) {
			return optionalType(this.type(this.checker.getNonNullableType(this.checker.getTypeOfSymbol(sym)), sym.declarations[0]));
		}
		// A member's type is its getter's, for a write as well.
		const decl = accessedDeclaration(sym);
		if (!sym || !decl) return null;
		const maybe = this.undefinedVars.get(sym) ?? (ts.isVariableDeclaration(decl) ? this.heldUndefined(decl) : this.states.arrayPiece(decl) || this.states.optionalObjectPiece(decl) ? optionalType(this.typeOf((decl as ts.BindingElement).name)) : null);
		if (maybe) return maybe;
		if (ts.isIdentifier(e) && this.unsetGroups(e) && !/^JSMatch[?!]?$/.test(this.typeOf(decl))) return 'JSArray<String?>';
		const erased = this.erasedMemberType(decl);
		if (erased) return erased;
		const root = ts.isPropertyDeclaration(decl) || (ts.isParameter(decl) && ts.isPropertyAccessExpression(e)) ? this.redeclaredField(decl) : null;
		if (root) return this.redeclaredType(root);
		const kitOver = ts.isPropertyDeclaration(decl) ? this.kitRedeclared(decl) : null;
		if (kitOver?.same) return kitOver.type;
		// An accessor over a kit property (`get width()` over core's `width`): Swift's property has the kit's type.
		if ((ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) && ts.isClassLike(decl.parent) && !isStatic(decl) && !this.narrowedFrom(decl)) {
			const kitRoot = this.kitRootOf(decl.parent);
			const kit = kitRoot && !this.baseHasField(decl.parent, decl.name.getText()) ? this.core.kitMember(kitRoot, decl.name.getText()) : null;
			if (kit?.kind === 'var') return kit.type;
		}
		if (!(ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isPropertyAssignment(decl) || ts.isShorthandPropertyAssignment(decl) || ts.isBindingElement(decl) || ts.isGetAccessorDeclaration(decl))) return null;
		const t = this.holdingNull(this.type(this.checker.getTypeOfSymbolAtLocation(sym, decl), decl), e);
		if (this.states.unsetMember(decl)) return optionalType(t);
		if ((t === 'Bool' || t === 'String' || t === 'Double') && (this.holdsUndefined(e) || this.states.lenientNullField(decl) || (ts.isPropertyAccessExpression(e) && this.states.shapeFieldOptional(sym)))) return `${t}?`;
		if (isFunctionType(t) && this.widenedFunctionField(decl)) return optionalType(t);
		if (ts.isParameter(decl) && this.states.nullishHeld(decl)) return optionalType(t);
		return isWriteTarget(e) && (this.looseObjectDeclaration(decl, t) || (ts.isParameter(decl) && this.states.mayBeNull(decl))) ? optionalType(t) : t;
	},

	/**
	 * Whether a member access continues from an optional Swift value. Inside an
	 * optional chain (`a?.b.c`) TypeScript types `a?.b` as possibly undefined,
	 * but Swift's chain already carries that: only `b`'s own type counts.
	 */
	continuesOptional(this: Translator, x: ts.Expression): boolean {
		if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && ts.isOptionalChain(x)) {
			if (ts.isPropertyAccessExpression(x) && !this.library) return this.states.heldOptional(x);
			const own = ts.isPropertyAccessExpression(x) ? this.declaredTypeOf(x) : null;
			if (own) return own.endsWith('?');
			return this.type(this.checker.getNonNullableType(this.checker.getTypeAtLocation(x)), x).endsWith('?');
		}
		return this.typeOf(x).endsWith('?');
	},

	/** An object type with no name: a final class named for its fields, shared by every literal of that shape. */
	shape(this: Translator, t: ts.Type, where?: ts.Node): string {
		const held = this.heldAs(t, where);
		if (held) return held;
		const conforming = this.conformingInterface(t);
		if (conforming) {
			this.used.add(conforming);
			return conforming;
		}
		// Keys that are no names (a lookup table: `{ '\\alpha': 'α', '0': '₀' }`) make a dynamic object.
		if (t.getProperties().some((p) => !p.name.startsWith('__@') && !/^[A-Za-z$][\w$]*$|^_[\w$]+$/.test(p.name))) return 'JSObject';
		// Library mode: `{}` is an object script adds keys to (`symbolPropertyMap[key] = property`).
		if (this.library && !t.getProperties().length && !t.getCallSignatures().length) return 'JSObject';
		// `{}` (what `unknown` narrows to once tested truthy) is any value but null and undefined, a native object included.
		if (!t.getProperties().length && !t.getCallSignatures().length && !t.getConstructSignatures().length) return 'Any?';
		this.shaping.add(t);
		try {
			// A literal's keys are in the order JavaScript creates them: a spread's keys, then new ones; an overwritten key keeps its place.
			const ordered = where && ts.isObjectLiteralExpression(where) ? shapePlanOfLiteral(where, this.states).keys.map((k) => k.name) : [];
			const rank = (n: string) => (ordered.includes(n) ? ordered.indexOf(n) : ordered.length);
			const props = [...t.getProperties()].sort((a, b) => rank(a.name) - rank(b.name));
			const literal = t.getSymbol()?.declarations?.[0];
			const fields = props.map((p): ShapeField => {
				const ptype = this.checker.getTypeOfSymbolAtLocation(p, where ?? p.valueDeclaration!);
				// A field of a type parameter (`{ at, data: T }`): shared by every instantiation, it holds any value.
				let pt = ptype.flags & ts.TypeFlags.TypeParameter || (p.valueDeclaration && this.states.nullish().held.has(p.valueDeclaration)) ? 'Any?' : this.type(ptype, where);
				if (p.valueDeclaration && (ts.isPropertySignature(p.valueDeclaration) || ts.isPropertyAssignment(p.valueDeclaration) || ts.isShorthandPropertyAssignment(p.valueDeclaration))) pt = this.heldElements(p.valueDeclaration, pt);
				const symbolic = wellKnownMember(p.name);
				if (symbolic) return { name: symbolic, type: pt, symbol: true };
				const keyed = programSymbolKey(p, this.checker);
				if (keyed) return { name: keyed.member, type: p.flags & ts.SymbolFlags.Optional ? optionalType(pt) : pt, symbol: true, key: `${this.expr(keyed.key)}.key` };
				if (pt === 'Void' || pt === 'Never') pt = 'Any?';
				// Accessors of the literal itself; a spread copies an accessor's value into a plain property.
				const getter = p.declarations?.find((d) => ts.isGetAccessorDeclaration(d) && d.parent === literal);
				const setter = p.declarations?.find((d) => ts.isSetAccessorDeclaration(d) && d.parent === literal);
				// Whether the getter throws is read where the shape is written: a type asked about while the translator's throw
				// analysis runs is spelled before that analysis has an answer.
				const throwsInfo = () => this.throwsInfo;
				if (getter || setter)
					return {
						name: memberName(p, this.checker),
						type: getter ? pt : optionalType(pt),
						accessor: {
							get: !!getter,
							set: !!setter,
							get throws() {
								return !!getter && throwsInfo().fn(getter as ts.GetAccessorDeclaration);
							},
							value: pt,
						},
					};
				// A field the literal starts as null, asserted to its type (`tabView: null as TabView`): unset until assigned.
				const init = p.declarations?.find(ts.isPropertyAssignment)?.initializer;
				let bare = init;
				while (bare && (ts.isAsExpression(bare) || ts.isParenthesizedExpression(bare) || ts.isTypeAssertionExpression(bare))) bare = bare.expression;
				if (bare && bare !== init && isNullish(bare) && /^[A-Z][\w.]*(<.*>)?$/.test(pt) && !['Double', 'String', 'Bool'].includes(pt)) pt = `${pt}!`;
				return { name: memberName(p, this.checker), type: p.flags & ts.SymbolFlags.Optional || ((['String', 'Double', 'Bool'].includes(pt) || this.states.unsetMember(p.valueDeclaration ?? p.declarations?.[0])) && this.states.shapeFieldOptional(p)) ? optionalType(pt) : pt };
			});
			const key = fields
				.map((f) => `${f.name}:${f.type}${f.accessor ? `:${f.accessor.get ? 'get' : ''}${f.accessor.set ? 'set' : ''}` : ''}`)
				.sort()
				.join(',');
			return this.shapes.require(key, shapeName(fields.map((f) => f.name)), (name) => {
				if (fields.some((f) => f.symbol || f.key)) this.unviewable.add(name);
				return { name, fields };
			}).name;
		} finally {
			this.shaping.delete(t);
		}
	},

	isBool(this: Translator, n: ts.Node) {
		return this.typeOf(n) === 'Bool';
	},
	/** A value of a type parameter any value binds (`T extends … | any`): Swift knows nothing to compare it by. */
	unboundGeneric(this: Translator, n: ts.Node): boolean {
		const own = this.checker.getTypeAtLocation(n);
		if (!(own.flags & ts.TypeFlags.TypeParameter)) return false;
		const c = this.checker.getBaseConstraintOfType(own);
		return !c || !((c.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class);
	},

	isObjectRef(this: Translator, n: ts.Node) {
		const t = this.typeOf(n).replace(/[?!]$/, '');
		// A type parameter any value binds (`T extends … | any`): not one Swift compares by identity.
		if (this.unboundGeneric(n)) return false;
		return !['Double', 'String', 'Bool', 'Any?', 'Any', 'Void', 'JSBigInt', 'JSSymbol'].includes(t) && !t.startsWith('(') && !t.startsWith('[') && !this.native.isEnumType(t) && !this.native.isStructType(t);
	},
	/**
	 * Lenient code: a declaration of an object type holds undefined as well, read
	 * as JavaScript reads it (`x?.y`, `if (x)`), so Swift declares it implicitly unwrapped.
	 */
	lenientRef(this: Translator, t: string): string {
		return this.lenient ? this.nullableRef(t) : t;
	},

	/**
	 * A non-strict app's function type taking an object (`done: (err: Error) => void`, called `done(null)`): its parameter is
	 * optional, as one of a closure written for it is implicitly unwrapped. Where its group's form decides, it is optional
	 * only where that form holds an empty value (`widened`), as every member of the group is.
	 */
	lenientAppParameter(this: Translator, d: ts.Declaration | undefined, t: string): boolean {
		return this.lenientApp && !!d && ts.isParameter(d) && !d.dotDotDotToken && !d.getSourceFile().isDeclarationFile && !this.pluginFiles.has(d.getSourceFile().fileName) && (ts.isFunctionTypeNode(d.parent) || ts.isArrowFunction(d.parent) || ts.isFunctionExpression(d.parent)) && !isFunctionType(t) && this.nullableRef(t) !== t && (!this.states.formDecides(d) || this.states.widened(d));
	},

	/** A reference type as code without null checks holds it: implicitly unwrapped, as null may be given where it is declared. */
	nullableRef(this: Translator, t: string): string {
		if (isFunctionType(t)) return `(${t})?`;
		if (t.endsWith('?') || t.endsWith('!')) return t;
		if (t.startsWith('any ')) return `(${t})?`;
		if (['Double', 'String', 'Bool', 'Any', 'Void', 'Never', 'JSBigInt', 'JSSymbol'].includes(t) || t.startsWith('(') || t.startsWith('[') || this.native.isEnumType(t) || this.native.isStructType(t) || this.genericNames.has(t)) return t;
		return `${t}?`;
	},
	zero(this: Translator, t: string): string | null {
		if (isOptional(t) || isKit(spelledType(t), 'JSNullish')) return 'nil';
		if (t === 'Double') return '0';
		if (t === 'String') return '""';
		if (t === 'Bool') return 'false';
		if (/^JS(Array|Map|Set)</.test(t)) return `${t}()`;
		return null;
	},
	/** A declaration's type and initial value when its real value is assigned later. */
	deferredType(this: Translator, t: string): string {
		return this.deferred(t);
	},
	deferredDeclaration(this: Translator, name: string, t: string): string {
		return `var ${name}: ${this.deferred(t)}`;
	},
	/** A field held as `JSNullish<T>` (`ValueStates.nullishHeld`): its type and first value; null for any other field. */
	nullishStorage(this: Translator, m: ts.PropertyDeclaration): { type: string; init: string } | null {
		if (!this.states.nullishHeld(m)) return null;
		const type = nullishType(this.typeOf(m.name));
		return { type, init: m.initializer ? this.stored(m.initializer, m, type) : 'nil' };
	},
	/** A field's type and initial value before its initializer runs: lenient code's object fields hold undefined too. */
	fieldType(this: Translator, t: string): string {
		// Lenient code: a number field never assigned is undefined, which compares and computes as NaN does.
		if (this.lenient && t === 'Double') return 'Double = .nan';
		// A non-strict app's array, map or set field holds undefined until given one, and the null it may be set to.
		if (this.lenientApp && !this.lenient && /^JS(Array|Map|Set)</.test(t)) return `${t}!`;
		const declared = this.lenientRef(t);
		if (declared === t) return this.deferred(t);
		const z = this.zero(t);
		return z ? `${declared} = ${z}` : declared;
	},
	/** A declaration's type and initial value when no read can see it before its real value is assigned (`deadZoneBinding`). */
	setBeforeRead(this: Translator, t: string): string {
		const z = this.zero(t);
		if (z) return `${t} = ${z}`;
		return implicitType(t);
	},
	deferred(this: Translator, t: string): string {
		const z = this.zero(t);
		if (z) return `${t} = ${z}`;
		if (this.lenient && this.nullableRef(t) !== t) return this.nullableRef(t);
		return implicitType(t);
	},
};
