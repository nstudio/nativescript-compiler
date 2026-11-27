// Loose, lenient and tolerated reads as Swift: values non-strict code reads where its types say otherwise.
import ts from 'typescript';
import { balanced, functionParts, hasTopLevelArrow, isFunctionType, isOptional, splitTopLevel, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { accessedDeclaration, evolvingElementContext, isSelf } from '../semantics/lang.ts';
import { hasModifier, isWriteTarget, notIterable } from '../semantics/ast.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const lenientMethods = {
	/** A loose value where Swift needs it present: JavaScript's TypeError for what the place does with undefined. */
	required(this: Translator, e: ts.Expression, code: string): string {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (ts.isCallExpression(p) && p.expression === x) return `${RT.jsCallable}(${code}, ${swiftString(e.getText().replace(/\s+/g, ' '))})`;
		if (ts.isForOfStatement(p) || ts.isSpreadElement(p)) return `${RT.jsIterated}(${code}, ${swiftString(notIterable(e))})`;
		if ((ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.initializer === x && !ts.isIdentifier(p.name)) {
			const first = ts.isObjectBindingPattern(p.name) ? p.name.elements[0] : undefined;
			const key = first && !first.dotDotDotToken ? (first.propertyName ?? first.name) : undefined;
			return `${RT.jsDestructured}(${code}, ${key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? swiftString(key.text) : 'nil'})`;
		}
		const present = this.presentCode(code, this.typeOf(e));
		if (present !== code) return present;
		const c = this.marks.markOf(code),
			required = c?.op === 'try' ? c.of.mark : c;
		if (required?.op === 'helper' && required.name === 'jsObjectRequired') return code;
		// A function value through its cell's own check: a generic one would hand back another closure, which `===` tells apart.
		const fn = this.typeOf(e).replace(/^\((.*)\)[?!]$/, '$1');
		const cell = isFunctionType(fn) ? this.functionCell(fn) : null;
		return cell ? `${cell}.present(${code})` : this.marks.helper('jsObjectRequired', code);
	},

	/** `e`'s value of type `from` converted to `to`, as `coerce` converts a value it places: in its own slot, not the enclosing one's. */
	convertPlaced(this: Translator, e: ts.Expression, from: string, to: string): string {
		const saved = [this.optionalSlot, this.presentFunction] as const;
		this.optionalSlot = this.lenient && this.looseTolerated(e) && !this.presentSlot;
		this.presentFunction = this.declaredFunction(e) ? e : null;
		try {
			return this.convert(this.expr(e), from, to);
		} finally {
			[this.optionalSlot, this.presentFunction] = saved;
		}
	},

	/** Whether `code` is the function `presentFunction` is, as written: a closure, a method's value or a declared function's name. */
	isPresentFunction(this: Translator, code: string): boolean {
		const e = this.presentFunction && ts.skipOuterExpressions(this.presentFunction, ts.OuterExpressionKinds.Parentheses);
		if (!e) return false;
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return /^\{[\s\S]*\}$/.test(code) && balanced(code);
		if (ts.isPropertyAccessExpression(e)) return /^(jsMethodValue\(|\(\{ \(\) (throws )?-> [^{]* in let __held)/.test(code) && balanced(code);
		return ts.isIdentifier(e) && code === this.refName(e);
	},

	declaredFunction(this: Translator, e: ts.Expression): boolean {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return true;
		if (!ts.isIdentifier(x) && !(ts.isPropertyAccessExpression(x) && !ts.isOptionalChain(x))) return false;
		const d = this.resolve(ts.isPropertyAccessExpression(x) ? x.name : x)?.valueDeclaration;
		return !!d && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d));
	},

	/**
	 * Lenient code: an object value Swift holds optional though TypeScript types it present (a field, parameter or
	 * result core declares without null), as JavaScript lets undefined be anything's value.
	 */
	loose(this: Translator, x: ts.Expression): boolean {
		if (this.checkedNodes.has(x)) return false;
		if (!this.lenient) return this.lenientValue(x) || this.nullObjectSignalRead(x) || this.looseObjectRead(x) || (ts.isCallExpression(x.parent) && x.parent.expression === x && this.lenientAppOptional(x)) || this.unsetGroupReceiver(x);
		// A name that is no value read: a member's name after its dot, a declaration's own name, a label.
		if (ts.isIdentifier(x)) {
			const p = x.parent;
			if ((ts.isPropertyAccessExpression(p) && p.name === x) || ((ts.isDeclarationStatement(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isBindingElement(p) || ts.isAccessor(p) || ts.isEnumMember(p) || ts.isPropertySignature(p)) && (p as ts.NamedDeclaration).name === x) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isTypeNode(p) || ts.isQualifiedName(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p))
				return false;
		}
		while (ts.isParenthesizedExpression(x)) x = x.expression;
		if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined')) return false;
		// What `new` constructs is a class.
		if (ts.isNewExpression(x.parent) && x.parent.expression === x) return false;
		if ((x.kind === ts.SyntaxKind.ThisKeyword && !this.thisParameter(x)) || x.kind === ts.SyntaxKind.SuperKeyword || ts.isNewExpression(x) || ts.isObjectLiteralExpression(x) || ts.isArrayLiteralExpression(x) || ts.isFunctionLike(x) || ts.isClassExpression(x) || ts.isLiteralExpression(x) || ts.isTemplateExpression(x) || this.nativeConstruction(x) || this.native.presentResult(x)) return false;
		if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
			const sym = this.resolve(ts.isPropertyAccessExpression(x) ? x.name : x);
			if (sym && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.Module | ts.SymbolFlags.Function | ts.SymbolFlags.Method)) return false;
			// The language's and the platform's own objects (`Math`, `Number`), and a promise executor's resolve and reject, are always there.
			if (ts.isIdentifier(x) && sym && (sym.declarations ?? []).length && sym.declarations!.every((d) => d.getSourceFile().isDeclarationFile)) return false;
			// A namespace's member (`interop.types.bool`) is always there.
			if (ts.isPropertyAccessExpression(x) && (this.resolve(ts.isPropertyAccessExpression(x.expression) ? x.expression.name : x.expression)?.flags ?? 0) & ts.SymbolFlags.Module && !!sym?.declarations?.length && sym.declarations.every((d) => d.getSourceFile().isDeclarationFile)) return false;
			if (sym && this.resolvers.has(sym)) return false;
			const d = sym?.valueDeclaration;
			if (ts.isIdentifier(x) && d && ts.isVariableDeclaration(d) && (this.madePresent(d) || this.presentConstant(d))) return false;
		}
		let t: string;
		try {
			t = this.typeOf(x);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
		if (this.nullableRef(t) !== t) return true;
		if (['Double', 'String', 'Bool', 'Any?', 'Void', 'Never'].includes(t) || isOptional(t)) return false;
		if (this.native.optionalRead(x)) return true;
		// A value of another type Swift holds optional: a variable that may be undefined, an element read past the end, a native collection maybe nil.
		if (ts.isElementAccessExpression(x)) return /^JSArray</.test(this.typeOf(x.expression).replace(/[?!]$/, ''));
		const sym = ts.isIdentifier(x) ? this.resolve(x) : undefined;
		if (!sym) return false;
		if (isOptional(this.undefinedVars.get(sym) ?? '')) return true;
		const d = sym.valueDeclaration;
		if (d && ts.isParameter(d) && this.states.mayBeNull(d)) return true;
		// An untyped name narrowed to a native collection (`data instanceof NSArray`) is read through a conditional cast.
		if (t.startsWith('[') && d && (ts.isParameter(d) || ts.isVariableDeclaration(d)) && this.checker.getTypeAtLocation(d).flags & ts.TypeFlags.Any) return true;
		return t.startsWith('[') && !!d && ts.isVariableDeclaration(d) && !!ts.findAncestor(d, ts.isFunctionLike);
	},

	/**
	 * Whether a loose value goes where Swift takes it optional, as JavaScript takes undefined: a test, a comparison, a
	 * variable, field or result core declares (all optional), an object parameter of a function of the program.
	 * Anywhere else (a native method's parameter, a function parameter, an array's element) it is required, and
	 * `jsRequired` throws where it is missing. An under-estimate only costs a `throws`; `coerce` writes the check
	 * only where the slot is not optional.
	 */
	looseTolerated(this: Translator, e: ts.Expression): boolean {
		if (!this.lenient) return this.strictTolerated(e);
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent) || ts.isAsExpression(x.parent) || ts.isNonNullExpression(x.parent) || ts.isTypeAssertionExpression(x.parent) || ts.isSatisfiesExpression(x.parent)) x = x.parent;
		const p = x.parent;
		const K = ts.SyntaxKind;
		if (!p) return true;
		if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === x) return true;
		if (ts.isElementAccessExpression(p) && p.argumentExpression === x) return true;
		if (ts.isBinaryExpression(p)) {
			const op = p.operatorToken.kind;
			if (op === K.EqualsToken || op === K.BarBarEqualsToken || op === K.QuestionQuestionEqualsToken || op === K.AmpersandAmpersandEqualsToken) return p.left === x || this.optionalPlace(p.left);
			// An operator converts undefined as JavaScript does (`d1 <= d2` of a missing date is false).
			return true;
		}
		if (ts.isPrefixUnaryExpression(p) || ts.isTypeOfExpression(p) || ts.isVoidExpression(p) || ts.isDeleteExpression(p) || ts.isExpressionStatement(p)) return true;
		if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === x) return true;
		if (ts.isForStatement(p) && p.condition === x) return true;
		// `for (k in undefined)` runs no iteration.
		if (ts.isForInStatement(p) && p.expression === x) return true;
		// A tuple's element Swift holds optional (`[property, value]` as `(CssProperty?, Color?)`).
		if (ts.isArrayLiteralExpression(p)) {
			let t: string;
			try {
				t = this.typeOf(p).replace(/\?$/, '');
			} catch (e) {
				rethrowUnlessRefused(e);
				return false;
			}
			const parts = /^\(.*\)$/.test(t) && !hasTopLevelArrow(t) ? splitTopLevel(t.slice(1, -1)) : null;
			const part = parts?.[p.elements.indexOf(x as ts.Expression)];
			return !!part && (isOptional(part) || isUntyped(spelledType(part)));
		}
		if (ts.isConditionalExpression(p)) return p.condition === x || this.looseTolerated(p);
		if (ts.isTemplateSpan(p)) return true;
		if (ts.isVariableDeclaration(p)) return p.initializer === x && ts.isIdentifier(p.name);
		if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) return this.dynamicLiterals.has(p.parent) || this.shapeFieldTakesUndefined(p);
		if (ts.isSpreadAssignment(p) || (ts.isPropertyDeclaration(p) && p.initializer === x)) return true;
		if (ts.isReturnStatement(p)) {
			const fn = ts.findAncestor(p, ts.isFunctionLike);
			if (!fn || !(ts.isFunctionDeclaration(fn) || ((ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)) && !ts.isObjectLiteralExpression(fn.parent)))) return false;
			if (hasModifier(fn, ts.SyntaxKind.AsyncKeyword)) {
				const result = this.returnTypeOf(fn).replace(/[?!]$/, '');
				const inner = result.startsWith('JSPromise<') && result.endsWith('>') ? result.slice(10, -1) : result;
				return isOptional(inner) || isUntyped(spelledType(inner));
			}
			if (!this.inNativeClass(fn)) return true;
			// A native class's own getter is optional as lenient code's are; a native member's or own method's result is as declared.
			if (ts.isGetAccessorDeclaration(fn)) {
				// A native property's getter returns what Swift declares it to: missing, where that is optional (`window` of a scene delegate).
				const native = this.native.nativeGetterType(fn);
				if (native === null || /[?!]$/.test(native)) return true;
			}
			const result = this.returnTypeOf(fn);
			return isOptional(result) || isUntyped(spelledType(result));
		}
		if (ts.isCallExpression(p) && p.arguments[0] === x && this.missingKeyLookup(p)) return true;
		if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== x) {
			const k = p.arguments?.indexOf(x as ts.Expression) ?? -1;
			const signature = this.checker.getResolvedSignature(p);
			const decl = signature?.getDeclaration();
			if (k >= 0 && decl && !ts.isJSDocSignature(decl) && decl.getSourceFile().isDeclarationFile) {
				const native = ts.isCallExpression(p) ? this.native.argumentOptional(p, k) : undefined;
				if (native !== undefined) return native;
				// `f.call(thisArg, …)`: the receiver JavaScript passes, undefined as well.
				const owner = (decl.parent as ts.Node & { name?: ts.Node }).name?.getText();
				if (k === 0 && ['call', 'apply', 'bind'].includes(decl.name?.getText() ?? '') && ['Function', 'CallableFunction', 'NewableFunction'].includes(owner ?? '')) return true;
				// A library function's parameter of any value (`push(...items: any[])` of an `any[]`, `Object.assign(target, …)`) takes undefined as it is.
				// An untyped `[]` allocated as its stated `T[]` takes a `T` as that array's `push` does.
				if (evolvingElementContext(x as ts.Expression, this.checker, this.holeless)) return false;
				const params = decl.parameters.filter((d) => !(ts.isIdentifier(d.name) && d.name.text === 'this'));
				const param = params[Math.min(k, params.length - 1)];
				const sym = signature!.getParameters()[Math.min(k, signature!.getParameters().length - 1)];
				if (!param || !sym) return false;
				let t = this.checker.getTypeOfSymbolAtLocation(sym, p);
				if (param.dotDotDotToken && this.checker.isArrayType(t)) t = this.checker.getTypeArguments(t as ts.TypeReference)[0] ?? t;
				return !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
			}
			if (k < 0 || !decl || ts.isJSDocSignature(decl) || decl.getSourceFile().isDeclarationFile || this.inNativeClass(decl)) return false;
			// A function value (`callback: (uiColor: UIColor) => void`) takes what its Swift type's parameter does.
			if (!('body' in decl && decl.body)) {
				if (!ts.isFunctionTypeNode(decl) && !ts.isCallSignatureDeclaration(decl)) return false;
				let held: string;
				try {
					held = this.typeOf(p.expression).replace(/^\((.*)\)[?!]$/, '$1');
				} catch (e) {
					rethrowUnlessRefused(e);
					return false;
				}
				const param = functionParts(held)?.params[k]?.replace(/^@escaping /, '');
				return !!param && (isOptional(param) || isUntyped(spelledType(param)));
			}
			const param = decl.parameters[Math.min(k, decl.parameters.length - 1)];
			if (!param || param.dotDotDotToken) return false;
			if (param.questionToken || param.initializer) return true;
			// A parameter declared to take undefined (`color: Color | undefined`), or one Swift takes untyped (`Color.equals(value1: IColor, …)`), takes it as it is.
			if (param.type && ts.isUnionTypeNode(param.type) && param.type.types.some((t) => t.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword))) return true;
			try {
				const t = this.typeOf(param.name);
				if (isUntyped(spelledType(t)) || isOptional(t)) return true;
			} catch (e) {
				rethrowUnlessRefused(e);
				/* a binding pattern */
			}
			return this.states.mayBeNull(param);
		}
		return false;
	},

	/**
	 * A signal holding a null its type does not admit (`signal<Person>(null)` in a non-strict app), read as the type,
	 * as script reads it: Swift holds it optional, checked where the object is needed (see `loose`).
	 */
	nullObjectSignalRead(this: Translator, x: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(x)) x = x.expression;
		if (!this.nullSignalRead(x)) return false;
		const t = this.typeOf(x);
		return !isFunctionType(t) && this.nullableRef(t) !== t;
	},

	nullSignalRead(this: Translator, e: ts.Expression): boolean {
		if (!ts.isCallExpression(e) || e.arguments.length || !['writable', 'input', 'computed'].includes(this.framework.signalKind(this.symbolName(e.expression)) ?? '')) return false;
		const callee = e.expression;
		if (ts.isPropertyAccessExpression(callee) && isSelf(callee.expression, this.subst) && (this.computed.has(callee.name.text) || this.props.has(callee.name.text) || this.signalFields.has(callee.name.text))) return false;
		// A component's computed field is typed as its value (`JSArray<Any?>`), which is no signal.
		try {
			return /^Signal<.*\?>$/.test(this.typeOf(callee)) && !/\?$/.test(this.typeOf(e));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/**
	 * Strict code: a value lenient code declares (a function's result, a field), which Swift holds optional though
	 * TypeScript types it present. Strict code checks it where it needs the object or function, as lenient code checks its own.
	 */
	lenientValue(this: Translator, x: ts.Expression): boolean {
		if (!this.lenientFiles.size) return false;
		while (ts.isParenthesizedExpression(x)) x = x.expression;
		let decl: ts.Declaration | undefined;
		if (ts.isCallExpression(x)) {
			const d = this.checker.getResolvedSignature(x)?.getDeclaration();
			if (!d || ts.isJSDocSignature(d) || !(ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) || !d.body || ts.isObjectLiteralExpression(d.parent) || this.inNativeClass(d)) return false;
			decl = d;
		} else if (ts.isPropertyAccessExpression(x) || ts.isIdentifier(x)) {
			if (ts.isIdentifier(x) && ts.isPropertyAccessExpression(x.parent) && x.parent.name === x) return false;
			const sym = this.resolve(ts.isPropertyAccessExpression(x) ? x.name : x);
			// A getter lenient code declares gives what its type does, held optional as its fields are.
			const d = accessedDeclaration(sym, isWriteTarget(x));
			const parameterField = !!d && ts.isParameter(d) && ts.isParameterPropertyDeclaration(d, d.parent);
			if (!d || !(ts.isPropertyDeclaration(d) || ts.isGetAccessorDeclaration(d) || parameterField || (ts.isVariableDeclaration(d) && ts.isSourceFile(d.parent.parent.parent))) || ((ts.isPropertyDeclaration(d) || ts.isGetAccessorDeclaration(d)) && this.inNativeClass(d)) || (parameterField && this.inNativeClass(d.parent as ts.ConstructorDeclaration))) return false;
			decl = d;
		} else return false;
		const file = decl.getSourceFile();
		if (file.isDeclarationFile || !this.lenientFiles.has(file.fileName)) return false;
		if (ts.isVariableDeclaration(decl) && this.inFile(file.fileName, () => this.presentConstant(decl as ts.VariableDeclaration))) return false;
		let t: string;
		// A chain's link (`a?.b`) is typed optional for the chain; lenient code holds the member as its own type says.
		try {
			t = (ts.isPropertyAccessExpression(x) && ts.isOptionalChain(x) ? this.declaredTypeOf(x) : null) ?? this.typeOf(x);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
		return this.nullableRef(t) !== t;
	},

	/** `f` evaluated as translating `file`: what is lenient is that file's. */
	inFile<T>(this: Translator, file: string, f: () => T): T {
		const saved = this.currentFile;
		this.currentFile = file;
		try {
			return f();
		} finally {
			this.currentFile = saved;
		}
	},

	/** Strict code: where a value lenient code holds optional may go as it is (a test, a comparison, an optional place). */
	strictTolerated(this: Translator, e: ts.Expression): boolean {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (!p) return true;
		if (this.states.takesUndefined(x as ts.Expression)) return true;
		if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === x) return true;
		if (ts.isBinaryExpression(p)) {
			const op = p.operatorToken.kind;
			if (op === ts.SyntaxKind.EqualsToken) return p.left === x || isOptional(this.typeOf(p.left));
			// `a ?? b`, `a || b`: the left is tested; the right is the value.
			return [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(op) ? p.left === x : true;
		}
		if (ts.isPrefixUnaryExpression(p) || ts.isTypeOfExpression(p) || ts.isVoidExpression(p) || ts.isExpressionStatement(p) || ts.isTemplateSpan(p)) return true;
		if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p) || ts.isForInStatement(p)) && p.expression === x) return true;
		if (ts.isConditionalExpression(p)) return p.condition === x || this.optionalChoice(p);
		if (ts.isVariableDeclaration(p) && p.initializer === x && ts.isIdentifier(p.name)) return isOptional(this.typeOf(p.name));
		if (ts.isReturnStatement(p)) return isOptional(this.returnType);
		return false;
	},

	/** Strict code's conditional returned as an optional result or initializing an optional variable. */
	optionalChoice(this: Translator, e: ts.ConditionalExpression): boolean {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (ts.isReturnStatement(p)) return isOptional(this.returnType) && !isUntyped(spelledType(this.returnType));
		if (ts.isVariableDeclaration(p) && p.initializer === x && ts.isIdentifier(p.name)) {
			const t = this.typeOf(p.name);
			return isOptional(t) && !isUntyped(spelledType(t));
		}
		return false;
	},

	/**
	 * Whether a literal's property takes undefined as it is: lenient code's shapes hold their object fields optional, and
	 * an object of no shape holds any value. A program with strict code beside lenient code shares shapes held as typed.
	 */
	shapeFieldTakesUndefined(this: Translator, p: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean {
		if (this.lenientAll) return true;
		let t: string;
		try {
			t = this.typeOf(p.parent).replace(/[?!]$/, '');
		} catch (e) {
			rethrowUnlessRefused(e);
			return true;
		}
		const field = this.shapes.named(t)?.fields.find((f) => f.name === p.name.getText());
		return !field || isOptional(field.type) || this.nullableRef(field.type) === field.type;
	},

	/** Whether an assignment's target is a place Swift holds optional in lenient code (a variable or field of an object type). */
	optionalPlace(this: Translator, left: ts.Expression): boolean {
		// A native property written as a statement (`view.backgroundColor = color`), not an assignment read as a value.
		if (ts.isPropertyAccessExpression(left)) {
			const native = this.native.propertyOptional(left);
			if (native !== undefined) return native && ts.isExpressionStatement(left.parent.parent);
			// A member of an object Swift holds untyped, or one script adds to a native object, is written by `jsSet`, which stores undefined.
			if (this.isAny(left.expression) || this.isExpando(left)) return true;
		}
		// A keyed place of any value (`rule[animationsSymbol] = …`).
		if (ts.isElementAccessExpression(left)) {
			try {
				if (this.isAny(left)) return true;
			} catch (e) {
				rethrowUnlessRefused(e);
				return false;
			}
		}
		const d = accessedDeclaration(this.resolve(ts.isPropertyAccessExpression(left) ? left.name : left), true);
		return !!d && (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isParameter(d) || ts.isAccessor(d)) && !d.getSourceFile().isDeclarationFile && !(ts.isAccessor(d) && this.inNativeClass(d));
	},

	/** Whether `this` here is a function's declared parameter (`function f(this: View)`), which Swift takes as an argument. */
	thisParameter(this: Translator, x: ts.Node): boolean {
		const fn = ts.findAncestor(x.parent, (n) => ts.isFunctionLike(n) && !ts.isArrowFunction(n)) as ts.SignatureDeclaration | undefined;
		return !!fn && fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === 'this');
	},
};
