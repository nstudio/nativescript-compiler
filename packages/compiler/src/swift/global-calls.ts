// Calls of JavaScript's globals as Swift: signals, globalCall, toNumber and navigate.
import ts from 'typescript';
import { ERRORS } from '../semantics/globals.ts';
import { functionParts, ident, isFunctionType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { Store } from '../semantics/placement.ts';
import { hasModifier, isAppDeclarationFile, isLibDeclaration, shadowedByMember } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { runtimeCall } from '../semantics/apis/api.ts';
import type { SignalEquality } from '../api/adapter-api.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { globalFunction, globalOp } from '../semantics/apis/globals.ts';
import { conversionCallThrowing } from '../semantics/apis/operators.ts';
import { programClassName } from '../semantics/top-names.ts';

export const globalCallsMethods = {
	/** The new value of a signal, stored by `at` (`checks` as `storeSlot` has it): a ref's is deeply reactive. */
	signalWrite(this: Translator, target: ts.Expression, value: ts.Expression, t: string, checks: boolean, at: Store = target): string {
		const code = this.stored(value, at, t, checks);
		return this.framework.signalKind(this.symbolName(target)) === 'ref' && this.isObjectRef(value) ? `${RT.jsReactive}(${code})` : code;
	},

	/** `Signal(x)`: a write of an equal value is no change, as `equality` says. */
	newSignal(this: Translator, t: string, value: string, equality: SignalEquality): string {
		if (isKit(spelledType(t), 'JSNullish') && equality === 'identity') return `Signal<${t}>(${value}, equals: { ${RT.jsSame}($0.jsAny, $1.jsAny) })`;
		const reference = !['Double', 'String', 'Bool'].includes(t.replace(/\?$/, '')) && !isFunctionType(t);
		if (equality === 'deep') return `Signal<${t}>(${reference ? `${RT.jsReactive}(${value})` : value}${reference ? `, equals: { ${RT.jsSame}($0, $1) }` : ''})`;
		if (equality === 'always-changed' || !reference) return `Signal<${t}>(${value})`;
		return `Signal<${t}>(${value}, equals: { ${RT.jsSame}($0, $1) })`;
	},

	globalCall(this: Translator, callee: ts.Identifier, e: ts.CallExpression): string {
		// `profile('name', fn)` and the like (library mode): the function itself.
		if (this.library?.identities?.has(callee.text) && e.arguments.length) return this.restArgument(e, e.arguments[e.arguments.length - 1], this.typeOf(e));
		const mixed = this.patterns.isMixinCall(e);
		if (mixed) return mixed.map((c) => `__install_${c.name!.text}()`).join('; ');
		const decl = this.resolve(callee)?.declarations?.[0];
		// Worker globals (`postMessage`, `close`): checked before `native.call` so Darwin's C `close(_:)` does not shadow `close()`.
		if ((callee.text === 'postMessage' || callee.text === 'close') && decl && (decl.getSourceFile().fileName === '/__shims__/globals.d.ts' || isLibDeclaration(decl))) {
			if (callee.text === 'close') return `${RT.jsClose}()`;
			const args = e.arguments;
			return `${RT.jsPostMessage}(${args[0] ? this.coerce(args[0], 'Any?') : 'nil'}${args[1] ? `, ${this.coerce(args[1], 'Any?')}` : ''})`;
		}
		const native = this.native.call(e);
		if (native) return native;
		// A core function imported under another name (`timer.setTimeout`, read as `__timer_setTimeout`): by its own.
		const name = decl && isCoreDeclaration(decl) && ts.isFunctionDeclaration(decl) && decl.name ? decl.name.text : callee.text;
		const arg = (k: number) => e.arguments[k];
		const lib = !decl || decl.getSourceFile().isDeclarationFile;
		// `RegExp(re)` without flags is `re` itself; otherwise it constructs as `new RegExp` does.
		if (name === 'RegExp' && isLibDeclaration(decl)) {
			if (e.arguments.length === 1 && isNamed(spelledType(this.typeOf(arg(0))), 'JSRegExp')) return this.expr(arg(0));
			if (arg(0) && !this.isString(arg(0))) return `JSRegExp.construct(${this.restArgument(e, arg(0), 'Any?')}${arg(1) ? `, ${this.restArgument(e, arg(1), 'Any?')}` : ''}, call: true)`;
			return `JSRegExp(${arg(0) ? this.str(arg(0)) : '"(?:)"'}${arg(1) ? `, ${this.str(arg(1))}` : ''})`;
		}
		if (this.isArrayConstruction(e)) {
			const made = this.newArray(e, this.typeOf(e), e.arguments);
			if (made) return made;
		}
		const hooked = this.framework.hooks.globalCall?.(this, name, e, decl, lib);
		if (hooked !== undefined) return hooked;
		const made = this.framework.signalConstructor(name);
		if (made && !made.linked && (!made.typed || this.typeOf(e).startsWith('Signal<')) && lib) {
			const t = this.typeOf(e).replace(/^Signal<(.*)>$/, '$1');
			const value = arg(0) ? this.restArgument(e, arg(0), t) : 'nil';
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
					return arg(0) ? (conversionCallThrowing(this, e) ?? this.toNumber(arg(0))) : '0';
				case 'Boolean':
					return arg(0) ? this.cond(arg(0)) : 'false';
				case 'parseInt':
					return `${RT.jsParseInt}(${this.str(arg(0))}${arg(1) ? `, ${this.expr(arg(1))}` : ', nil'})`;
				case 'isNaN':
					return `(${this.toNumber(arg(0))}).isNaN`;
				case 'isFinite':
					return `${this.toNumber(arg(0))}.isFinite`;
				case 'setTimeout':
				case 'setInterval': {
					const timer = RT[globalOp(op)];
					const ms = arg(1) ? (this.typeOf(arg(1)) === 'Double' ? this.expr(arg(1)) : this.toNumber(arg(1))) : '0';
					const f = arg(0);
					const literal = ts.isArrowFunction(f) || ts.isFunctionExpression(f);
					const gives = literal && this.returnTypeOf(f) !== 'Void';
					if (e.arguments.length <= 2 && !gives) return `${timer}(${this.callback(f)}, ${ms})`;
					// The arguments after the delay are the callback's, evaluated now; what the callback gives is dropped.
					const fn = functionParts((literal ? this.closureType(f) : this.typeOf(f)).replace(/^\((.*)\)[?!]$/, '$1'));
					const params = fn?.params.map((p) => p.replace(/^@escaping /, '')) ?? [];
					const binds = e.arguments.slice(2, 2 + params.length).map((a, k) => `let __t${k}: ${params[k]} = ${this.marks.tryBefore(this.tryPrefix(a), this.coerce(a, params[k]))}`);
					const args = params.map((p, k) => (k < binds.length ? `__t${k}` : p === 'Void' ? '()' : 'nil'));
					const body = `${[...binds, `let __f = ${this.expr(f)}`].join('; ')}; return ${timer}({ ${RT.jsReport} { _ = try __f(${args.join(', ')}) } }, ${ms})`;
					return e.arguments.slice(1, 2 + params.length).some((a) => this.throwsInfo.expr(a)) ? this.marks.ownTried(`{ () throws -> Double in ${body} }()`) : `{ () -> Double in ${body} }()`;
				}
				case 'clearTimeout':
				case 'clearInterval':
					return `${RT[globalOp(op)]}(${arg(0) ? this.restArgument(e, arg(0), 'Double?') : 'nil'})`;
				case 'requestAnimationFrame': {
					// A callback declaring no parameter is called with none: Swift's function type has no slot for the time.
					let literal: ts.Expression = arg(0);
					while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
					const takesTime =
						this.checker
							.getTypeAtLocation(arg(0))
							.getCallSignatures()
							.some((sig) => sig.parameters.length > 0) ||
						((ts.isArrowFunction(literal) || ts.isFunctionExpression(literal)) && this.unusedParameters(literal).length > 0);
					return `${RT.jsRequestAnimationFrame}({ __t in ${RT.jsReport} { try ${this.expr(arg(0))}(${takesTime ? '__t' : ''}) } })`;
				}
				case 'cancelAnimationFrame':
					return `${RT.jsCancelAnimationFrame}(${arg(0) ? this.restArgument(e, arg(0), 'Double?') : 'nil'})`;
				case 'Symbol':
					return `${RT.jsSymbol}(${arg(0) ? this.str(arg(0)) : 'nil'})`;
				case 'BigInt':
					return `JSBigInt(convert: ${this.restArgument(e, arg(0), 'Any?')})`;
			}
			if (fn?.args) return runtimeCall(this, fn, e);
			// `Error('x')` constructs as `new Error('x')` does.
			if (ERRORS[name]) return this.errorValue(name, e.arguments);
			if (name === 'getComputedStyle') return `({ (_: Any?) -> Any? in JSObject([("getPropertyValue", { (_: [Any?]) -> Any? in "" } as JSFunction)]) }(${arg(0) ? this.coerce(arg(0), 'Any?') : 'nil'}))`;
			if (decl && /[\\/]lib\.[\w.]*\.d\.ts$/.test(decl.getSourceFile().fileName)) throw this.error(e, `${name}()`, name === 'Object' ? 'object-call' : 'library-member');
		}
		// A function the program only declares (`declare function __startCPUProfiler(name)`, which the runtime may provide): the global object's.
		if (!this.library && decl && ts.isFunctionDeclaration(decl) && !decl.body && hasModifier(decl, ts.SyntaxKind.DeclareKeyword) && (!decl.getSourceFile().isDeclarationFile || isAppDeclarationFile(decl))) {
			const call = this.marks.tryCode(`${RT.jsCall}(jsGlobalThis[jsKey: ${swiftString(name)}]${this.untypedArgs(e)})`);
			const t = this.typeOf(e);
			return t === 'Void' || isUntyped(spelledType(t)) ? call : this.fromAnyCode(call, t, true);
		}
		const resolvers = this.resolvers.get(this.resolve(callee)!);
		if (resolvers) {
			if (!arg(0)) return `${resolvers.name}.resolve()`;
			if (isKit(spelledType(this.typeOf(arg(0))), 'JSPromise')) return `${resolvers.name}.resolve(promise: ${this.expr(arg(0))})`;
			return `${resolvers.name}.resolve(${this.restArgument(e, arg(0), resolvers.type)})`;
		}
		const declared = this.checker.getResolvedSignature(e)?.getDeclaration();
		const isFunctionValue = !declared || ts.isJSDocSignature(declared) || !('body' in declared && declared.body) || ts.isArrowFunction(declared) || ts.isFunctionExpression(declared);
		// A function held untyped (one of several function types): called as script calls it.
		if (this.isAny(callee) && !(declared && ts.isFunctionDeclaration(declared) && declared.body)) {
			const code = `${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`;
			const t = this.typeOf(e);
			return isUntyped(spelledType(t)) || t === 'Void' ? code : this.fromAnyCode(code, t, true);
		}
		const fn = ts.isIdentifier(callee) ? `${this.refName(callee)}${this.states.nullishRead(callee) ? '.optional' : ''}` : ident(name);
		const qualified = this.appModule && shadowedByMember(e, this.resolve(callee)?.declarations?.[0], fn, ident) ? `${this.appModule}.${fn}` : fn;
		const args = this.args(e, isFunctionValue ? undefined : this.arity(e));
		const value = this.narrowed(callee, qualified);
		const call = `${this.loose(callee) ? `${RT.jsCallable}(${value}, ${swiftString(callee.text)})` : value}(${(!this.library && decl ? this.core.exportArgs(e, decl, args) : args).join(', ')})`;
		return !this.library && decl ? this.core.moduleCall(decl, call, this.typeOf(e), e) : call;
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
					if (ts.isShorthandPropertyAssignment(p)) given.set(p.name.text, this.shorthandValue(p));
					else if (ts.isPropertyAssignment(p)) given.set((p.name as ts.Identifier).text, this.expr(p.initializer));
				}
			}
		}
		const args = info.props.map((p) => `${ident(p)}: ${given.get(p) ?? 'nil'}`).join(', ');
		return `${RT.kitNavigate} { try ${programClassName(this, component)}(${args}).${info.members.render}() }`;
	},

	toNumber(this: Translator, e: ts.Expression): string {
		const t = this.typeOf(e);
		if (t === 'Double') return this.expr(e);
		if (t === 'JSBigInt') return `${this.expr(e)}.toDouble()`;
		// Lenient code's date may be missing (`(x: Date, y: Date) => x <= y` given undefined): NaN, as JavaScript converts undefined.
		if (t === 'JSDate') return this.lenient && !ts.isNewExpression(e) ? `((${this.expr(e)} as JSDate?)?.valueOf() ?? .nan)` : `${this.expr(e)}.valueOf()`;
		if (this.native.isEnumType(t)) return `Double(${this.expr(e)}.rawValue)`;
		if (t.endsWith('?') && this.native.isEnumType(t.slice(0, -1))) return `Double(${this.expr(e)}?.rawValue ?? 0)`;
		if (t === 'String') return `${RT.jsNumberFromString}(${this.expr(e)})`;
		if (t === 'Bool') return `(${this.expr(e)} ? 1 as Double : 0)`;
		const keyed = t.endsWith('?') && this.states.unsetNullField(ts.skipOuterExpressions(e)) ? this.states.nullableEntry(e, () => this.expr(e)) : null;
		if (keyed) return `${RT.jsToNumber}(${keyed})`;
		if (t === 'Double?' && this.states.nilIsNull(e)) return `(${this.expr(e)} ?? 0)`;
		if (t.endsWith('?') && this.states.nilIsNull(e)) return `${RT.jsToNumber}(${RT.jsNulled}(${this.expr(e)}))`;
		return `${RT.jsToNumber}(${this.expr(e)})`;
	},
};
