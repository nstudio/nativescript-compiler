// Signals, untyped and foreign values, and what the program's own classes, functions and parameters hold.
import ts from 'typescript';
import { containerKind, type ElementStore } from '../placement.ts';
import type { Form } from '../forms/forms.ts';
import { isGeneric } from '../forms/flow.ts';
import { isAsync, isStatic } from '../throws.ts';
import type { ValueStates } from './value-states.ts';

export const untypedMethods = {
	/** The kind of signal `e` is, as the backends hold it (`Signal<T>`): one written by `set(v)`, an input its template writes, a deeply reactive ref. */
	signalKind(this: ValueStates, e: ts.Expression): 'writable' | 'input' | 'ref' | null {
		const t = this.checker.getTypeAtLocation(e),
			name = (t.aliasSymbol ?? t.getSymbol())?.getName();
		const kind = name === undefined ? undefined : this.backend.framework.signalKind(name);
		return kind === 'writable' || kind === 'store' ? 'writable' : kind === 'input' ? 'input' : kind === 'ref' ? 'ref' : null;
	},

	/** The value of type `t` a signal holds, as the slot a write (`s.set(v)`, `ref.value = v`) stores in: no form tracks it, so a foreign one. */
	signalForm(this: ValueStates, t: ts.Type): Form {
		return { type: this.checker.getNonNullableType(t), undefined: false, null: false, hole: false, foreign: true, missing: false, absent: false, given: false, untyped: false, observed: false, typeObserved: false };
	},

	/**
	 * A strict file's code. A non-strict app's keeps its lenient entry at a shape's or shorthand field, a signal's write,
	 * `strictOnlyRoute`'s stores, a member of an untyped value and an optional assertion.
	 */
	strictCode(this: ValueStates, n: ts.Node): boolean {
		return !this.backend.lenientApp && this.backend.trust.strictFile(n.getSourceFile());
	},

	fieldSlot(this: ValueStates, d: ts.Declaration | undefined, slot: (d: ts.Declaration | undefined) => Form | null): Form | null {
		return d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && ts.isIdentifier(d.name) ? slot(d) : null;
	},

	/**
	 * The element form a value stored by `at` (`elementStoreOf`) enters: the receiver's, or an array literal's, typed by
	 * the array type the literal is given for.
	 */
	elementForm(this: ValueStates, at: ElementStore): Form | null {
		if (ts.isArrayLiteralExpression(at)) {
			const element = this.forms().formOf(at).element,
				context = this.checker.getContextualType(at);
			const t = context && this.checker.getNonNullableType(context);
			const el = t && this.checker.isArrayType(t) ? this.checker.getTypeArguments(t as ts.TypeReference)[0] : undefined;
			return element && el ? { ...element, type: this.checker.getNonNullableType(el) } : null;
		}
		if (!ts.isPropertyAccessExpression(at.expression)) return null;
		return this.collection(at.expression.expression) ? (this.forms().formOf(at.expression.expression).element ?? null) : null;
	},

	/** Whether a receiver of the app's own code (a variable, parameter or field) is an array, Set or Map. */
	collection(this: ValueStates, e: ts.Expression): 'Array' | 'Set' | 'Map' | null {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (!ts.isNewExpression(x) && !ts.isArrayLiteralExpression(x)) {
			const name = ts.isIdentifier(x) ? x : ts.isPropertyAccessExpression(x) ? x.name : null;
			const d = name && this.checker.getSymbolAtLocation(name)?.valueDeclaration;
			if (!d || d.getSourceFile().isDeclarationFile || !this.appCode(d)) return null;
		}
		return containerKind(this.checker, e);
	},

	/** A value of no type the program knows: typed `any` or `unknown`, or read from a slot held untyped for its foreign value. */
	untypedValue(this: ValueStates, e: ts.Expression): boolean {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined')) return false;
		if (this.checker.getTypeAtLocation(x).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
		if (this.narrowedRead(x)) return false;
		// A member read or method call on an untyped value is the value's own, read by name: untyped too.
		if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && !x.questionDotToken && this.strictCode(x) && this.untypedValue(x.expression.expression)) return true;
		if (ts.isPropertyAccessExpression(x)) return this.heldMember(x.name) || (this.strictCode(x) && this.untypedValue(x.expression));
		const d = ts.isIdentifier(x) ? this.checker.getSymbolAtLocation(x)?.valueDeclaration : ts.isCallExpression(x) ? this.checker.getResolvedSignature(x)?.getDeclaration() : undefined;
		return !!d && !ts.isJSDocSignature(d) && this.nullish().held.has(d) && this.forms().formOfSlot(d).foreign;
	},

	/** A declaration typed `any` or `unknown`: held untyped already. */
	untypedDeclaration(this: ValueStates, d: ts.Declaration): boolean {
		const t = ts.isFunctionLike(d) ? this.checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration)?.getReturnType() : this.checker.getTypeAtLocation((d as ts.NamedDeclaration).name ?? d);
		return !!t && !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	},

	/**
	 * A slot of the app's own code that can be held untyped for a foreign value: a variable, a parameter
	 * or a sync function's result, of a string, number or boolean; a field, a getter's result, a parameter property or an
	 * object literal's field of an undecorated class or type of the program; or a variable of an object type. Its native
	 * form no declaration outside its group shares.
	 */
	holdsForeign(this: ValueStates, d: ts.Declaration): boolean {
		if (d.getSourceFile().isDeclarationFile || !this.appCode(d)) return false;
		if (this.untypedDeclaration(d)) return true;
		let type: ts.Type | undefined,
			objects = false;
		if (ts.isVariableDeclaration(d)) {
			if (!ts.isIdentifier(d.name) || !ts.isVariableStatement(d.parent.parent)) return false;
			type = this.checker.getTypeAtLocation(d.name);
			objects = true;
		} else if (ts.isBindingElement(d)) {
			let holder: ts.Node = d.parent.parent;
			while (ts.isBindingElement(holder)) holder = holder.parent.parent;
			if (!ts.isIdentifier(d.name) || d.dotDotDotToken) return false;
			if (ts.isVariableDeclaration(holder) ? !ts.isVariableStatement(holder.parent.parent) : !ts.isParameter(holder) || holder.dotDotDotToken || !this.ownFunction(holder.parent)) return false;
			type = this.checker.getTypeAtLocation(d.name);
			objects = true;
		} else if (ts.isParameter(d)) {
			const fn = d.parent;
			if (!ts.isIdentifier(d.name) || d.dotDotDotToken) return false;
			if (ts.isParameterPropertyDeclaration(d, fn) || ts.isSetAccessorDeclaration(fn)) {
				if (!this.ownClass(fn.parent) || (ts.isSetAccessorDeclaration(fn) && ts.getDecorators(fn)?.length)) return false;
				objects = true;
			} else if (!this.ownFunction(fn)) return false;
			type = this.checker.getTypeAtLocation(d.name);
		} else if (ts.isPropertyDeclaration(d) || ts.isGetAccessorDeclaration(d)) {
			if (!ts.isIdentifier(d.name) || isStatic(d) || !this.ownClass(d.parent) || ts.getDecorators(d)?.length) return false;
			type = ts.isGetAccessorDeclaration(d) ? this.checker.getSignatureFromDeclaration(d)?.getReturnType() : this.checker.getTypeAtLocation(d.name);
			objects = true;
		} else if (ts.isPropertySignature(d)) {
			if (!ts.isIdentifier(d.name) || !(ts.isInterfaceDeclaration(d.parent) || ts.isTypeLiteralNode(d.parent))) return false;
			type = this.checker.getTypeAtLocation(d.name);
			objects = true;
		} else if (ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d)) {
			if (!ts.isIdentifier(d.name) || !ts.isObjectLiteralExpression(d.parent)) return false;
			type = this.checker.getTypeAtLocation(d.name);
			objects = true;
		} else if (ts.isFunctionLike(d)) {
			if (!this.ownFunction(d) || isAsync(d as ts.SignatureDeclaration) || (d as ts.FunctionLikeDeclaration).asteriskToken || ts.isConstructorDeclaration(d)) return false;
			type = this.checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration)?.getReturnType();
		}
		if (!type || isGeneric(type)) return false;
		const parts = (type.isUnion() ? type.types : [type]).filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
		// A function type is called as its native closure is; an object of a type parameter's or mapped type has no one form.
		const object = (x: ts.Type) => objects && !!(x.flags & ts.TypeFlags.Object) && !x.getCallSignatures().length && !((x as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped);
		const kind = (x: ts.Type) => (x.flags & ts.TypeFlags.StringLike ? 's' : x.flags & ts.TypeFlags.NumberLike ? 'n' : x.flags & ts.TypeFlags.BooleanLike ? 'b' : object(x) ? 'o' : null);
		return parts.length > 0 && parts.every((x) => kind(x) && kind(x) === kind(parts[0]));
	},

	/** A class of the program's own whose members only the program reads: undecorated, extending no declaration file's class. */
	ownClass(this: ValueStates, cls: ts.Node): boolean {
		if (!ts.isClassLike(cls) || ts.getDecorators(cls)?.length) return false;
		for (let t = this.checker.getTypeAtLocation(cls.name ?? cls), depth = 0; depth < 32; depth++) {
			const base = t.isClassOrInterface() ? this.checker.getBaseTypes(t)[0] : undefined;
			const d = base?.getSymbol()?.declarations?.[0];
			if (!base || !d) return true;
			if (d.getSourceFile().isDeclarationFile || this.packaged(d)) return false;
			t = base;
		}
		return false;
	},

	/** A function whose parameters and result no declaration outside the program's own groups shares. */
	ownFunction(this: ValueStates, fn: ts.Node): boolean {
		if (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionTypeNode(fn) || ts.isCallSignatureDeclaration(fn)) return !(ts.canHaveDecorators(fn) && ts.getDecorators(fn)?.length);
		if (ts.isMethodDeclaration(fn)) return ts.isClassLike(fn.parent) && this.backend.ownSignature(fn) && !ts.getDecorators(fn)?.length && !ts.getDecorators(fn.parent)?.length;
		return false;
	},

	/**
	 * A parameter of the app's own code: a library's and a plugin's are entry points, decided with the kit's surface. Lenient
	 * files are plugin files, so the answer doesn't depend on the file being emitted.
	 */
	appParameter(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		return !this.backend.library && !p.getSourceFile().isDeclarationFile && !this.plugin(p);
	},

	/**
	 * A parameter whose group's form is its own to decide. One typed by a type parameter holds what each instantiation
	 * admits, which its native type parameter does as well; one sharing a fixed point's form (a callback
	 * parameter of a kit or platform function type) is spelled as that declaration is, and a parameter property as its
	 * field is. A foreign form is held untyped by other rules.
	 */
	ownForm(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		if (ts.isParameterPropertyDeclaration(p, p.parent)) return false;
		return !this.forms().declaredForm(p).foreign && !isGeneric(this.checker.getTypeAtLocation(p.name)) && !this.forms().fixedSlot(p);
	},

	/** A parameter whose form holds null or undefined where its declared type admits neither. */
	givenEmpty(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const declared = this.forms().declaredForm(p),
			form = this.forms().formOfSlot(p);
		return (form.null && !declared.null) || (form.undefined && !declared.undefined);
	},
};

export type UntypedMethods = typeof untypedMethods;
