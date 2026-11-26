// Results as Swift: return types, results that may be undefined, awaited values and erased results.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { isFunctionType, isNullish, isOptional, nullishType, optionalElementsType, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { awaitSlot, type AwaitSlot } from '../semantics/placement.ts';
import { isLibDeclaration, implementationOf } from '../semantics/ast.ts';
import { classOverHeldResult, classOverHeldResultMessage, holdsGenericResult } from '../semantics/shapes.ts';
import { isAsync, isStatic } from '../semantics/throws.ts';
import { isTemplateMethod } from '../semantics/trust.ts';
import { baseMethod } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const resultsMethods = {
	/** A function type's result as its group holds it (`widenedResult`). */
	widenedResultType(this: Translator, sd: ts.SignatureDeclaration | undefined, t: string): string {
		if (sd && !ts.isJSDocSignature(sd as ts.Node) && this.states.optionalElements(sd)) return optionalElementsType(t);
		return sd && !ts.isJSDocSignature(sd as ts.Node) && t !== 'Void' && !isUntyped(spelledType(t)) && !isOptional(t) && !t.endsWith('!') && !isFunctionType(t) && this.states.widenedResult(sd) ? optionalType(t) : t;
	},

	/** The Swift type a function returns: `JSPromise<T>` for an async one. */
	returnTypeOf(this: Translator, fn: ts.SignatureDeclaration): string {
		if (this.states.nullish().held.has(fn) || this.states.fallbackResult(fn)) return 'Any?';
		const context = this.states.widenedContext(fn);
		if (context) return this.returnTypeOf(context);
		if (this.states.nullishHeld(fn)) return nullishType(this.type(this.states.resultType(fn), fn));
		if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && this.returnsMethod(fn)) return 'Any?';
		if (this.heldReturn(fn)) return 'Any?';
		const t = this.heldElements(fn, this.type(this.checker.getSignatureFromDeclaration(fn)!.getReturnType(), fn));
		if (this.states.lenientAsync(fn)) return t.replace(/^JSPromise<(.*)>$/, (_, v: string) => `JSPromise<${optionalType(v)}>`);
		return this.mayReturnUndefined(fn) && t !== 'Void' && !isUntyped(spelledType(t)) && !t.endsWith('?') && !t.endsWith('!') && !isFunctionType(t) ? optionalType(t) : t;
	},

	/** A member of a class extending a native one, whose signatures are the SDK's. */
	inNativeClass(this: Translator, fn: ts.Node): boolean {
		const cls = fn.parent;
		if (!cls || !ts.isClassLike(cls)) return false;
		for (let t: ts.Type | undefined = this.checker.getTypeAtLocation(cls); t?.isClassOrInterface();) {
			const base: ts.Type | undefined = this.checker.getBaseTypes(t)[0];
			if (!base) return false;
			if (base.getSymbol()?.declarations?.every((d) => d.getSourceFile().isDeclarationFile) && this.native.type(base)) return true;
			t = base;
		}
		return false;
	},
	/** Lenient code: an optional parameter TypeScript types without undefined is optional in Swift; reads convert it. */
	lenientParams(this: Translator, fn: ts.SignatureDeclaration) {
		if (!this.lenient) return;
		for (const p of fn.parameters) {
			// A parameter property is the field it declares as well: its reads are the field's.
			if (!p.questionToken || p.initializer || !ts.isIdentifier(p.name) || (ts.canHaveModifiers(p) && ts.getModifiers(p)?.length)) continue;
			const t = this.typeOf(p.name);
			const sym = this.checker.getSymbolAtLocation(p.name);
			if (sym && !isOptional(t) && !isUntyped(spelledType(t))) this.undefinedVars.set(sym, optionalType(t));
		}
	},

	/**
	 * Code checked without strictNullChecks: whether a function or static method
	 * returns undefined somewhere though its type says otherwise (a bare
	 * `return`, `return null`, an optional parameter's value). Swift returns an
	 * optional, and each caller reads it as JavaScript reads undefined there.
	 */
	mayReturnUndefined(this: Translator, fn: ts.SignatureDeclaration): boolean {
		if (fn.getSourceFile().isDeclarationFile) return false;
		if (this.states.widenedResult(fn)) return true;
		if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && (this.returnsUnsetElement(fn) || this.states.givesEmptyDefault(fn))) return true;
		// A non-strict app's function returning null (`return null` from a `Color` helper): optional too.
		// An async function or a generator gives its promise or iterator whatever its body returns; a template's binding
		// method gives the template's codegen, which takes the declared type.
		if (!this.lenient) return (this.lenientApp && 'body' in fn && !!fn.body && (ts.isFunctionDeclaration(fn) || (this.unfamiliedMethod(fn) && !isTemplateMethod(fn))) && !isAsync(fn) && !(fn as ts.FunctionDeclaration | ts.MethodDeclaration).asteriskToken && this.returnsUndefined(fn as ts.FunctionDeclaration | ts.MethodDeclaration)) || (!this.library && this.states.looseSlots.has(fn));
		if (ts.isMethodDeclaration(fn) && !isStatic(fn) && this.declaresNullableReturn(fn)) return true;
		// A function or getter declared `string | null`: a string, number or boolean it gives may be undefined.
		if ((ts.isGetAccessorDeclaration(fn) || ts.isFunctionDeclaration(fn) || (ts.isMethodDeclaration(fn) && isStatic(fn))) && fn.type && ts.isUnionTypeNode(fn.type) && fn.type.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword))) {
			const sig = this.checker.getSignatureFromDeclaration(fn);
			return !!sig && ['String', 'Double', 'Bool'].includes(this.type(sig.getReturnType(), fn));
		}
		if (!('body' in fn) || !fn.body) return false;
		if (ts.isFunctionDeclaration(fn) || (ts.isMethodDeclaration(fn) && isStatic(fn))) return this.returnsUndefined(fn);
		if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) return this.returnsUndefined(fn);
		const family = ts.isMethodDeclaration(fn) ? this.structMethodFamily(fn) : null;
		return !!family?.some((m) => !!m.body && this.returnsUndefined(m));
	},

	/**
	 * A method whose root declares it may give nothing (`getCssVariable(name: string): string | null`), which the lenient
	 * checker reads as the bare type: where that is a string, number or boolean, it and every override give an optional,
	 * as overrides share one signature.
	 */
	declaresNullableReturn(this: Translator, fn: ts.MethodDeclaration): boolean {
		let root = fn;
		for (let b = baseMethod(root, this.checker); b; b = baseMethod(root, this.checker)) root = b;
		const t = root.type;
		if (!t || !ts.isUnionTypeNode(t) || !t.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword))) return false;
		// An object is held implicitly unwrapped already, nil where undefined; only a string, number or boolean needs the optional.
		const sig = this.checker.getSignatureFromDeclaration(root);
		return !!sig && ['String', 'Double', 'Bool'].includes(this.type(sig.getReturnType(), root));
	},

	heldAwait(this: Translator, a: ts.AwaitExpression, v: string): [string, string] | undefined {
		const slot = this.lenientApp ? awaitSlot(this.placement, a, v, () => true) : null;
		if (!slot) return undefined;
		this.awaitSlots.set(a, slot);
		return [slot.target, this.awaitedValue(slot)];
	},
	/** The await's value read from its slot (U → P by kind): a null-only body's nothing reads as null does. */
	awaitedValue(this: Translator, slot: AwaitSlot): string {
		const t = this.typeOf(slot.a);
		if (slot.isNull && (t === 'Double' || t === 'String')) {
			heldLoss('awaitedNull', t === 'Double' ? '0' : '"null"');
			return t === 'Double' ? `(${slot.raw} ?? 0)` : `(${slot.raw} ?? "null")`;
		}
		return this.undefinedAs(slot.raw, t, slot.target);
	},
	/** The slot of the await `e` is, where its continuation holds the value optional. */
	awaited(this: Translator, e: ts.Expression): AwaitSlot | undefined {
		return this.awaitSlots.get(ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses));
	},

	/** A local Swift holds optional though its type says a value (`const x = f()` of a call that may give nothing). */
	heldOptionalLocal(this: Translator, e: ts.Expression, type: string): boolean {
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		const sym = ts.isIdentifier(e) ? this.resolve(e) : undefined;
		return !!sym && this.undefinedVars.get(sym) === optionalType(type);
	},

	/** An await whose continuation will hold its value optional (`heldAwait`), decided before the lowering made its slot. */
	lenientAwait(this: Translator, e: ts.Expression): boolean {
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		return ts.isAwaitExpression(e) && this.lenientApp && !!awaitSlot(this.placement, e, '', () => true);
	},

	/** A call (or an await of one) Swift holds optional where its type says a value, as the function may give nothing. */
	heldOptionalResult(this: Translator, e: ts.Expression): boolean {
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (this.lenientAwait(e)) return true;
		if (!ts.isCallExpression(e) || this.typeOf(e).endsWith('?')) return false;
		const d = this.checker.getResolvedSignature(e)?.getDeclaration();
		return !!d && !ts.isJSDocSignature(d) && ((this.mayReturnUndefined(d) && this.returnTypeOf(d).endsWith('?')) || this.optionalBindsResult(e, d) === 'optional');
	},

	/** An app's instance method no other method overrides or is overridden by, so its Swift signature is its own. */
	unfamiliedMethod(this: Translator, fn: ts.SignatureDeclaration): fn is ts.MethodDeclaration {
		return ts.isMethodDeclaration(fn) && !isStatic(fn) && ts.isClassLike(fn.parent) && !this.pluginFiles.has(fn.getSourceFile().fileName) && !baseMethod(fn, this.checker) && !this.overridesOf(fn).length;
	},

	returnsUndefined(this: Translator, fn: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression): boolean {
		let found = this.undefinedReturns.get(fn);
		if (found !== undefined) return found;
		found = false;
		const optionalParams = new Set(fn.parameters.filter((p) => p.questionToken && !p.initializer).map((p) => this.checker.getSymbolAtLocation(p.name)));
		const visit = (n: ts.Node) => {
			if (found || (n !== fn && ts.isFunctionLike(n))) return;
			if (ts.isReturnStatement(n)) gives(n.expression);
			ts.forEachChild(n, visit);
		};
		const gives = (e: ts.Expression | undefined): void => {
			// `a ?? b`, `a || b`: what the last operand gives when the first gives nothing; `c ? a : b`: either branch.
			while (e && ts.isParenthesizedExpression(e)) e = e.expression;
			while (e && ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) e = e.right;
			if (e && ts.isConditionalExpression(e)) {
				gives(e.whenTrue);
				gives(e.whenFalse);
				return;
			}
			const local = e && ts.isIdentifier(e) ? this.checker.getSymbolAtLocation(e)?.valueDeclaration : undefined;
			// A library call that may give undefined (`map.get(key)`), which the lenient checker reads as its value type.
			const sig = e && ts.isCallExpression(e) ? this.checker.getResolvedSignature(e)?.getDeclaration() : undefined;
			const declared = sig && !ts.isJSDocSignature(sig) ? sig.type : undefined;
			if (declared && isLibDeclaration(sig as ts.Declaration) && ts.isUnionTypeNode(declared) && declared.types.some((y) => y.kind === ts.SyntaxKind.UndefinedKeyword)) found = true;
			// A non-strict app's signal of an object made with null (`signal<Person>(null)`) reads nil until set.
			if (this.lenientApp && e && ts.isCallExpression(e) && !e.arguments.length && /^Signal<.+\?>$/.test(this.typeOf(e.expression))) found = true;
			// An optional parameter, or a local declared without a value, may still be undefined.
			if (!e || isNullish(e) || (ts.isCallExpression(e) && this.typeOf(e) === 'Void') || (ts.isIdentifier(e) && optionalParams.has(this.checker.getSymbolAtLocation(e))) || (local && ts.isVariableDeclaration(local) && (!local.initializer || isNullish(local.initializer)) && ts.findAncestor(local, (n) => n === fn))) found = true;
		};
		visit(fn.body!);
		this.undefinedReturns.set(fn, found);
		return found;
	},

	/**
	 * An instance method giving a native struct (`applySafeAreaInsets(): CGRect`), a string, a
	 * number or a boolean, with every override of its root: its result may be undefined, which
	 * none of them can hold, so where any of them may give undefined they all give an optional,
	 * as overrides share one signature.
	 */
	structMethodFamily(this: Translator, fn: ts.MethodDeclaration): ts.MethodDeclaration[] | null {
		const sig = this.checker.getSignatureFromDeclaration(fn);
		const t = sig && this.type(sig.getReturnType(), fn);
		// A string, number or boolean too: `_childIndexToNativeChildIndex(index?)` gives undefined for no index, which means "append".
		if (!sig || !(this.native.isStructType(t!) || t === 'Double' || t === 'String' || t === 'Bool') || this.inNativeClass(fn)) return null;
		let root = fn;
		for (let b = baseMethod(root, this.checker); b; b = baseMethod(root, this.checker)) root = b;
		return [root, ...(this.library ? this.overridesOf(root) : [])];
	},

	/** A generic function compiled with its type parameters erased (`makeParser<T>`): its result as this call instantiates it. */
	erasedResult(this: Translator, e: ts.CallExpression, code: string): string {
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		// `deref()` or `get()` of a weak reference read as held: the kit's `T?` of the held element.
		const callee = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		const receiver = ts.isPropertyAccessExpression(callee) && ['deref', 'get'].includes(callee.name.text) ? ts.skipOuterExpressions(callee.expression, ts.OuterExpressionKinds.Parentheses) : null;
		const weak = receiver && ts.isPropertyAccessExpression(receiver) ? this.heldWeakRef(receiver) : null;
		if (weak) {
			const declared = `${/^JSWeakRef<(.+)>[?!]?$/.exec(weak)![1]}?`,
				actual = this.typeOf(e);
			return declared === actual || actual === 'Void' ? code : this.convert(code, declared, actual);
		}
		// An overload's result is the implementation's in Swift: read as the overload types it (`getWindows(): NativeWindow[]` of a `WindowBase[]`).
		const impl = decl && !ts.isJSDocSignature(decl) && !decl.getSourceFile().isDeclarationFile && !('body' in decl && decl.body) ? implementationOf(decl) : null;
		if (impl && (ts.isMethodDeclaration(impl) || ts.isFunctionDeclaration(impl))) {
			const declared = this.returnTypeOf(impl),
				actual = this.typeOf(e);
			if (declared !== actual && actual !== 'Void' && this.classCast('', declared, actual) !== null) return this.classCast(code, declared, actual)!;
			// A held function's call is typed by the implementation: what a `void` overload gives is no value.
			const overloadVoid = !!(this.checker.getResolvedSignature(e)!.getReturnType().flags & ts.TypeFlags.Void);
			if (overloadVoid && declared !== 'Void' && !this.library && !ts.isExpressionStatement(ts.walkUpParenthesizedExpressions(e.parent)) && this.isClosureValue(e.expression)) return `(_ = ${code})`;
		}
		// A method of a generic class Swift has erased: what it gives is untyped.
		if (decl && !ts.isJSDocSignature(decl) && ts.isMethodDeclaration(decl) && ts.isClassLike(decl.parent) && decl.parent.typeParameters?.length && this.erasesGenerics(decl.parent)) {
			const declared = this.library ? this.returnTypeOf(decl) : this.emittedReturnType(decl),
				actual = this.typeOf(e);
			return declared === actual || actual === 'Void' ? code : this.convert(code, declared, actual);
		}
		// A method of an app's generic interface: its protocol erases the interface's type parameters.
		if (decl && !ts.isJSDocSignature(decl) && ts.isMethodSignature(decl) && this.erasingProtocol(decl)) {
			const declared = this.returnTypeOf(decl),
				actual = this.typeOf(e);
			return declared === actual || actual === 'Void' || declared === 'Void' ? code : this.convert(code, declared, actual);
		}
		const erased = this.erasedGeneric(e);
		if (!erased) return code;
		const { declared, actual } = erased;
		const cls = classOverHeldResult(e, this.checker);
		if (cls) throw this.error(e, classOverHeldResultMessage(cls));
		if (decl && !ts.isJSDocSignature(decl) && this.mayReturnUndefined(decl) && declared === optionalType(actual)) return code;
		if (isUntyped(spelledType(declared)) && actual !== 'Void' && this.castThrows(e)) return this.fromAnyChecked(code, actual, true).code;
		return declared === actual || actual === 'Void' ? code : this.convert(code, declared, actual);
	},

	/** A method of an app's generic interface that is a Swift protocol, which holds the interface's type parameters as `Any?`. */
	erasingProtocol(this: Translator, m: ts.MethodSignature): boolean {
		const iface = m.parent;
		return ts.isInterfaceDeclaration(iface) && !!iface.typeParameters?.length && !iface.getSourceFile().isDeclarationFile && this.protocols.has(this.topName(iface, iface.name.text));
	},

	/** A call of a function whose type parameters Swift erases: the result's Swift type and the type the call gives it. */
	erasedGeneric(this: Translator, e: ts.CallExpression): { declared: string; actual: string } | null {
		const raw = this.checker.getResolvedSignature(e)?.getDeclaration();
		const decl = raw && !ts.isJSDocSignature(raw) ? (implementationOf(raw) ?? raw) : raw;
		if (!decl || ts.isJSDocSignature(decl) || decl.getSourceFile().isDeclarationFile) return null;
		const held = holdsGenericResult(decl, this.checker);
		if (!held && (!decl.typeParameters?.length || ((!this.pluginFiles.has(decl.getSourceFile().fileName) || this.keepsGenerics(decl)) && !decl.typeParameters.some((tp) => this.erasesTypeParameter(tp))))) return null;
		return { declared: this.library ? this.returnTypeOf(decl) : this.emittedReturnType(decl), actual: this.typeOf(e) };
	},

	/**
	 * An erased function's result type, as its own file's translation declares it. A function its lenient code may give
	 * as undefined is optional there, which the conversion to the call's type unwraps; an object or array converts as it is.
	 */
	emittedReturnType(this: Translator, fn: ts.SignatureDeclaration): string {
		return this.inFile(fn.getSourceFile().fileName, () => {
			const ret = this.returnTypeOf(fn);
			return this.inNativeClass(fn) || !isFunctionType(ret) ? ret : this.lenientRef(ret);
		});
	},

	/** Checked without strictNullChecks, a library call's `T | undefined` (`map.get(k)`) reads as `T`; Swift still says it may be missing. */
	libMayBeUndefined(this: Translator, e: ts.CallExpression): boolean {
		if (!(this.lenient || this.lenientApp) || isOptional(this.typeOf(e)) || this.isAny(e)) return false;
		const sig = this.checker.getResolvedSignature(e)?.getDeclaration();
		const t = sig && !ts.isJSDocSignature(sig) ? sig.type : undefined;
		return !!t && isLibDeclaration(sig as ts.Declaration) && ts.isUnionTypeNode(t) && t.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword));
	},

	/**
	 * A native or kit object's receiver the program gives null or undefined (`presentTypedEmpty`), read without `?.`:
	 * JavaScript's TypeError where it is missing, as the throws analysis takes every `missingAtRead` receiver to throw.
	 */
	presentTypedReceiver(this: Translator, x: ts.Expression): string | null {
		const p = ts.walkUpParenthesizedExpressions(x.parent);
		if (!ts.isPropertyAccessExpression(p) || ts.skipOuterExpressions(p.expression, ts.OuterExpressionKinds.Parentheses) !== ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses) || ts.isOptionalChain(p)) return null;
		return this.states.presentTypedEmpty(ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses)) ? this.receiver(x, p.name.text) : null;
	},

	/** A call Swift has as optional though TypeScript types its result as a value (`getWindow()` that may return undefined). */
	givesUndefined(this: Translator, e: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (ts.isAwaitExpression(e) && this.lenientApp && this.states.lenientAsyncCall(e.expression)) return true;
		if (!ts.isCallExpression(e) || this.typeOf(e).endsWith('?')) return false;
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		return !!decl && !ts.isJSDocSignature(decl) && this.mayReturnUndefined(decl) && this.returnTypeOf(decl).endsWith('?');
	},

	/** A call read as a receiver, which `undefinedResult` leaves optional where its function may give nothing. */
	optionalResult(this: Translator, e: ts.Expression): boolean {
		return ts.isCallExpression(ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses)) && this.givesUndefined(e);
	},

	/**
	 * A generic function's result where an argument Swift holds optional binds its type parameter `T`: Swift infers `T`
	 * as that optional, so a `T?` result is `T??` ('nested') and a `T` result is optional though TypeScript types it present ('optional').
	 */
	optionalBindsResult(this: Translator, e: ts.CallExpression, decl: ts.SignatureDeclaration): 'nested' | 'optional' | null {
		const ret = decl.type;
		if (!decl.typeParameters?.length || !ret || !ts.isTypeReferenceNode(ret) || !ts.isIdentifier(ret.typeName) || ret.typeArguments) return null;
		const name = ret.typeName.text,
			swift = this.returnTypeOf(decl);
		if (!decl.typeParameters.some((p) => p.name.text === name) || (swift !== name && swift !== `${name}?`)) return null;
		const bound = decl.parameters.some((p, i) => !!p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName) && p.type.typeName.text === name && i < e.arguments.length && this.heldOptional(e.arguments[i]));
		return !bound ? null : swift === name ? 'optional' : 'nested';
	},

	/** Whether Swift holds `e` optional: its type says so, or it reads a parameter its function spells optional. */
	heldOptional(this: Translator, e: ts.Expression): boolean {
		if (isOptional(this.typeOf(e))) return true;
		const d = ts.isIdentifier(e) ? this.resolve(e)?.valueDeclaration : undefined;
		return !!d && ts.isParameter(d) && ts.isIdentifier(d.name) && (isOptional(this.paramType(d)) || this.optionalWidened(d));
	},

	/** A call of a function that may return undefined, read where its declared type is wanted: as JavaScript converts undefined there. */
	undefinedResult(this: Translator, e: ts.CallExpression, call: string): string {
		const sig = this.checker.getResolvedSignature(e)?.getDeclaration();
		const bound = sig && !ts.isJSDocSignature(sig) ? this.optionalBindsResult(e, sig) : null;
		const code = bound === 'nested' ? `(${call} ?? nil)` : call;
		if (this.rawOptional.has(e)) return code;
		// A receiver (`f().x`): the member read unwraps it, as for any call that may give undefined.
		if ((ts.isPropertyAccessExpression(e.parent) || ts.isElementAccessExpression(e.parent)) && e.parent.expression === e) return code;
		if (bound === 'optional' && !isOptional(this.typeOf(e)) && !this.isAny(e)) {
			const field = this.states.placedField(e);
			return field ? this.marks.tryCode(`${RT.jsRequired}(${code}, ${swiftString(field.name)})`) : this.undefinedAs(code, this.typeOf(e), optionalType(this.typeOf(e)));
		}
		// A map's value read where a value of its type is wanted: a missing one as the type reads undefined.
		if (this.libMayBeUndefined(e) && ts.isPropertyAccessExpression(e.expression) && /^JS(Map|WeakMap)</.test(this.typeOf(e.expression.expression).replace(/[?!]$/, ''))) return this.undefinedAs(code, this.typeOf(e), optionalType(this.typeOf(e)));
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		if (!decl || ts.isJSDocSignature(decl) || !this.mayReturnUndefined(decl) || !this.returnTypeOf(decl).endsWith('?')) return code;
		const t = this.typeOf(e);
		if (t.endsWith('?') || isUntyped(spelledType(t))) return code;
		const field = this.states.nullOnlyResult(decl) ? null : this.states.placedField(e);
		return field ? this.marks.tryCode(`${RT.jsRequired}(${code}, ${swiftString(field.name)})`) : this.undefinedAs(code, t, this.returnTypeOf(decl));
	},
};
