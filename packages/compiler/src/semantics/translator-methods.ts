// Methods both translators install on their prototypes, as each installs its own method groups: the front's answers to
// questions a translator is asked through `this` (by the front's StateBackend, by adapters through the adapter API).
import ts from 'typescript';
import type { StateBackend } from './states/value-states.ts';
import { isEventDataSymbol, inheritedMethod, redeclaredField, rootMethod, type LiteralClassBackend } from './classes.ts';
import { isStatic, type Throws } from './throws.ts';
import { definesRunTimeKey, keyOf, madeBit, memberPlanOf, shapePlanOfClass, type MadeKeys, type ShapeFacts, type ShapePlan } from './shapes.ts';
import type { ValueStates } from './states/value-states.ts';
import { declaresThis, isWriteTarget, notIterable, resolveSymbol, thisNodes } from './ast.ts';
import { augmentedPropertyRead, ignoresThisArg, iterationThrows, thisArgCall, withoutThisArg, WELL_KNOWN_MEMBERS, type ThisArgUse } from './lang.ts';
import { isLibDeclaration } from './ast.ts';
import { isLibGlobal } from './globals.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import type { ProgramFacts } from './facts.ts';
import type { UnsetGroupTyping } from './regexp.ts';
import { traceMethods } from './decision-trace.ts';
import { GENERIC_ARRAY_METHODS } from './apis/array.ts';
import { conversionThrows, heldArithmetic, untypedArithmetic, untypedOperation, type KeyConversion, type UntypedOperation } from './apis/operators.ts';
import { byKey, type TypeReader } from './spelled.ts';
import { isKit, isPrimitive, isUntyped, parseNativeType, sameType, type NativeType } from './types.ts';
import { rethrowUnlessRefused } from './refusals.ts';
import type { CompilerRefusalId } from '../api/adapter-api.ts';
import { assignsClassFields, classPlanOf, type AccessorPair, type ClassPlan } from './class-plan.ts';
import { constantInitializer, type ConstantHost } from './constant-init.ts';
import { programSymbolKey } from '../program/stable-names.ts';
import { functionNew, unmodelledIntl, unmodelledIntlMember, wrapperObject } from './refuse-construction.ts';
import { bufferPrototype, builtinMethodReceiver, builtinPrototypeReceiver, classPrototypeMember, programMethodReceiver } from './refuse-receivers.ts';
import { elementAccessor, functionThis, storedFunctionThis, untypedPrivateReceiver } from './refuse-scope.ts';

type KeyHost = { readonly states: ValueStates; shapeFacts(): ShapeFacts };

type Front = Pick<StateBackend, 'checker' | 'sourceFiles' | 'pluginFiles' | 'ledger'> & LiteralClassBackend & { readonly facts: ProgramFacts; error(n: ts.Node, what: string, id?: CompilerRefusalId): Error };

const SYMBOL = parseNativeType('JSSymbol');

/** A member named by a symbol (`frontMethods.symbolMemberOf`). */
export interface SymbolMember {
	readonly member: string;
	/** `fixed`: `fixedKey`. */
	readonly key: { readonly of: ts.Expression; readonly either: boolean; readonly fixed: boolean } | null;
}

/**
 * A computed member key JavaScript reads once, where the class is defined, which reads the same at any later read that does
 * not throw: a module's `const` (through imports), or a class's own readonly field of one (not an interface's `readonly`
 * property signature, which a mutable object may back).
 */
export function fixedKey(e: ts.Expression, checker: ts.TypeChecker): boolean {
	if (ts.isIdentifier(e)) {
		const d = resolveSymbol(e, checker)?.valueDeclaration;
		const statement = d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) ? d.parent.parent : undefined;
		return !!statement && ts.isVariableStatement(statement) && (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent)) && (ts.getCombinedNodeFlags(d!) & ts.NodeFlags.Const) !== 0;
	}
	if (!ts.isPropertyAccessExpression(e) || e.questionDotToken) return false;
	const receiver = checker.getTypeAtLocation(e.expression).getSymbol()?.valueDeclaration;
	if (!receiver || !ts.isClassLike(receiver)) return false;
	const decls = checker.getSymbolAtLocation(e.name)?.declarations ?? [];
	return decls.length > 0 && decls.every((d) => ts.isPropertyDeclaration(d) && ts.isClassLike(d.parent) && (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly) !== 0) && fixedKey(e.expression, checker);
}

export const frontMethods = traceMethods('front', {
	/** The symbol a name refers to, through imports; a shorthand property's name (`{ name }`) refers to what it reads. */
	resolve(this: Front, n: ts.Node): ts.Symbol | undefined {
		return resolveSymbol(n, this.checker);
	},

	/** Refuses `elementAccessor` and `definesRunTimeKey` calls in app code where a program class's declared field may be the key (`heldOpenWithFields`). */
	refuseRunTimeDefine(this: Front, e: ts.CallExpression): void {
		const accessor = elementAccessor(e, this);
		if (accessor) throw this.error(accessor.node, accessor.what, accessor.id);
		if (this.library || this.pluginFiles.has(e.getSourceFile().fileName) || !definesRunTimeKey(e, this.checker)) return;
		const cls = this.facts.heldOpenWithFields();
		if (cls) throw this.error(e, `Object.${(e.expression as ts.PropertyAccessExpression).name.text} with a key known only at run time on an untyped object that may be a \`${cls.name?.text ?? 'class'}\`, whose declared fields keep no descriptor`);
	},

	/** Refuses an unmodelled `Intl` service, prototype or constructor read as a value (`unmodelledIntl`). */
	refuseIntl(this: Front, e: ts.Node): void {
		const target = ts.isPropertyAccessExpression(e) ? e : ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e ? e.parent : undefined;
		if (!target) return;
		const r = unmodelledIntl({ checker: this.checker, library: this.library, resolve: (n) => resolveSymbol(n, this.checker) }, target);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses an unmodelled member read off `Intl.NumberFormat` or `Intl.DateTimeFormat` (`unmodelledIntlMember`). */
	refuseIntlMember(this: Front, e: ts.Node): void {
		if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return;
		const r = unmodelledIntlMember({ checker: this.checker, library: this.library, resolve: (n) => resolveSymbol(n, this.checker) }, e);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses `new String(…)`, `new Number(…)`, `new Boolean(…)` wrapper objects in app mode (`wrapperObject`). */
	refuseWrapper(this: Front, e: ts.NewExpression): void {
		const r = wrapperObject({ checker: this.checker, library: this.library, resolve: (n) => resolveSymbol(n, this.checker) }, e);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses `new f()` of a plain function with no construct signature in app mode (`functionNew`). */
	refuseFunctionNew(this: Front, e: ts.NewExpression): void {
		const r = functionNew({ checker: this.checker, library: this.library, resolve: (n) => resolveSymbol(n, this.checker) }, e);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses `.call`/`.apply`/`.bind` of a built-in or program method with a receiver neither backend models. */
	refuseCallReceiver(this: Front, e: ts.CallExpression): void {
		const lib = !!this.library;
		const r = builtinPrototypeReceiver(e, this.checker, lib) ?? builtinMethodReceiver(e, this.checker, lib) ?? programMethodReceiver(e, this.checker, lib);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses reading a class's declared instance member or `constructor` off `C.prototype` (`classPrototypeMember`). */
	refuseClassPrototype(this: Front, e: ts.PropertyAccessExpression): void {
		const r = classPrototypeMember(e, this.checker, !!this.library);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses an unmodelled buffer type's prototype (`DataView.prototype`, `bufferPrototype`). */
	refuseBufferPrototype(this: Front, e: ts.PropertyAccessExpression): void {
		const r = bufferPrototype(e, this.checker);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses `this` in a function reading `arguments` and `#x` on an untyped receiver (`functionThis`, `untypedPrivateReceiver`). */
	refuseScopedExpr(this: Front, e: ts.Expression): void {
		const r = functionThis(e, { checker: this.checker, library: this.library, readsArguments: (fn) => frontMethods.readsArguments.call(this, fn) }) ?? untypedPrivateReceiver(e, this);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/** Refuses `this` in a function expression stored in a typed object slot (`storedFunctionThis`). */
	refuseStoredThis(this: Front, e: ts.Node): void {
		const r = storedFunctionThis(e, this);
		if (r) throw this.error(r.node, r.what, r.id);
	},

	/**
	 * App mode: a function-typed field script reads as a function object (`ProgramFacts.functionObjectFields`), held
	 * untyped as the function object it is given.
	 */
	holdsFunctionObject(this: Front, n: ts.Node): boolean {
		if (this.library) return false;
		const decl = ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) ? n : ts.isIdentifier(n) && n.parent && (ts.isPropertyDeclaration(n.parent) || ts.isPropertySignature(n.parent)) && n.parent.name === n ? n.parent : ts.isPropertyAccessExpression(n) ? this.checker.getSymbolAtLocation(n.name)?.valueDeclaration : undefined;
		return !!decl && this.facts.functionObjectFields().has(decl);
	},

	/**
	 * A method some subclass overrides, which `X.prototype.m.call(obj, …)` calls as X has it whatever obj's class is: it
	 * gets a final copy too, as the native class dispatches `m` by the object's class. Library mode: each such method,
	 * which an app may name; otherwise those the program names.
	 */
	nonVirtualEntry(this: Front, m: ts.MethodDeclaration): boolean {
		return this.facts.nonVirtualEntries().has(m);
	},

	/**
	 * Whether a function reads its `arguments`: it then takes the call's arguments as one list, and its parameters read
	 * from it. A method does where any method of its override family does, as an override's native signature is its base's.
	 */
	readsArguments(this: Front, fn: ts.SignatureDeclaration): boolean {
		if (ts.isMethodDeclaration(fn) && !isStatic(fn) && ts.isClassLike(fn.parent) && this.facts.familyReadsArguments(fn)) return true;
		return this.facts.readsOwnArguments(fn);
	},

	/**
	 * Whether a function never reads a parameter: no code of it names the parameter and it does not read `arguments`. Script
	 * never checks a declared type, so such a parameter takes any value: an entry converting what script passes it to the
	 * declared type (a method found by its symbol, an override's bind) gives it its type's empty value unconverted, as
	 * converting could fail, or run a `valueOf`, where script does neither (core's `[backgroundInternalProperty.setNative](value: Color) {}`
	 * is given a Background).
	 */
	unreadParameter(this: Front, fn: ts.FunctionLikeDeclaration, p: ts.ParameterDeclaration): boolean {
		if (!fn.body || !ts.isIdentifier(p.name) || p.dotDotDotToken || frontMethods.readsArguments.call(this, fn)) return false;
		const sym = this.checker.getSymbolAtLocation(p.name);
		if (!sym) return false;
		const reads = (n: ts.Node): boolean => (ts.isIdentifier(n) && n !== p.name && resolveSymbol(n, this.checker) === sym) || !!ts.forEachChild(n, reads);
		return !reads(fn.body) && !fn.parameters.some((q) => q !== p && reads(q));
	},

	/** Whether `cls`'s field or parameter property `name` is written after construction: by a member of `cls`, or by any code. */
	isAssigned(this: Front, cls: ts.ClassDeclaration, name: string): boolean {
		let found = false;
		const isThisName = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword && e.name.text === name;
		const visit = (n: ts.Node): void => {
			if (found) return;
			if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && isThisName(n.left)) found = true;
			else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && isThisName(n.operand)) found = true;
			else ts.forEachChild(n, visit);
		};
		for (const m of cls.members) if (!ts.isPropertyDeclaration(m) || m.initializer) ts.forEachChild(m, visit);
		if (found) return true;
		const written = this.facts.writtenMembers();
		const member = cls.members.find((m) => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name);
		const param = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body)?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
		return (!!member && written.has(member)) || (!!param && written.has(param));
	},

	/**
	 * `Array.prototype.<name>.call(o, …)` or `.apply(o, …)`: Array.prototype's own algorithm over ToObject(o) (ECMA-262
	 * §23.1.3), which reads any array-like by its length and index keys, where the kits implement the method; any other
	 * name is o's own method of the name.
	 */
	arrayPrototypeGeneric(this: Front, name: string): boolean {
		return GENERIC_ARRAY_METHODS.has(name);
	},

	/**
	 * Whether a module variable's or static field's initializer may run where the platform initializes it (when first read,
	 * or as its file or class loads) instead of where JavaScript evaluates it: it gives the same value whenever it runs.
	 */
	constantInit(this: Front & ConstantHost, e: ts.Expression): boolean {
		return constantInitializer(this, e);
	},

	/**
	 * A static field's initializer runs with the module's statements, where JavaScript defines its class, not where the
	 * platform initializes the static: it reads state that may change (`constantInit`), or it may throw
	 * (`throwingStaticsInOrder`).
	 */
	staticInModuleOrder(this: Front & ConstantHost & { initializerThrows?(e: ts.Expression): boolean }, m: ts.PropertyDeclaration): boolean {
		return !!m.initializer && ((this.ledger.throwingStaticsInOrder && !!this.initializerThrows?.(m.initializer)) || !constantInitializer(this, m.initializer));
	},

	/**
	 * A member named by a symbol (`[Symbol.toPrimitive]`, `[key]` for a `const key = Symbol()`): its native name, and for
	 * a symbol the program makes, the expression of its property key (`either`: a string or a symbol, keyed by whichever
	 * it holds).
	 */
	symbolMemberOf(this: Front & Pick<TypeReader, 'nativeOf'> & Pick<StateBackend, 'resolve'> & { readonly generatedKit?: boolean }, name: ts.PropertyName): SymbolMember | null {
		if (!ts.isComputedPropertyName(name)) return null;
		const e = name.expression;
		if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Symbol' && isLibGlobal(this, e.expression)) {
			const member = WELL_KNOWN_MEMBERS[e.name.text];
			if (!member) throw this.error(name, `a member named Symbol.${e.name.text}`);
			return { member, key: null };
		}
		const symbol = (x: ts.Expression) => sameType(this.nativeOf(x), SYMBOL);
		if (ts.isIdentifier(e) && symbol(e)) return { member: programSymbolKey(name, this.checker)?.member ?? `__symbol_${e.text}`, key: { of: e, either: false, fixed: fixedKey(e, this.checker) } };
		if (!this.ledger.symbolKeyedByValue) return null;
		// `[observable]` for a `const observable: string | symbol`: keyed by whichever it holds.
		const t = ts.isIdentifier(e) ? this.checker.getTypeAtLocation(e) : null;
		if (t?.isUnion() && t.types.every((u) => u.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.ESSymbolLike))) return { member: `__symbol_${(e as ts.Identifier).text}`, key: { of: e, either: true, fixed: false } };
		// `[fooProperty.setNative]`: core's property system finds the method by its symbol (an app's class too, on the generated kit).
		if ((this.library || this.generatedKit) && symbol(e)) return { member: `__symbol_${e.getText().replace(/\W+/g, '_')}`, key: { of: e, either: false, fixed: fixedKey(e, this.checker) } };
		return null;
	},

	/**
	 * How a computed key converts to a property key (ToPropertyKey): `symbol` a symbol's own key; `value` by what it holds
	 * when it runs, a symbol's key or else ToString (a value held untyped, or a symbol that may be missing); `string` ToString.
	 */
	keyConversion(this: Pick<TypeReader, 'nativeOf'>, e: ts.Expression): KeyConversion {
		const t = this.nativeOf(e);
		if (t.kind === 'symbol') return t.optional ? 'value' : 'symbol';
		return isUntyped(t) ? 'value' : 'string';
	},

	/** `{ [Symbol.iterator]() {…} }`, `{ [K]: v }`: the member name of a well-known symbol or of a program's. */
	symbolMemberName(this: Front & Pick<StateBackend, 'resolve'>, name: ts.PropertyName): string | null {
		if (!ts.isComputedPropertyName(name)) return null;
		const e = name.expression;
		if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Symbol' && isLibGlobal(this, e.expression)) return WELL_KNOWN_MEMBERS[e.name.text] ?? null;
		return programSymbolKey(name, this.checker)?.member ?? null;
	},

	/** A class's layout (semantics/class-plan.ts): its base, constructor, parameter properties, super call, accessors and own conversions. */
	classPlan(this: Front & { readonly assignFields: boolean; readonly lenient: boolean; symbolMember(name: ts.PropertyName): { member: string } | null }, cls: ts.ClassLikeDeclaration): ClassPlan {
		return classPlanOf(cls, this.checker, (name) => this.symbolMember(name)?.member ?? null, assignsClassFields(this));
	},

	/** A class's accessors paired into properties (`ClassPlan.accessors`); one named by a symbol no native property can be named by is refused. */
	accessorPairs(this: Front & { classPlan(cls: ts.ClassLikeDeclaration): ClassPlan }, cls: ts.ClassLikeDeclaration): ReadonlyMap<string, AccessorPair> {
		const { accessors, symbolAccessor } = this.classPlan(cls);
		if (symbolAccessor) throw this.error(symbolAccessor, 'an accessor named by this symbol');
		return accessors;
	},

	/**
	 * `new k(…)` of a class held in a variable, parameter or field (`k: typeof Base`): it constructs the class `k` holds
	 * when it runs, which may be a subclass of the one its type names.
	 */
	constructsHeldClass(this: Front, e: ts.NewExpression): boolean {
		const callee = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return false;
		let sym = this.checker.getSymbolAtLocation(ts.isIdentifier(callee) ? callee : callee.name);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
		if (!sym || sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Module | ts.SymbolFlags.Interface)) return false;
		const d = sym.valueDeclaration;
		if (!d || d.getSourceFile().isDeclarationFile || !(ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isBindingElement(d))) return false;
		return this.checker
			.getTypeAtLocation(callee)
			.getConstructSignatures()
			.some((s) => {
				const made = s.getReturnType().getSymbol()?.valueDeclaration;
				return !!made && ts.isClassDeclaration(made) && !made.getSourceFile().isDeclarationFile;
			});
	},

	/** The method of this name a class's program base classes declare. */
	inheritedMethod(this: Front, cls: ts.ClassLikeDeclaration, name: string): ts.MethodDeclaration | undefined {
		return inheritedMethod(cls, name, this.checker);
	},

	/** The field, accessor or parameter property a program base class declares under a field's name, which the field redeclares. */
	redeclaredField(this: Front, m: ts.PropertyDeclaration | ts.ParameterDeclaration): ts.PropertyDeclaration | ts.AccessorDeclaration | ts.ParameterDeclaration | null {
		return redeclaredField(m, this.checker);
	},

	/** The topmost declaration a method overrides in the program's base classes, or the method itself. */
	rootMethod(this: Front, m: ts.MethodDeclaration): ts.MethodDeclaration {
		return rootMethod(m, this.checker);
	},

	/** The methods overriding a root method (`baseMethod`'s), directly or through others. */
	overridesOf(this: Front, root: ts.MethodDeclaration): ts.MethodDeclaration[] {
		return this.facts.overridesOf(root);
	},

	/** A root method (`rootMethod`'s) with every method overriding it, directly or through others. */
	methodFamily(this: Front, root: ts.MethodDeclaration): ts.MethodDeclaration[] {
		return this.facts.methodFamily(root);
	},

	/**
	 * A method parameter whose default some other method of its override family does not share: the native call picks a
	 * default argument by the static type, where JavaScript applies the default of the method that runs, so each body
	 * applies its own.
	 */
	familyDefaultsDiffer(this: Front, p: ts.ParameterDeclaration): boolean {
		const m = p.parent;
		if (!ts.isMethodDeclaration(m) || isStatic(m) || !ts.isClassLike(m.parent)) return false;
		const k = m.parameters.indexOf(p);
		const text = (x: ts.MethodDeclaration) => x.parameters[k]?.initializer?.getText();
		return frontMethods.methodFamily.call(this, rootMethod(m, this.checker)).some((x) => x.parameters.length > k && text(x) !== text(m));
	},

	/**
	 * `X.prototype` of `Object` or of a class: an untyped object. In app code a class only declarations declare (the
	 * kit's) is left out: its prototype's members are the kit's, which its own calls reach.
	 */
	isPrototypeRef(this: Front & Pick<StateBackend, 'resolve'>, e: ts.Node): boolean {
		if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'prototype') return false;
		const target = e.expression;
		if (ts.isIdentifier(target) && target.text === 'Object' && isLibGlobal(this, target)) return true;
		const sym = this.resolve(target);
		return !!(sym && sym.flags & ts.SymbolFlags.Class) && (!!this.library || !sym.declarations?.every((d) => d.getSourceFile().isDeclarationFile));
	},

	/** A read of a member only an augmentation declares, or one the kit adds to core's class: missing until set. */
	augmentedMember(this: Front & { readonly core: { augmentedRead(e: ts.PropertyAccessExpression): string | null } | null }, e: ts.PropertyAccessExpression): boolean {
		return augmentedPropertyRead(e, this.checker) || (!isWriteTarget(e) && (this.core?.augmentedRead(e) ?? null) !== null);
	},

	/**
	 * A shape only a library or a plugin declares (an options interface, a class its `.d.ts` describes): an untyped
	 * JavaScript object, as the code that declared it treats it. The app's own interfaces keep their classes, and so do
	 * the core types the kit models.
	 */
	isDynamicShape(this: Front & { readonly core: { has(name: string): boolean } | null; readonly library: { resultShapes?: ReadonlyMap<ts.Symbol, ReadonlySet<string>> } | null; nativeDeclared(d: ts.Declaration): boolean }, sym: ts.Symbol): boolean {
		const decls = sym.declarations ?? [];
		if (!decls.length || this.library?.resultShapes?.has(sym)) return false;
		const sf = decls[0].getSourceFile();
		const shape = decls.every((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isTypeLiteralNode(d) || (ts.isClassDeclaration(d) && d.getSourceFile().isDeclarationFile));
		if (!shape || sf.fileName.startsWith('/__shims__/') || this.nativeDeclared(decls[0]) || /[\\/]typescript[\\/]lib[\\/]/.test(sf.fileName)) return false;
		if (isCoreDeclaration(decls[0])) return decls.every((d) => !ts.isClassDeclaration(d)) && !this.core?.has(sym.name) && !isEventDataSymbol(sym, this.checker);
		return this.pluginFiles.has(sf.fileName) || sf.isDeclarationFile;
	},

	/** A function expression using `this` where its contextual signature, a function type's or a method's, gives it one (`this: T`). */
	givenThis(this: Front, fn: ts.FunctionExpression): boolean {
		if (!thisNodes(fn).length) return false;
		const decl = this.checker.getContextualType(fn)?.getCallSignatures()[0]?.getDeclaration();
		return !!decl && !ts.isJSDocSignature(decl) && declaresThis(decl);
	},

	/**
	 * How a built-in's call taking a callback and a thisArg is made (`ThisArgUse`). The thisArg is evaluated before the
	 * call's receiver, so a receiver with effects beside a thisArg with effects is refused, and so is a callback that may
	 * read the thisArg as `this` where its function is not known.
	 */
	thisArgUse(this: Front & { pure(e: ts.Expression): boolean }, e: ts.CallExpression, target: ts.Expression | undefined): ThisArgUse {
		const call = thisArgCall(e, this.checker);
		const [callback, thisArg] = call ? [call.callback, call.thisArg] : e.arguments;
		const bound = call?.bound;
		if (!thisArg) return bound ? { kind: 'unbound', bound } : { kind: 'plain' };
		const quiet = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || this.pure(x) || (ts.isPropertyAccessExpression(x) && quiet(x.expression));
		if (!quiet(thisArg) && target && !quiet(target)) throw this.error(thisArg, 'a thisArg beside a receiver with effects');
		if (bound) return { kind: 'held', bound, thisArg, self: declaresThis(bound) ? bound.parameters[0] : undefined };
		if (!ignoresThisArg(callback, thisArg, this.checker)) throw this.error(e, 'a thisArg its callback reads');
		return quiet(thisArg) ? { kind: 'plain' } : { kind: 'evaluated', thisArg };
	},

	/**
	 * A typed array's call the generic call path cannot make: one with a thisArg, or whose callback reads a `this` the
	 * call gives (`thisArgCall`) and not yet substituted; the call without its thisArg, to make inside `ignoringThisArg`.
	 */
	typedArrayThisArgCall(this: Front & { readonly subst: Map<ts.Node, string> }, e: ts.CallExpression): ts.CallExpression | null {
		const call = thisArgCall(e, this.checker);
		if (!call || !(call.thisArg || (call.bound && !thisNodes(call.bound).every((n) => this.subst.has(n))))) return null;
		return withoutThisArg(e, call.thisArg);
	},

	/** A `string[]` a regexp group that took no part may have put undefined in (`unsetGroupTyping`). */
	unsetGroups(this: Front & { readonly unset: UnsetGroupTyping }, n: ts.Node): boolean {
		return this.unset.groups(n);
	},

	/** Refuses a function value (no literal) given to visit unset-group strings whose element parameter is declared to hold no undefined. */
	refuseTypedUnsetCallback(this: Front & { readonly unset: UnsetGroupTyping }, call: ts.CallExpression): void {
		const typedCallback = this.unset.typedCallback(call);
		if (typedCallback) throw this.error(typedCallback, "a function whose element parameter is declared to hold no undefined, given strings a pattern's unset group may leave undefined (declare the parameter `string | undefined`)");
	},

	/** A match whose groups may include one that took no part. */
	unsetMatch(this: Front & { readonly unset: UnsetGroupTyping }, e: ts.Expression): boolean {
		return this.unset.match(e);
	},

	/** Library mode: the program's classes object literals are made instances of (`literalClassOf`). */
	literalClasses(this: Front): Set<ts.ClassDeclaration> {
		return this.facts.literalClasses();
	},

	/**
	 * A `literalClasses` class extending none: its literals' objects are made without its constructor, so they run none
	 * of its field initializers, as a literal has none. An initializer with effects runs in the constructor alone.
	 */
	literalMade(this: Front, cls: ts.ClassDeclaration): boolean {
		return !!this.library && !cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) && this.facts.literalClasses().has(cls);
	},

	/**
	 * A function declaration reading a `this` it does not declare (`function get() { return this[key]; }` stored as an
	 * accessor): JavaScript gives it the receiver it is called on, so it takes `this` as its first parameter.
	 */
	implicitThis(this: Front, fn: ts.Node): boolean {
		if (!this.ledger.implicitThisUnconstructed) return ts.isFunctionDeclaration(fn) && !!fn.body && !fn.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === 'this') && thisNodes(fn).length > 0 && !frontMethods.readsArguments.call(this, fn);
		if (!ts.isFunctionDeclaration(fn) || !fn.body || !fn.name || declaresThis(fn) || fn.parameters[0]?.name.getText() === 'this' || !thisNodes(fn).length) return false;
		const name = fn.name.text;
		let constructed = false;
		const visit = (n: ts.Node) => {
			if (constructed) return;
			if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) constructed = true;
			else ts.forEachChild(n, visit);
		};
		visit(fn.getSourceFile());
		return !constructed;
	},

	/** A function declaration that takes `this` as its first parameter, declared or read (`implicitThis`). */
	takesThis(this: Front, fn: ts.SignatureDeclaration): boolean {
		return ts.isFunctionDeclaration(fn) && (declaresThis(fn) || frontMethods.implicitThis.call(this, fn));
	},

	/**
	 * Whether `for…of` steps through the value's iterator, one `next()` a pass as the body runs, rather than iterating it
	 * natively. An untyped value is stepped so: an array it holds is read up to its live length, a generator's effects
	 * interleave with the body. IteratorClose of a stepped loop: a throw leaving it calls `return()` dropping what that
	 * throws; any other exit (`break`, a jump to an outer label, `return`) calls it once the body's finally blocks have run,
	 * outside the body's catch blocks, and what it throws, or a result that is no object (TypeError), replaces the exit.
	 * An iterator that is done, or whose `next()` threw, is not closed.
	 */
	forOfSteps(this: Front & { isAny(n: ts.Node): boolean }, e: ts.Expression): boolean {
		return iterationThrows(this.checker.getTypeAtLocation(e), this.checker) || this.isAny(e);
	},

	/** A script iterator `for…of`, spread and destructuring step through `next()`; null when the value iterates natively. */
	jsIteration(this: Front & { iteratorCode(e: ts.Expression): string }, e: ts.Expression): string | null {
		if (!iterationThrows(this.checker.getTypeAtLocation(e), this.checker)) return null;
		return this.iteratorCode(e);
	},

	/**
	 * The iterator an array pattern steps (`const [a, b] = x`): a script iterator's, or GetIterator of a value held
	 * untyped, whatever it holds; null where the pattern reads the value's elements in place.
	 */
	patternIteration(this: Front & { iteratorCode(e: ts.Expression, called?: boolean, message?: string): string; isAny(n: ts.Node): boolean; jsIteration(e: ts.Expression): string | null }, e: ts.Expression): string | null {
		return this.jsIteration(e) ?? (this.isAny(e) ? this.iteratorCode(e, false, notIterable(e)) : null);
	},

	/**
	 * A member a program's `declare global` adds to a built-in (`interface SymbolConstructor { readonly observable: symbol }`)
	 * that the runtime doesn't have: undefined, as in an engine without a polyfill.
	 */
	isAugmentedLibMember(this: Front & Pick<StateBackend, 'resolve'>, e: ts.Node): boolean {
		if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression) || isWriteTarget(e) || !isLibGlobal(this, e.expression)) return false;
		const decls = this.checker.getSymbolAtLocation(e.name)?.declarations ?? [];
		return decls.length > 0 && decls.every((d) => !isLibDeclaration(d) && ts.isInterfaceDeclaration(d.parent));
	},

	/** An app class's plan, keyed or not: its fields' null states. */
	shapePlan(this: { readonly states: ValueStates; shapeFacts(): ShapeFacts }, cls: ts.ClassLikeDeclaration): ShapePlan | null {
		return shapePlanOfClass(cls, this.states, this.shapeFacts());
	},

	/** An app class's key plan, or null where its keys are its declared fields. */
	keyPlan(this: { readonly states: ValueStates; shapeFacts(): ShapeFacts }, cls: ts.ClassLikeDeclaration): ShapePlan | null {
		const plan = frontMethods.shapePlan.call(this, cls);
		return plan?.keyed ? plan : null;
	},

	/**
	 * The test a keyed class's key is present by (null: always): its level reached, unless written, and its own flag.
	 * Both kits name the level `jsLevel` and the flag `__has_<key>`.
	 */
	keyPresent(p: ShapePlan, n: string): string | null {
		const gate = p.gated && p.depth > 0 ? `jsLevel >= ${p.depth}` : '';
		const written = keyOf(p, n)?.presence === 'written';
		return [written ? '' : gate, p.flagged.has(n) ? `__has_${n}` : ''].filter(Boolean).join(' && ') || null;
	},

	/** A library class's field whose first write makes its key (`MadeKeys`): each write notes it in the object's record. */
	madeField(this: { readonly library: unknown; readonly states: ValueStates; shapeFacts(): ShapeFacts }, cls: ts.ClassLikeDeclaration, n: string): boolean {
		return frontMethods.madeBitOf.call(this, cls, n) !== null;
	},

	/** A library class's record of keys made (`MadeKeys`), where its hierarchy has one. */
	madeKeys(this: { readonly library: unknown; readonly states: ValueStates; shapeFacts(): ShapeFacts }, cls: ts.ClassLikeDeclaration): MadeKeys | undefined {
		return this.library ? memberPlanOf(cls, this.states, this.shapeFacts()).made : undefined;
	},

	/** A made field's bit (`MadeKeys`), or null for any other field. */
	madeBitOf(this: { readonly library: unknown; readonly states: ValueStates; shapeFacts(): ShapeFacts }, cls: ts.ClassLikeDeclaration, n: string): { word: number; bit: number } | null {
		const at = frontMethods.madeKeys.call(this, cls)?.fields.get(n);
		return at === undefined ? null : madeBit(at);
	},

	/** A typed read of a keyed class's string, number or boolean field (`keyPlan`) whose key may not be made yet: read by key. */
	absentKeyField(this: Front & TypeReader & KeyHost, e: ts.Expression): e is ts.PropertyAccessExpression {
		if (!ts.isPropertyAccessExpression(e) || e.questionDotToken || e.expression.kind === ts.SyntaxKind.SuperKeyword || !isPrimitive(this.nativeOf(e))) return false;
		const d = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
		if (!d || !ts.isPropertyDeclaration(d) || !ts.isClassLike(d.parent)) return false;
		const plan = frontMethods.keyPlan.call(this, d.parent);
		return !!plan && frontMethods.keyPresent(plan, e.name.text) !== null;
	},

	/** A record's entry (`r[k]`, `r.k` of a record) the backend reads back optional, where the program reads it present. */
	recordEntry(this: Front & TypeReader, target: ts.Expression): ts.ElementAccessExpression | ts.PropertyAccessExpression | null {
		while (ts.isParenthesizedExpression(target)) target = target.expression;
		if (ts.isPropertyAccessExpression(target)) return byKey(this, target) && !this.nativeOf(target).optional ? target : null;
		return ts.isElementAccessExpression(target) && isKit(this.nativeOf(target.expression), 'JSRecord') && !this.nativeOf(target).optional ? target : null;
	},

	/**
	 * An assertion of an untyped value to a present type the backend checks (`x as Foo` of an untyped `x`): its read
	 * converts, checked, and reads as the optional it may be where the program tests it. Not in library mode.
	 */
	assertedUntyped(this: Front & TypeReader & { untypedCastChecks(e: ts.Expression, t: NativeType): boolean }, e: ts.Expression): ts.AsExpression | ts.TypeAssertion | null {
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (!(ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) || isWriteTarget(e)) return null;
		try {
			const t = this.nativeOf(e),
				from = this.nativeOf(e.expression);
			if (isUntyped(t) || t.kind === 'never' || t.kind === 'void' || t.optional || t.implicit || (t.kind === 'function' && t.head === undefined) || this.library) return null;
			// JavaScript's assertion converts nothing: an empty value asserted to an array is still empty where it is read.
			if (isPrimitive(t) || t.kind === 'array') return isUntyped(from) ? e : null;
			return isUntyped(from) && this.untypedCastChecks(e, t) ? e : null;
		} catch (err) {
			rethrowUnlessRefused(err);
			return null;
		}
	},

	/** Methods an instance may hold a value in place of (`instanceKeysOf`). */
	instanceKeys(this: Front): Set<ts.MethodDeclaration> {
		return this.facts.instanceKeys();
	},

	/** Whether a value is held untyped where an operation reads it (a library global's name aside, which is its own value). */
	heldUntyped(this: Front & Pick<StateBackend, 'resolve'> & { isAny(n: ts.Node): boolean }, n: ts.Node): boolean {
		try {
			return !(ts.isIdentifier(n) && isLibGlobal(this, n)) && this.isAny(n);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** Whether an operand converts by what can throw (`conversionThrows`), a typed one as the throws analysis tells. */
	conversionThrows(this: Front & { heldUntyped(n: ts.Node): boolean; readonly throwsInfo: Pick<Throws, 'objectConversionThrows'> }, n: ts.Node): boolean {
		return conversionThrows(
			this.checker,
			n,
			(x) => this.heldUntyped(x),
			(x) => this.throwsInfo.objectConversionThrows(x),
		);
	},

	/** The throwing conversion an operator runs on its operands held untyped (`untypedOperation`), or null. */
	untypedOperation(this: Front & { isString(n: ts.Node): boolean; heldUntyped(n: ts.Node): boolean; conversionThrows(n: ts.Node): boolean }, n: ts.Node): UntypedOperation | null {
		return untypedOperation(n, {
			checker: this.checker,
			untyped: (x) => this.conversionThrows(x),
			held: (x) => this.heldUntyped(x),
			string: (x) => this.isString(x),
			big: (x) => !!(this.checker.getTypeAtLocation(x).flags & ts.TypeFlags.BigIntLike),
		});
	},

	/**
	 * Whether a numeric operator's value is held untyped (`untypedArithmetic`), where TypeScript types it a number; so is
	 * a variable such a value initializes (`arithmeticVariable`).
	 */
	untypedArithmetic(this: Front & { isString(n: ts.Node): boolean; heldUntyped(n: ts.Node): boolean }, n: ts.Node): boolean {
		const types = {
			held: (x: ts.Node) => this.heldUntyped(x),
			string: (x: ts.Node) => this.isString(x),
			big: (x: ts.Node) => !!(this.checker.getTypeAtLocation(x).flags & ts.TypeFlags.BigIntLike),
		};
		return untypedArithmetic(this.checker, n, types) || heldArithmetic(this.checker, n, types);
	},

	/** The classes whose objects script gives members they don't declare (`expandoRootsOf`); none in library mode. */
	givenUndeclared(this: Front): Set<ts.ClassLikeDeclaration> {
		return this.facts.givenUndeclared();
	},
});
export type FrontMethods = typeof frontMethods;
