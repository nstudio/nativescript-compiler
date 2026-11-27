// What Swift answers the shared front's value states with (stateBackend), and its held, lenient and loose reads.
import ts from 'typescript';
import { spell, hasTopLevelArrow, isFunctionType, isOptional, optionalType } from './syntax.ts';
import { heldTypes } from '../semantics/spelled.ts';
import type { Translator } from './translator.ts';
import type { StateBackend } from '../semantics/states/value-states.ts';
import { accessedDeclaration } from '../semantics/lang.ts';
import { isTemplateMethod } from '../semantics/trust.ts';
import { isWriteTarget } from '../semantics/ast.ts';
import { heldAs } from '../semantics/conversion.ts';
import { isStatic } from '../semantics/throws.ts';
import { keyedClass } from '../semantics/shapes.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';

export const stateBackendMethods = {
	/** An identifier naming one of the app's Swift classes through an untyped ambient declaration. */
	appNativeOf(this: Translator, e: ts.Node): string | null {
		if (!ts.isIdentifier(e) || !(this.appNativeClasses.has(e.text) || this.pluginNativeClasses.has(e.text))) return null;
		const decl = this.resolve(e)?.valueDeclaration;
		if (!decl || !ts.isVariableDeclaration(decl) || !(this.checker.getTypeAtLocation(decl).flags & ts.TypeFlags.Any)) return null;
		// A plugin's class (`declare var NSCSurface`): the class object, whose members `__NativeDispatch` finds by name.
		const plugin = this.pluginNativeClasses.get(e.text);
		if (plugin) return `(${plugin}.self as AnyObject)`;
		this.usedAppNative.add(e.text);
		return `__AppNative_${e.text}.shared`;
	},
	initThrows(this: Translator, name: string): boolean {
		return this.throwingInits.has(name);
	},

	stateBackend(this: Translator): StateBackend {
		const t = this;
		return {
			name: 'swift',
			get checker() {
				return t.checker;
			},
			get sourceFiles() {
				return t.sourceFiles;
			},
			get pluginFiles() {
				return t.pluginFiles;
			},
			get pluginRoots() {
				return t.pluginRoots;
			},
			get xmlMemberKeys() {
				return t.xmlMemberKeys;
			},
			get trust() {
				return t.trust;
			},
			get lenient() {
				return t.lenient;
			},
			get lenientApp() {
				return t.lenientApp;
			},
			get assignFields() {
				return t.assignFields;
			},
			get library() {
				return t.library;
			},
			get native() {
				return { holdsNil: (d: ts.Declaration) => t.native.iosHoldsNil(d) };
			},
			get framework() {
				return t.framework;
			},
			ledger: this.ledger,
			...heldTypes(this),
			resolve: (n) => this.resolve(n),
			error: (n, what) => this.error(n, what),
			optional: (t) => isOptional(spell(t)) || spell(t).endsWith('!'),
			functionType: (t) => isFunctionType(spell(t)),
			shapes: this.shapes,
			ownSignature: (fn): fn is ts.MethodDeclaration => this.unfamiliedMethod(fn as ts.SignatureDeclaration) && !isTemplateMethod(fn),
			looseObjectType: (t) => this.looseObjectType(spell(t)),
			resultHoldsNull: (d) => this.mayReturnUndefined(d) && this.returnTypeOf(d).endsWith('?'),
			augmentedMember: (e) => this.augmentedMember(e),
			nullableParameter: (t) => ((type) => !type.endsWith('?') && !type.endsWith('!') && !['Double', 'String', 'Bool', 'Void', 'Never'].includes(type) && !hasTopLevelArrow(type) && !type.startsWith('(') && !this.native.isEnumType(type) && !this.native.isStructType(type))(spell(t)),
			nulledEntry: (read, code) => this.nulledEntry(read, code),
			optionalShapeField: (e) => this.optionalShapeField(e),
			heldType: (x) => {
				const t = this.heldSpelling(x);
				return heldAs(t, isOptional(t) || t.endsWith('!'));
			},
			declaredOptional: (x) => this.declaredOptional(x),
			kitNil: (x) => !this.library && this.core.swiftKitNil(x),
			untypedCastChecks: (e, t) => !this.lenient && this.isObjectRef(e) && this.castChecks(spell(t)),

			keyedClass: (c) => keyedClass(c, this.states, this.shapeFacts()),
		};
	},

	/**
	 * The carrier the code `expr` emits for a name or member read holds: the checker's type where the read converts
	 * (a narrowed read, an erased member or type-parameter field, a field narrowed from its root), else what it is declared as.
	 */
	readHeld(this: Translator, x: ts.Expression): ReturnType<typeof heldAs> {
		const e = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
		if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return this.states.heldType(x);
		if (this.narrowedHeld(e) || typeof this.narrowing(e) === 'function' || (ts.isPropertyAccessExpression(e) && this.convertingMember(e))) {
			const t = (ts.isPropertyAccessExpression(e) && this.heldWeakRef(e)) || this.typeOf(e);
			return heldAs(t, isOptional(t) || t.endsWith('!'));
		}
		return this.states.heldType(x);
	},

	/**
	 * The arm of `property` that reads `e` as the checker's type, or null where it reads the member as declared: a field of
	 * an erased type parameter (`param`), of an erased generic class typed by its parameters (`member`, as `held`), or a field
	 * narrowed from its root's declaration (`root`). `readHeld` reports what `property` emits from this alone.
	 */
	convertingMember(this: Translator, e: ts.PropertyAccessExpression): { arm: 'param' } | { arm: 'member'; held: string } | { arm: 'root'; root: string } | null {
		const write = isWriteTarget(e);
		const decl = accessedDeclaration(this.checker.getSymbolAtLocation(e.name), write);
		const declared = decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type && ts.isTypeReferenceNode(decl.type) ? this.checker.getSymbolAtLocation(decl.type.typeName)?.declarations?.[0] : undefined;
		if (declared && ts.isTypeParameterDeclaration(declared) && this.erasesTypeParameter(declared)) return { arm: 'param' };
		const held = decl && !write && !this.isAny(e.expression) ? this.erasedMemberType(decl) : null;
		if (held) return { arm: 'member', held };
		const root = decl && !write ? this.narrowedFrom(decl) : null;
		return root ? { arm: 'root', root } : null;
	},

	/**
	 * An erased generic class's `WeakRef<T>` field (`JSWeakRef<AnyObject>`) as it holds it, where this instantiation types it
	 * otherwise: read as held, as Swift's invariant generic classes have no cast between instantiations and the read keeps
	 * its identity; the call taking the referent out converts it (`erasedResult`). Null for any other read.
	 */
	heldWeakRef(this: Translator, e: ts.PropertyAccessExpression): string | null {
		const arm = this.convertingMember(e);
		if (arm?.arm !== 'member' || !/^JSWeakRef<.+>[?!]?$/.test(arm.held)) return null;
		const want = this.typeOf(e);
		return /^JSWeakRef<.+>[?!]?$/.test(want) && want.replace(/[?!]$/, '') !== arm.held.replace(/[?!]$/, '') ? arm.held : null;
	},

	/** The type Swift holds what `x` reads as (`ValueStates.heldType`). */
	heldSpelling(this: Translator, x: ts.Expression): string {
		// A read is held as its declaration types it (a chain link's own type has the chain's undefined), except a local
		// whose held type its translation decides other than by `heldUndefined`: the throws analysis asks before that is known.
		const own = this.typeOf(x),
			p = x.parent;
		const inChain = ts.isOptionalChain(x) || ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === x && !!p.questionDotToken);
		const sym = ts.isIdentifier(x) && !inChain ? this.resolve(x) : undefined,
			d = sym?.valueDeclaration;
		const decided = !!sym && this.undefinedVars.has(sym) && !(d && ((ts.isVariableDeclaration(d) && this.heldUndefined(d)) || this.states.arrayPiece(d) || this.states.optionalObjectPiece(d)));
		const t = decided ? own : (this.declaredTypeOf(x) ?? own);
		if (this.lenientField(x) && this.nullableRef(t) !== t) return this.nullableRef(t);
		return this.loose(x) || this.optionalResult(x) || (ts.isIdentifier(x) && (this.unsetLenientVariable(x) || this.declaredOptional(x))) ? optionalType(t) : t;
	},

	/** A read of an instance field lenient code declares, which holds an object type optional whatever its initializer. */
	lenientField(this: Translator, x: ts.Expression): boolean {
		if (this.library || !ts.isPropertyAccessExpression(x)) return false;
		const d = this.resolve(x.name)?.valueDeclaration;
		return !!d && ts.isPropertyDeclaration(d) && !isStatic(d) && !d.getSourceFile().isDeclarationFile && this.lenientFiles.has(d.getSourceFile().fileName) && !this.redeclaredField(d) && !this.kitRedeclared(d);
	},

	/** A variable Swift declares optional for the call it is given. Decided from the declaration alone: the throws analysis asks before the declaration is translated. */
	declaredOptional(this: Translator, x: ts.Identifier): boolean {
		const d = this.resolve(x)?.valueDeclaration;
		return !!d && ts.isVariableDeclaration(d) && !!d.initializer && this.heldOptionalResult(d.initializer);
	},

	/** A non-strict app's read of an object type's optional string, number or boolean member (`o.a`, `a?: string`), held optional. */
	lenientOptionalMember(this: Translator, x: ts.PropertyAccessExpression): boolean {
		if (!this.lenientApp || this.library || x.questionDotToken || x.flags & ts.NodeFlags.OptionalChain || isWriteTarget(x) || !['String', 'Double', 'Bool'].includes(this.typeOf(x))) return false;
		const d = this.resolve(x.name)?.valueDeclaration;
		return !!d && ts.isPropertySignature(d) && !!d.questionToken && !d.getSourceFile().isDeclarationFile && this.states.appCode(d);
	},
	/** A non-strict app's string, number or boolean variable declared without a value: undefined until assigned (`declaration`). */
	unsetLenientVariable(this: Translator, x: ts.Identifier): boolean {
		const d = this.resolve(x)?.valueDeclaration;
		if (!this.lenientApp || this.library || !d || !ts.isVariableDeclaration(d) || d.initializer || !ts.isIdentifier(d.name) || !ts.isVariableDeclarationList(d.parent) || !ts.isVariableStatement(d.parent.parent)) return false;
		return ['String', 'Double', 'Bool'].includes(this.typeOf(d.name)) && this.states.appCode(d);
	},

	/** An object type Swift holds as `T?` where it may be missing: a class, an interface or a native class. */
	looseObjectType(this: Translator, t: string): boolean {
		return !isFunctionType(t) && !t.startsWith('any ') && /^[A-Z][\w.]*(<.*>)?$/.test(t) && this.nullableRef(t) !== t;
	},

	/** The declaration a name, member read or call reads, where it is one of strict code's loose objects. */
	looseObjectRead(this: Translator, x: ts.Expression): boolean {
		if (this.library || isWriteTarget(x)) return false;
		x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
		let d: ts.Declaration | undefined;
		if (ts.isCallExpression(x)) {
			const s = this.checker.getResolvedSignature(x)?.getDeclaration();
			d = s && !ts.isJSDocSignature(s) ? s : undefined;
		} else if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
			if (ts.isIdentifier(x) && ts.isPropertyAccessExpression(x.parent) && x.parent.name === x) return false;
			d = this.resolve(ts.isPropertyAccessExpression(x) ? x.name : x)?.valueDeclaration;
		}
		if (!d || !this.states.looseSlots.has(d)) return false;
		try {
			return this.looseObjectType(this.typeOf(x));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** A declaration's own name (or the declaration) of one of strict code's loose objects: held `T?`. */
	looseObjectDeclaration(this: Translator, n: ts.Node, t: string): boolean {
		if (this.library || !this.looseObjectType(t)) return false;
		const d = ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) || ts.isBindingElement(n) ? n : ts.isIdentifier(n) && n.parent && (ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertySignature(n.parent) || ts.isBindingElement(n.parent)) && n.parent.name === n ? n.parent : undefined;
		return !!d && this.states.looseSlots.has(d);
	},

	/** A string, number or boolean declaration that holds undefined apart from its type's values. */
	holdsUndefined(this: Translator, n: ts.Node): boolean {
		return (this.lenient && this.declaredUndefined(n)) || this.states.looseDeclaration(n) || this.lenientAppOptional(n) || this.unsetGroupElement(n);
	},
	unsetGroupElement(this: Translator, n: ts.Node): boolean {
		return this.unset.element(n);
	},

	/** A string a pattern's unset group may leave undefined, read a member of (`part[0]`, `part.length`). */
	unsetGroupReceiver(this: Translator, x: ts.Expression): boolean {
		const p = x.parent;
		return ts.isIdentifier(x) && !this.subst.has(x) && !!p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === x && !p.questionDotToken && this.unsetGroupElement(x);
	},
	returnsUnsetElement(this: Translator, f: ts.ArrowFunction | ts.FunctionExpression): boolean {
		return this.unset.returnsElement(f);
	},

	/** The elements an array method of a match visits: its strings, unless a group may be unset or the method changes the match. */
	matchElement(this: Translator, target: ts.Expression, method: string): string {
		return this.unsetMatch(target) || ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'].includes(method) ? 'String?' : 'String';
	},

	/** The name of a function-typed field `ValueStates.widenedField` holds optional (`close = () => …` for `close?: () => void`). */
	widenedFunctionField(this: Translator, n: ts.Node): boolean {
		const field = (x: ts.Node) => ts.isPropertyDeclaration(x) || ts.isPropertySignature(x) || ts.isParameter(x);
		const d = field(n) ? n : ts.isIdentifier(n) && n.parent && field(n.parent) && (n.parent as ts.NamedDeclaration).name === n ? n.parent : undefined;
		return !!d && !this.library && this.states.widenedField(d);
	},

	/** A non-strict app's optional parameter (`n?: number`), whose type, without strictNullChecks, leaves out the undefined it takes. */
	lenientAppOptional(this: Translator, n: ts.Node): boolean {
		if (!this.lenientApp || this.lenient || !ts.isIdentifier(n)) return false;
		const d = ts.isParameter(n.parent) && n.parent.name === n ? n.parent : this.resolve(n)?.valueDeclaration;
		return !!d && ts.isParameter(d) && !!d.questionToken && !d.initializer && !d.dotDotDotToken && !d.getSourceFile().isDeclarationFile && !this.pluginFiles.has(d.getSourceFile().fileName);
	},
};
