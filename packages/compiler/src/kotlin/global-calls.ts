// Calls of JavaScript's globals as Kotlin: signals, globalCall, memo, toNumber and navigate.
import ts from 'typescript';
import { ERRORS, isLibGlobal } from '../semantics/globals.ts';
import { functionTypeParts, ident, isFunctionType, isNullable, kotlinString, optionalType, postfixable, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { Store } from '../semantics/placement.ts';
import { accessedDeclaration } from '../semantics/lang.ts';
import { equalOption } from '../semantics/signals.ts';
import { classOverHeldResult, classOverHeldResultMessage, holdsGenericResult } from '../semantics/shapes.ts';
import { hasModifier, isAppDeclarationFile, isLibDeclaration, shadowedByMember, isWriteTarget } from '../semantics/ast.ts';
import { runtimeCall } from '../semantics/apis/api.ts';
import type { SignalEquality } from '../api/adapter-api.ts';
import { isPromiseType } from '../semantics/spelled.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { globalFunction, globalOp } from '../semantics/apis/globals.ts';
import { conversionCallThrowing } from '../semantics/apis/operators.ts';
import { programClassName } from '../semantics/top-names.ts';

export const globalCallsMethods = {
	/** The new value of a signal, stored by `at` (`checks` as `storeSlot` has it). */
	signalWrite(this: Translator, target: ts.Expression, value: ts.Expression, t: string, checks: boolean, at: Store = target): string {
		let code = this.stored(value, at, t, checks);
		// A non-strict app's signal of an object takes undefined (`items.find(…)`) as it holds its initial null: unchecked.
		if (this.lenientApp && !this.library && this.isAsserted(code) && this.isObjectType(t) && !isNullable(t)) code = `(${this.unasserted(code)} ?: ${RT.jsUncheckedNull}<${t}>())`;
		return this.framework.signalKind(this.symbolName(target)) === 'ref' && this.isObjectRef(value) ? `${RT.jsReactive}(${code})` : code;
	},

	/** `Signal(x)`: a write of an equal value is no change, as `equality` says. */
	newSignal(this: Translator, t: string, value: string, equality: SignalEquality): string {
		if (isKit(spelledType(t), 'JSNullish') && equality === 'identity') return `Signal<${t}>(${value}) { a, b -> ${RT.jsSame}(a.jsAny, b.jsAny) }`;
		const reference = !['Double', 'String', 'Boolean'].includes(t.replace(/\?$/, '')) && !isFunctionType(t);
		if (equality === 'deep') return `Signal<${t}>(${reference ? `${RT.jsReactive}(${value})` : value}${reference ? `, ::${RT.jsSame}` : ''})`;
		if (equality === 'always-changed' && reference) return `Signal<${t}>(${value}) { _, _ -> false }`;
		if (!reference) return `Signal<${t}>(${value})`;
		return `Signal<${t}>(${value}, ::${RT.jsSame})`;
	},

	globalCall(this: Translator, callee: ts.Identifier, e: ts.CallExpression): string {
		const mixed = this.patterns.isMixinCall(e);
		if (mixed) return mixed.map((c) => `__install_${c.name!.text}()`).join('; ');
		const declFile = this.resolve(callee)?.declarations?.[0]?.getSourceFile().fileName ?? '';
		// Library mode: a function returning its last argument (`zonedCallback(fn)`).
		if (this.library?.identities.has(callee.text) && e.arguments.length && (this.resolve(callee)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile)) return this.restArgument(e, e.arguments[e.arguments.length - 1], this.typeOf(e));
		// NativeScript's `gc()`: the JVM's collector.
		if (callee.text === 'gc' && !e.arguments.length && (this.resolve(callee)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile) && !!declFile) return 'java.lang.System.gc()';
		// NativeScript's `float(n)`, `long(n)`: a number the native call converts to its parameter's Java type.
		if (['float', 'long', 'short', 'byte', 'double'].includes(callee.text) && (this.resolve(callee)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile) && !!declFile && e.arguments.length === 1) return this.toNumber(e.arguments[0]);
		// Library mode: a global function only core's declarations describe (`gc()`, `__startCPUProfiler()`): the runtime's, found on the global object.
		// App mode: a function the program only declares (`declare function __startCPUProfiler(name)`, which the runtime may provide): the global object's.
		const appDeclared = !this.library ? this.resolve(callee)?.declarations?.[0] : undefined;
		if (appDeclared && ts.isFunctionDeclaration(appDeclared) && !appDeclared.body && hasModifier(appDeclared, ts.SyntaxKind.DeclareKeyword) && (!appDeclared.getSourceFile().isDeclarationFile || isAppDeclarationFile(appDeclared))) {
			const code = `${RT.jsCall}(${RT.jsGetIfPresent}(jsGlobalThis, ${kotlinString(callee.text)})${this.untypedArgs(e)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
		}
		const globals = this.library ? (this.resolve(callee)?.declarations ?? []) : [];
		if (globals.length && globals.every((d) => d.getSourceFile().isDeclarationFile && !isLibDeclaration(d) && (ts.isFunctionDeclaration(d) || ts.isVariableDeclaration(d)) && (!ts.isExternalModule(d.getSourceFile()) || !!ts.findAncestor(d, (a) => ts.isModuleDeclaration(a) && a.name.getText() === 'global')))) {
			const code = `${RT.jsCall}(${RT.jsGetIfPresent}(jsGlobalThis, ${kotlinString(callee.text)})${this.untypedArgs(e)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
		}
		const native = this.native?.call(e);
		if (native) return native;
		const arg = (k: number) => e.arguments[k];
		const decl = this.resolve(callee)?.declarations?.[0];
		// Core's timers imported from their module under another name (`setTimeout as __timer_setTimeout`): the runtime's.
		const timer = decl && /[\\/]timer[\\/]index(\.d)?(\.android)?\.ts$/.test(decl.getSourceFile().fileName) ? this.resolve(callee)!.name : undefined;
		const name = timer && ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].includes(timer) ? timer : callee.text;
		const lib = !decl || decl.getSourceFile().isDeclarationFile;
		const hooked = this.framework.hooks.globalCall?.(this, name, e, decl, lib);
		if (hooked !== undefined) return hooked;
		const made = this.framework.signalConstructor(name);
		if (made && !made.linked && (!made.typed || this.typeOf(e).startsWith('Signal<')) && lib) {
			const t = this.typeOf(e).replace(/^Signal<(.*)>$/, '$1');
			const value = arg(0) ? this.restArgument(e, arg(0), t) : 'null';
			const equals = made.options !== undefined ? this.equalsArg(arg(made.options), t) : undefined;
			return equals ? `Signal<${t}>(${value}${equals})` : this.newSignal(t, value, made.equality);
		}
		if (name === '$state' && lib) return `${RT.stateSignal}(${this.expr(arg(0))})`;
		if (name === '$navigateTo' && lib) return this.navigate(e, (arg(0) as ts.Identifier).text, arg(1));
		if (name === '$showModal' && lib) return this.showModal(e);
		if (name === '$closeModal' && lib) return `Modal.close(${arg(0) ? this.restArgument(e, arg(0), 'Any?') : ''})`;
		if (lib) {
			const fn = globalFunction(name);
			const op = fn?.op;
			switch (op) {
				case 'String':
					return arg(0) ? (conversionCallThrowing(this, e) ?? this.str(arg(0))) : '""';
				case 'Number':
					return arg(0) ? (conversionCallThrowing(this, e) ?? this.toNumber(arg(0))) : '0.0';
				case 'Boolean':
					return arg(0) ? this.cond(arg(0)) : 'false';
				case 'parseInt':
					return `${RT.jsParseInt}(${this.str(arg(0))}${arg(1) ? `, ${this.toNumber(arg(1))}` : ''})`;
				case 'isNaN':
					return this.nanTest(arg(0));
				case 'isFinite':
					return `${RT.jsIsFinite}(${this.toNumber(arg(0))})`;
				case 'setTimeout':
				case 'setInterval': {
					const timer = RT[globalOp(op)];
					const ms = arg(1) ? this.toNumber(arg(1)) : '0.0';
					// The arguments after the delay are the callback's.
					const params = e.arguments.length > 2 ? functionTypeParts(this.typeOf(arg(0)).replace(/^\((.*)\)\?$/, '$1'))?.params : undefined;
					if (params) {
						const given = e.arguments.slice(2, 2 + params.length).map((x, k) => `val __x${k} = ${this.coerce(x, params[k])}; `);
						return `run { val __f = ${this.fn(arg(0))}; ${given.join('')}${timer}({ __f(${params.map((_, k) => (k < given.length ? `__x${k}` : 'null')).join(', ')}); Unit }, ${ms}) }`;
					}
					return `${timer}(${this.callback(arg(0))}, ${ms})`;
				}
				case 'clearTimeout':
				case 'clearInterval':
					return `${RT[globalOp(op)]}(${arg(0) ? this.restArgument(e, arg(0), 'Double?') : 'null'})`;
				case 'Symbol':
					return `${RT.jsSymbol}(${arg(0) ? this.str(arg(0)) : 'null'})`;
				case 'BigInt':
					return `JSBigInt.convert(${this.restArgument(e, arg(0), 'Any?')})`;
			}
			if (fn?.args) return runtimeCall(this, fn, e);
			// `Error('x')` constructs as `new Error('x')` does; so does `Array(n)`.
			if (ERRORS[name]) return this.errorValue(name, e.arguments);
			if (name === 'Array' && isLibGlobal(this, callee as ts.Identifier)) return this.arrayConstruct(e, this.typeOf(e), e.arguments);
			// `RegExp(re)` without flags is `re` itself; otherwise it constructs as `new RegExp` does.
			if (name === 'RegExp' && decl && isLibDeclaration(decl)) return e.arguments.length === 1 && this.isRegExp(e.arguments[0]) ? this.expr(e.arguments[0]) : this.regExpConstruct(e.arguments, true);
			if (decl && /[\\/]lib\.[\w.]*\.d\.ts$/.test(decl.getSourceFile().fileName)) throw this.error(e, `${name}()`, name === 'Object' ? 'object-call' : 'library-member');
		}
		const resolvers = this.resolvers.get(this.resolve(callee)!);
		if (resolvers) {
			if (!arg(0)) return `${resolvers.name}.resolve(${resolvers.type === 'Unit' ? 'Unit' : 'null'})`;
			if (isPromiseType(this.nativeOf(arg(0)))) return `${resolvers.name}.resolvePromise(${this.restArgument(e, arg(0), `JSPromise<${resolvers.type}>`)})`;
			return `${resolvers.name}.resolve(${this.restArgument(e, arg(0), resolvers.type)})`;
		}
		const declared = this.checker.getResolvedSignature(e)?.getDeclaration();
		const isFunctionValue = !declared || ts.isJSDocSignature(declared) || !('body' in declared && declared.body) || ts.isArrowFunction(declared) || ts.isFunctionExpression(declared);
		const fnType = this.declaredTypeOf(callee) ?? this.typeOf(callee);
		// A function held untyped (one of several function types): called as script calls it.
		if (isUntyped(spelledType(fnType)) || this.isAny(callee)) {
			const code = `${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
		}
		const own = `${this.refName(callee)}${this.states.nullishRead(callee) ? '.optional' : ''}`;
		const qualified = this.appModule && shadowedByMember(e, this.resolve(callee)?.declarations?.[0], own, ident) ? `${this.appModule}.${own}` : own;
		const fn = this.narrowed(callee, qualified);
		const nullable = /^\(.*\)\?$/.test(fnType) && isFunctionType(fnType.slice(1, -2));
		// A function value of a rest parameter (`(...args) => void`, Kotlin's of one list): the arguments packed.
		const parts = functionTypeParts(fnType.replace(/^\((.*)\)\?$/, '$1'));
		const restValue = !this.library && isFunctionValue && !!declared && !ts.isJSDocSignature(declared) && declared.parameters.length === 1 && !!declared.parameters[0].dotDotDotToken && parts?.params.length === 1 && /^JSArray</.test(parts.params[0]);
		const args = restValue ? [this.packed(e.arguments, parts!.params[0])] : this.args(e, isFunctionValue ? undefined : this.arity(e));
		// A package's function value whose parameter TypeScript resolves untyped (ngrx's `unknown extends S ? any : S`) while its
		// Kotlin type declares it: the argument is placed as Kotlin declares it.
		const held = this.resolve(callee)?.valueDeclaration;
		if (!restValue && parts && held && (ts.isVariableDeclaration(held) || ts.isParameter(held)) && !this.library && this.pluginFiles.has(e.getSourceFile().fileName) && !e.arguments.some(ts.isSpreadElement)) {
			const restAt = !!declared && !ts.isJSDocSignature(declared) ? declared.parameters.findIndex((q) => q.dotDotDotToken) : -1;
			e.arguments.forEach((a, k) => {
				const want = parts.params[k];
				if (!want || isUntyped(spelledType(want)) || (restAt >= 0 && k >= restAt)) return;
				if (this.typeOf(a) !== want) args[k] = this.coerce(a, want);
				else if (!isNullable(want) && this.declaredTypeOf(a) === optionalType(want)) args[k] = this.asserted(args[k]);
			});
		}
		const call = `${nullable || this.isAsserted(fn) ? `(${this.unasserted(fn)} ?: ${RT.jsNotAFunction}(${kotlinString(callee.getText().replace(/\s+/g, ''))}))` : fn}(${args.join(', ')})`;
		return this.library ? this.fromPluginCall(e, call) : this.lenientResult(e, call);
	},

	/** A memo of `fn` (`computed(fn)`) as a `Memo<rt>`: a recomputed result Object.is the kept one keeps it. */
	memo(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression, rt: string, base: string): string {
		const saved = this.indent;
		this.indent = base;
		const equals = ts.isCallExpression(fn.parent) && fn.parent.arguments[0] === fn ? this.equalsArg(fn.parent.arguments[1], rt) : undefined;
		try {
			return `Memo<${rt}>(fun(): ${rt} ${this.functionBody(fn, rt, base)}${equals ?? ''})`;
		} finally {
			this.indent = saved;
		}
	},

	/** `, equals` for the `equal` a signal's options give (read from them by name when they are not a literal), or undefined when a literal gives none. */
	equalsArg(this: Translator, options: ts.Expression | undefined, t: string): string | undefined {
		const { equal, opaque } = equalOption(options);
		const reference = !['Double', 'String', 'Boolean'].includes(t.replace(/\?$/, '')) && !isFunctionType(t);
		if (opaque) return `, ${RT.jsEqualOption}<${t}>(${this.coerce(opaque, 'Any?')}, ${reference ? `::${RT.jsSame}` : `{ a: ${t}, b: ${t} -> a == b }`})`;
		if (!equal) return undefined;
		// A function declaration is a Kotlin `fun`, called by name (`(f)(a, b)` is not a call of it).
		const named = ts.isIdentifier(equal) && !!this.resolve(equal)?.declarations?.some(ts.isFunctionDeclaration);
		return `, { a: ${t}, b: ${t} -> ${named ? this.expr(equal) : `(${this.expr(equal)})`}(a, b) }`;
	},

	/** A class's memo field (`computed(fn)`): the instance's memo, and the field reading its value. */
	memoField(this: Translator, m: ts.PropertyDeclaration, name: string): string[] {
		const fn = this.framework.memoized(m, this.checker)!;
		const t = this.computedType(m.initializer as ts.CallExpression);
		const memo = ident(`${name}__memo`);
		return [`    private val ${memo}: Memo<${t}> = ${this.memo(fn, t, '    ')}`, `    val ${ident(name)}: ${t}`, `        get() = ${memo}.value`];
	},

	/** A generic function compiled with its type parameters erased (`loadCache<T>`): its result as this call instantiates it. */
	erasedResult(this: Translator, e: ts.CallExpression, code: string): string {
		if (this.library) return code;
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		// `deref()` or `get()` of an erased generic class's weak reference (`JSWeakRef<Any>` for `WeakRef<T>`): the held element, as this call types it.
		const callee = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		const receiver = ts.isPropertyAccessExpression(callee) && ['deref', 'get'].includes(callee.name.text) ? ts.skipOuterExpressions(callee.expression, ts.OuterExpressionKinds.Parentheses) : null;
		const held = receiver && ts.isPropertyAccessExpression(receiver) && !isWriteTarget(receiver) ? this.erasedMemberType(accessedDeclaration(this.checker.getSymbolAtLocation(receiver.name), false)) : null;
		if (held && /^JSWeakRef<.+>\??$/.test(held) && held.replace(/\?$/, '') !== this.typeOf(receiver!).replace(/\?$/, '')) {
			const actual = this.typeOf(e);
			return actual === 'Unit' || isUntyped(spelledType(actual)) ? code : isNullable(actual) ? this.fromAny(code, actual) : this.fromAnyCode(code, actual, true);
		}
		const packageGeneric = !!decl && this.pluginFiles.has(decl.getSourceFile().fileName) && !!decl.typeParameters?.length;
		if (!decl || ts.isJSDocSignature(decl) || decl.getSourceFile().isDeclarationFile || !(decl.typeParameters?.some((tp) => this.erasesTypeParameter(tp)) || packageGeneric || holdsGenericResult(decl, this.checker))) return code;
		const cls = classOverHeldResult(e, this.checker);
		if (cls) throw this.error(e, classOverHeldResultMessage(cls));
		const declared = this.returnTypeOf(decl as ts.SignatureDeclaration),
			actual = this.typeOf(e);
		if (declared === actual || actual === 'Unit' || isUntyped(spelledType(actual))) return code;
		return isNullable(actual) ? this.fromAny(code, actual) : this.fromAnyCode(code, actual, true);
	},

	/** Whether a node is a plugin's code, a component of its included (a node the translation made has no source file: not one). */
	inPluginFile(this: Translator, n: ts.Node): boolean {
		let at: ts.Node | undefined = n;
		while (at && !ts.isSourceFile(at)) at = at.parent;
		return !!at && (this.pluginFiles.has((at as ts.SourceFile).fileName) || this.pluginRoots.some((r) => (at as ts.SourceFile).fileName.startsWith(r)));
	},

	/** A call of a function the program's declarations give (a framework's), not one of its own. */
	isLibCall(this: Translator, e: ts.CallExpression): boolean {
		const decl = this.resolve(e.expression)?.declarations?.[0];
		return !decl || decl.getSourceFile().isDeclarationFile;
	},

	symbolName(this: Translator, e: ts.Expression): string {
		const t = this.checker.getTypeAtLocation(e);
		return (t.aliasSymbol ?? t.getSymbol())?.getName() ?? '';
	},

	/** A navigation (`$navigateTo(Page, { props })`) to a component, with the props its options give. */
	navigate(this: Translator, e: ts.CallExpression, component: string, options: ts.Expression | undefined): string {
		const info = this.components.get(component);
		if (!info) throw this.error(e, `navigation to ${component}: not a component`);
		const given = new Map<string, string>();
		if (options && ts.isObjectLiteralExpression(options)) {
			const props = options.properties.find((p) => p.name && (p.name as ts.Identifier).text === 'props');
			if (props && ts.isPropertyAssignment(props) && ts.isObjectLiteralExpression(props.initializer)) {
				for (const p of props.initializer.properties) {
					if (ts.isShorthandPropertyAssignment(p)) given.set(p.name.text, this.shorthandValue(p.name));
					else if (ts.isPropertyAssignment(p)) given.set((p.name as ts.Identifier).text, this.expr(p.initializer));
				}
			}
		}
		const args = info.props.map((p) => `${ident(p)} = ${given.get(p) ?? 'null'}`).join(', ');
		return `${RT.kitNavigate} { ${programClassName(this, component)}(${args}).${info.members.render}() }`;
	},

	nanTest(this: Translator, e: ts.Expression): string {
		const n = this.toNumber(e);
		return `${postfixable(n) ? n : `(${n})`}.isNaN()`;
	},

	toNumber(this: Translator, e: ts.Expression): string {
		const t = this.typeOf(e);
		if (t === 'JSBigInt') return `${this.expr(e)}.toDouble()`;
		// `a?.length` is undefined, NaN as a number, where `a` is (the type says number where null checks are off).
		if (t === 'Double' && e.flags & ts.NodeFlags.OptionalChain && (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e))) return this.undefinedAs(this.expr(e), 'Double');
		if (t === 'Double') {
			const code = this.expr(e);
			return !this.library && this.heldOptionalNumber(e) && this.marks.markOf(code)?.op !== 'undefinedAs' ? this.undefinedAs(code, 'Double') : code;
		}
		if (t === 'JSDate') {
			// A date Kotlin holds nullable (`(x: Date, y: Date) => x <= y` given undefined): NaN, as JavaScript converts undefined.
			const code = this.expr(e);
			return this.isAsserted(code) ? `(${this.unasserted(code)}?.valueOf() ?: Double.NaN)` : `${code}.valueOf()`;
		}
		if (t === 'String') return `${RT.jsNumberFromString}(${this.expr(e)})`;
		if (t === 'Boolean') return `(if (${this.expr(e)}) 1.0 else 0.0)`;
		const native = this.native?.toNumber(e, t);
		if (native) return native;
		const maybe = this.maybeUndefined(e);
		if (maybe) return `${RT.jsToNumber}(${maybe})`;
		return `${RT.jsToNumber}(${this.expr(e)})`;
	},
};
