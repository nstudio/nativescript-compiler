// Calls as Swift: functions, methods, prototype calls, JavaScript globals and statics, native dispatch.
import ts from 'typescript';
import { LIB_FUNCTION_VALUES, LIST_APPLIED, isTypedArrayType } from './library.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { comparedToNullish, functionParts, hasTopLevelArrow, ident, isFunctionType, isOptional, isSymbolAsyncIterator, openSwiftChain, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { assertedReceiverCell, nullishField } from '../semantics/placement.ts';
import { hookedDynamicImport, intlConstructor, isDomGlobalDeclaration, isObjectToStringCall, mergedInterfaceMemberOf, statementLevel, isArguments, isSelf } from '../semantics/lang.ts';
import { isLibDeclaration, isSymbolIterator } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { callableSignal, mayBeUnset } from '../semantics/signals.ts';
import { baseMethod } from '../semantics/classes.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { isKitInstanceMethod } from '../program/core-facts.ts';

export const callsMethods = {
	/** How many parameters the called function declares (JavaScript ignores extra arguments). */
	arity(this: Translator, e: ts.CallExpression): number | undefined {
		const sig = this.checker.getResolvedSignature(e);
		const decl = sig?.getDeclaration();
		if (!decl || ts.isJSDocSignature(decl)) return undefined;
		if (decl.parameters.some((p) => p.dotDotDotToken)) return undefined;
		return decl.parameters.length;
	},

	/** `global`, as a declaration file declares it (`declare var global: typeof globalThis`): the global object, untyped. */
	isAmbientGlobal(this: Translator, e: ts.Node): boolean {
		if (!ts.isIdentifier(e) || e.text !== 'global') return this.isDomGlobal(e);
		const decl = this.resolve(e)?.declarations?.[0];
		return !!decl && decl.getSourceFile().isDeclarationFile;
	},

	/** A browser global only TypeScript's DOM library declares, or nothing does (`window`, `navigator`, `Blob`): the global object's property of that name, untyped. */
	isDomGlobal(this: Translator, e: ts.Node): boolean {
		if (this.library || !ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e.parent) && e.parent.name === e) || ts.isTypeNode(e.parent)) return false;
		if (Object.hasOwn(LIB_FUNCTION_VALUES, e.text)) return false;
		const decls = this.resolve(e)?.declarations ?? [];
		// A plugin's name nothing declares here (`window` where its own build had the DOM's typings): the global object's, undefined.
		if (!decls.length) return this.pluginFiles.has(e.getSourceFile().fileName) && !isArguments(e, this.checker) && !['undefined', 'NaN', 'Infinity'].includes(e.text);
		return isDomGlobalDeclaration(e.text, decls);
	},

	isGlobalThis(this: Translator, e: ts.Node): boolean {
		const sym = this.checker.getSymbolAtLocation(e);
		return !!sym && sym.name === 'globalThis' && !!(sym.flags & ts.SymbolFlags.ValueModule) && (sym.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile);
	},

	/** Reading the callable signal `callee` holds (`callee()`); `plain` wraps a read of its value that can't throw. */
	signalRead(this: Translator, callee: ts.Expression, plain = (code: string) => code): string {
		const own = ts.isPropertyAccessExpression(callee) && isSelf(callee.expression, this.subst) ? callee.name.text : undefined;
		if (own !== undefined && this.computed.has(own)) return `self.${ident(own)}`;
		// A signal its parent may not have set yet: the read throws the framework's error until it has. A linked one
		// rethrows what its computation threw.
		if (mayBeUnset(callee, this.checker, this.framework) || this.throwsInfo.linkedThrows(callee)) return this.marks.ownTried(`${own !== undefined && this.props.has(own) ? `self.${ident(own)}` : this.expr(callee)}.requiredValue()`);
		if (own !== undefined && (this.props.has(own) || this.signalFields.has(own))) return `self.${ident(own)}.value`;
		if (this.framework.signalKind(this.symbolName(callee)) === 'computed' && this.isSwiftComputedProperty(callee)) return this.expr(callee);
		return plain(`${this.expr(callee)}.value`);
	},

	call(this: Translator, e: ts.CallExpression): string {
		if (ts.isPropertyAccessExpression(e.expression) && ['indexOf', 'lastIndexOf', 'includes', 'has', 'get', 'set', 'add', 'delete'].includes(e.expression.name.text) && e.arguments[0]) this.refuseUnheldIdentity(e.arguments[0]);
		const extended = this.extendCall(e);
		if (extended) return extended;
		const callee = e.expression;
		// A method of an event's own object (`args.getX()` of a gesture's data), by name.
		if (ts.isPropertyAccessExpression(callee) && !this.library && this.core.eventMember(callee)) {
			const code = `${RT.jsCallMethod}(${this.expr(callee.expression)}, ${swiftString(callee.name.text)}${e.arguments.map((a) => `, ${this.coerce(a, 'Any?')}`).join('')})`;
			const t = this.typeOf(e);
			return t === 'Void' || isUntyped(spelledType(t)) ? code : this.fromAnyCode(code, t, true);
		}
		// `Cls.class()` of a class extending a native one: the class itself, which Swift names `Cls.self`.
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'class' && !e.arguments.length && (this.resolve(callee.expression)?.flags ?? 0) & ts.SymbolFlags.Class && this.native.extendsNative(this.checker.getDeclaredTypeOfSymbol(this.resolve(callee.expression)!))) {
			const cls = this.expr(callee.expression);
			return cls.endsWith('.self') ? cls : `${cls}.self`;
		}
		// `o.hasOwnProperty(key)`, Object.prototype's: whether o has the key itself, whatever Swift type o is.
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'hasOwnProperty' && e.arguments.length === 1 && !this.isAny(callee.expression) && this.resolve(callee.name)?.declarations?.some((d) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(d.getSourceFile().fileName))) {
			return `${RT.jsHasOwn}(${this.coerce(callee.expression, 'Any?')}, ${this.propertyKey(e.arguments[0])})`;
		}
		// Reading a callable signal (`count()`, an input, a computed field).
		if (!e.arguments.length && callableSignal(this.framework.signalKind(this.symbolName(callee)))) return this.signalRead(callee, (code) => (this.nullSignalRead(e) ? this.marks.implicitOf(code) : code));
		if (callee.kind === ts.SyntaxKind.SuperKeyword) throw this.error(e, 'super() outside the start of a constructor');
		const dynImport = hookedDynamicImport(e, this.framework.hooks);
		if (dynImport) return dynImport;
		// `getWindow<UIWindow>?.()`: the type arguments are only TypeScript's, and a function declaration is always there.
		const declaredFunction = (x: ts.Expression) => ts.isIdentifier(x) && !!this.resolve(x)?.declarations?.some(ts.isFunctionDeclaration);
		if (ts.isExpressionWithTypeArguments(callee) && (!e.questionDotToken || declaredFunction(callee.expression))) return this.call(ts.factory.updateCallExpression(e, callee.expression, callee.typeArguments, e.arguments));
		if (e.questionDotToken && this.isAny(callee)) return `${RT.jsCallOptional}(${this.expr(callee)}${this.untypedArgs(e)})`;
		if (!e.questionDotToken && this.heldRead(callee) && this.isAny(callee)) {
			const t = this.typeOf(e),
				value = this.marks.tryCode(`${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`);
			return t === 'Void' || isUntyped(spelledType(t)) || statementLevel(e) ? value : this.fromAnyCode(value, t, true);
		}
		if (ts.isPropertyAccessExpression(callee) && (this.declaredOnly(callee) || mergedInterfaceMemberOf(callee, this.checker))) {
			const o = this.fresh('__o'),
				key = swiftString(callee.name.text);
			const call = this.marks.tryCode(`${RT.jsCallMethod}(${[o, key, ...e.arguments.map((a) => this.restArgument(e, a, 'Any?'))].join(', ')})`);
			const receiver = this.coerce(callee.expression, 'Any?');
			const absent = [...(callee.questionDotToken ? [`${RT.jsIsNullish}(${o})`] : []), ...(e.questionDotToken ? [`${RT.jsIsNullish}(${RT.jsGet}(${o}, ${key}))`] : [])];
			const value = `({ () throws -> Any? in let ${o}: Any? = ${this.receiverThrows(callee.expression) ? 'try ' : ''}${receiver}; return ${absent.length ? `try ${absent.join(' || ')} ? nil : ` : ''}${call} }())`;
			const t = ts.isOptionalChain(e) ? optionalType(this.typeOf(e)) : this.typeOf(e);
			return t === 'Void' || isUntyped(spelledType(t)) || statementLevel(e) ? value : this.fromAnyCode(value, t, true);
		}
		// `obj.method?.(…)` on a method a declaration file or a class declares: the method is always there, so the call is a plain one.
		const declaredMethod = ts.isPropertyAccessExpression(callee) && this.resolve(callee.name)?.declarations?.some((d) => ((ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) && d.getSourceFile().isDeclarationFile) || (ts.isMethodDeclaration(d) && ts.isClassLike(d.parent) && !d.questionToken));
		// A method an instance may be given a property in place of (`Object.defineProperty(this, 'm', …)`): the instance's, when it has one.
		if (ts.isPropertyAccessExpression(callee) && callee.expression.kind !== ts.SyntaxKind.SuperKeyword && !this.ownCalls.has(e) && this.isInstanceMethod(callee.name)) {
			// The receiver is read twice: anything but a variable, `this` or its fields (a call, a getter) is bound first.
			const fieldRead = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(x) && !x.questionDotToken && fieldRead(x.expression) && !this.isAny(x.expression) && this.looseReceiverKey(x.expression) === null && !!this.resolve(x.name)?.declarations?.length && !this.resolve(x.name)!.declarations!.some(ts.isAccessor));
			const recv = callee.expression;
			let bound = '';
			if (!ts.isIdentifier(recv) && !fieldRead(recv)) {
				const o = this.fresh('__o');
				bound = `let ${o}: ${this.optionalResult(recv) ? optionalType(this.typeOf(recv)) : this.typeOf(recv)} = ${this.marks.tryBefore(this.tryPrefix(recv), this.expr(recv))}; `;
				this.subst.set(recv, o);
			}
			const t = this.typeOf(e);
			const ret = t !== 'Void' && !isUntyped(spelledType(t)) && !isOptional(t) && this.givesUndefined(e) ? optionalType(t) : t;
			this.ownCalls.add(e);
			try {
				const own = this.fresh('__own');
				const args = e.arguments.some(ts.isSpreadElement) ? `${this.packed(e.arguments, 'JSArray<Any?>', this.restSlot(e, 'Any?'))}.storage` : `[${e.arguments.map((a) => this.restArgument(e, a, 'Any?')).join(', ')}]`;
				const ownCall = this.marks.tryCode(`${RT.jsCallValue}(${own}, this: ${this.coerce(callee.expression, 'Any?')}, optional: ${!!e.questionDotToken || !!callee.questionDotToken}, ${args})`);
				const holder = this.coerce(callee.expression, 'Any?');
				const read = this.marks.tryIf(this.receiverThrows(callee.expression), `${RT.jsOwnProperty}(${holder}, ${swiftString(callee.name.text)})`);
				const cond = `if let ${own} = ${read}${this.library ? '' : `, ${own} != nil`}`;
				if (t === 'Void') return `({ () throws -> Void in ${bound}${cond} { ${ownCall} } else { ${this.tryPrefix(e)}${this.call(e)} } }())`;
				return `({ () throws -> ${ret} in ${bound}${cond} { return ${isUntyped(spelledType(ret)) ? ownCall : this.fromAnyCode({ code: this.marks.leading(`(${ownCall})`, ownCall), throws: true, pure: false }, ret, true)} }; return ${this.tryPrefix(e)}${this.call(e)} }())`;
			} finally {
				this.ownCalls.delete(e);
				this.subst.delete(recv);
			}
		}
		// `callback?.(x)` of a parameter declared present: Swift has it as non-optional, and the call is a plain one.
		const param = ts.isIdentifier(callee) ? this.resolve(callee)?.valueDeclaration : undefined;
		const presentParam = !!param && ts.isParameter(param) && !param.questionToken && !param.initializer && !this.states.mayBeNull(param) && isFunctionType(this.typeOf(callee));
		if (e.questionDotToken && !presentParam && !isKitInstanceMethod(this.core, callee) && !declaredMethod && !declaredFunction(callee)) {
			// A field narrowed to a function already reads unwrapped.
			const fn = this.expr(callee);
			return fn.endsWith('!') ? `${fn}(${this.args(e).join(', ')})` : `${fn}?(${this.args(e).join(', ')})`;
		}
		if (ts.isIdentifier(callee)) return this.globalCall(callee, e);
		const nsMember = ts.isPropertyAccessExpression(callee) ? this.namespaceMember(callee) : null;
		if (nsMember) {
			if (this.isAny(callee)) {
				const code = `${RT.jsCall}(${this.narrowed(callee, nsMember)}${this.untypedArgs(e)})`;
				const t = this.typeOf(e);
				return isUntyped(spelledType(t)) || t === 'Void' ? code : this.fromAnyCode(code, t, true);
			}
			const declared = this.checker.getResolvedSignature(e)?.getDeclaration();
			const isFunctionValue = !declared || ts.isJSDocSignature(declared) || !('body' in declared && declared.body) || ts.isArrowFunction(declared) || ts.isFunctionExpression(declared);
			const value = this.narrowed(callee, nsMember);
			return `${this.heldFunctionCall(e) ? `${RT.jsCallable}(${value}, ${swiftString(callee.getText().replace(/\s+/g, ' '))})` : value}(${this.args(e, isFunctionValue ? undefined : this.arity(e)).join(', ')})`;
		}
		const intl = intlConstructor(callee, this.checker);
		if (intl) return `JS${intl}(${e.arguments.map((a) => this.restArgument(e, a, 'Any?')).join(', ')})`;
		this.refuseIntlMember(callee);
		if (isObjectToStringCall(callee, this.checker)) return `${RT.jsObjectToString}(${e.arguments[0] ? this.coerce(e.arguments[0], 'Any?') : 'nil'})`;
		// A callback passed as a prop (`onTap: () => void`).
		if (ts.isPropertyAccessExpression(callee) && isSelf(callee.expression, this.subst) && this.props.has(callee.name.text)) {
			const unwrap = this.declaredTypeOf(callee)?.endsWith('?') ? '!' : '';
			return `self.${ident(callee.name.text)}.value${unwrap}(${this.args(e, this.arity(e)).join(', ')})`;
		}
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'then' && ts.isCallExpression(callee.expression) && ts.isIdentifier(callee.expression.expression) && callee.expression.expression.text === '$showModal') {
			return this.showModal(callee.expression, e.arguments[0]);
		}
		if (ts.isPropertyAccessExpression(callee)) {
			const method = callee.name.text;
			const target = callee.expression;
			const owner = this.symbolName(target);
			const kind = this.framework.signalKind(owner);
			const signalValue = () => this.typeOf(target).replace(/^Signal<(.*)>$/, '$1');
			const throwingWrite = kind === 'writable' && this.throwsInfo.signalWriteThrows(e);
			if (throwingWrite && method === 'set') return this.marks.tryIf(true, `${this.expr(target)}.setThrowing(${this.signalWrite(target, e.arguments[0], signalValue(), true, e)})`);
			if ((throwingWrite || ((kind === 'model' || kind === 'input') && mayBeUnset(target, this.checker, this.framework)) || (kind === 'writable' && this.throwsInfo.linkedThrows(target))) && method === 'update') return this.marks.tryIf(true, `${this.expr(target)}.updateThrowing(${this.closure(e.arguments[0] as ts.ArrowFunction)})`);
			if ((kind === 'store' || kind === 'writable') && method === 'set') return this.marks.assignedCode(`${this.expr(target)}.value`, this.signalWrite(target, e.arguments[0], signalValue(), true, e), this.receiverThrows(target));
			// A prop (`this.x`) reads as its value: the signal itself is the field.
			if (kind === 'input' && method === '$assign') return this.marks.assignedCode(`${ts.isPropertyAccessExpression(target) && isSelf(target.expression, this.subst) && this.props.has(target.name.text) ? `self.${ident(target.name.text)}` : this.expr(target)}.value`, this.signalWrite(target, e.arguments[0], signalValue(), true, e), this.receiverThrows(target));
			if ((kind === 'store' || kind === 'writable') && method === 'update') return `${this.expr(target)}.update(${this.closure(e.arguments[0] as ts.ArrowFunction)})`;
			if (kind === 'writable' && method === '$write') {
				// A setter: a function updates, anything else is the new value.
				const a = e.arguments[0];
				if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return `${this.expr(target)}.update(${this.closure(a)})`;
				return this.marks.assignedCode(`${this.expr(target)}.value`, this.coerce(a, signalValue()), this.receiverThrows(target));
			}
			const hooked = this.framework.hooks.methodCall?.(this, owner, method, e);
			if (hooked !== undefined) return hooked;
			if ((kind === 'writable' || kind === 'computed') && method === 'asReadonly') return this.expr(target);
			if (ts.isIdentifier(target) && isLibGlobal(this, target)) return this.staticCall(target.text, method, e);
			// `Cls.class()`: the class itself.
			if (method === 'class' && !e.arguments.length && this.resolve(target)?.flags! & ts.SymbolFlags.Class && this.resolve(callee.name)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return `${this.expr(target).replace(/\.self$/, '')}.self`;
			// A native enum's value is a number to script: its raw value's digits.
			if (method === 'toString' && !e.arguments.length && this.native.isEnumType(this.typeOf(target).replace(/[?!]$/, ''))) return `String(${this.expr(target)}${/[?!]$/.test(this.typeOf(target)) ? '!' : ''}.rawValue)`;
			// `String.fromCharCode.apply(_, codes)`, `Math.max.apply(_, xs)`: the library function of the list's elements.
			if (method === 'apply' && e.arguments.length === 2 && this.pure(e.arguments[0]) && ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && isLibGlobal(this, target.expression)) {
				const listed = LIST_APPLIED[`${target.expression.text}.${target.name.text}`];
				if (listed) return `${listed}(${this.coerce(e.arguments[1], 'Any?')})`;
			}
			const prototypeCall = method === 'call' ? this.native.prototypeCall(e) : null;
			if (prototypeCall) return prototypeCall;
			this.refuseCallReceiver(e);
			const builtin = method === 'call' || method === 'apply' ? this.builtinPrototypeCall(method, target, e) : null;
			if (builtin) return builtin;
			if (['call', 'apply', 'bind'].includes(method) && isLibDeclaration(this.checker.getResolvedSignature(e)?.getDeclaration()) && (functionParts(this.typeOf(target).replace(/^\((.*)\)[?!]$/, '$1')) || (ts.isPropertyAccessExpression(target) && target.expression.getText() === 'Function.prototype' && ['call', 'apply', 'bind'].includes(target.name.text)))) return this.functionMethod(method, target, e);
			if ((method === 'call' || method === 'apply') && this.programPrototypeMethod(target) && isLibDeclaration(this.checker.getResolvedSignature(e)?.getDeclaration())) return this.functionMethod(method, target, e);
			const required = this.library ? null : this.core.requiredModuleCall(e);
			if (required) return required;
			// `handler.toString()` of a typed function value: the text script gives a function the runtime holds.
			if (method === 'toString' && !e.arguments.length && functionParts(this.typeOf(target).replace(/^\((.*)\)[?!]$/, '$1'))) return `${RT.jsToString}(${this.coerce(target, 'Any?')})`;
			// `error.toString()` of an error the program doesn't declare a toString for: Error.prototype.toString, "name: message".
			if (method === 'toString' && !e.arguments.length && !e.questionDotToken && this.isErrorObject(target)) return `${RT.jsToString}(${this.coerce(target, 'Any?')})`;
			if (method === 'toString' && !e.arguments.length && !e.questionDotToken && this.typeOf(target) === 'String') return this.expr(target);
			const core = this.core.call(e) ?? this.native.call(e);
			if (core) return core;
			// A member holding an untyped value (`closedCallback: Function`), called: with the object as `this`.
			if (this.library && !e.questionDotToken && !this.isAny(target) && this.isAny(callee) && !this.resolve(callee.name)?.declarations?.some((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d))) {
				const call = `${callee.questionDotToken ? RT.jsCallMethodIfPresent : RT.jsCallMethod}(${this.coerce(target, 'Any?')}, ${swiftString(method)}${this.untypedArgs(e)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Void' ? call : this.fromAny(call, rt);
			}
			if (this.isAny(target)) {
				const code = `${callee.questionDotToken ? RT.jsCallMethodIfPresent : RT.jsCallMethod}(${this.expr(target)}, ${swiftString(method)}${this.untypedArgs(e)})`;
				// An untyped receiver of a typed interface (`value: IColor` with no protocol): the result as the interface types it.
				const t = this.typeOf(e);
				if (isUntyped(spelledType(t)) || t === 'Void' || this.rawOptional.has(e)) return code;
				return callee.questionDotToken ? this.undefinedAs(this.fromAny(code, optionalType(t)), t) : this.untypedResult(e, code, t);
			}
			// A field holding a function untyped (`private _resolve;`): called with the object as `this`.
			const field = this.resolve(callee.name)?.valueDeclaration;
			if (this.isAny(callee) && field && (ts.isPropertyDeclaration(field) || ts.isPropertySignature(field) || (ts.isMethodSignature(field) && !isLibDeclaration(field)) || ts.isParameter(field))) {
				const args = e.arguments.some(ts.isSpreadElement) ? `${this.packed(e.arguments, 'JSArray<Any?>', this.restSlot(e, 'Any?'))}.storage` : `[${e.arguments.map((a) => this.restArgument(e, a, 'Any?')).join(', ')}]`;
				const code = `${RT.jsCallValue}(${this.expr(callee)}, this: ${this.coerce(target, 'Any?')}, optional: ${!!e.questionDotToken}, ${args})`;
				const t = this.typeOf(e);
				return isUntyped(spelledType(t)) || t === 'Void' ? code : this.fromAnyCode(code, t, true);
			}
			// A namespace's const holding a function untyped, reached through an alias of the namespace.
			if (this.isAny(callee) && field && ts.isVariableDeclaration(field) && ts.isModuleBlock(field.parent.parent.parent)) {
				const code = `${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`;
				const t = this.typeOf(e);
				return isUntyped(spelledType(t)) || t === 'Void' ? code : this.fromAnyCode(code, t, true);
			}
			const t = this.typeOf(target).replace(/\?$/, '');
			// `xs?.find(…)` on a value Swift holds as present (a lenient array that starts empty): a plain call.
			const receiverType = this.typeOf(target);
			// A call continuing an optional chain (`xs?.map(f).join(',')`) is part of the chain: within Swift's own chain it
			// continues it, and after a chain the translation wrapped (`jsSplit(s?.…)`) it chains on the optional made.
			const openChain = ts.isOptionalChain(target) && openSwiftChain(this.expr(target));
			const continued = !callee.questionDotToken && ts.isOptionalChain(target) && (receiverType.endsWith('?') || this.implicitChain(target) || openChain) ? (openChain && !(ts.isPropertyAccessExpression(target) && this.continuesOptional(target)) ? '' : '?') : null;
			// A receiver the translation already unwrapped where it reads the member (`jsUnwrap(m.get(k), "bind")`) needs no other.
			const unwrapped = this.looseReceiverKey(target) !== null;
			const q = continued ?? (callee.questionDotToken ? (this.optionalCallHead(target) ? '?' : '') : !unwrapped && (receiverType.endsWith('?') || (ts.isCallExpression(target) && !this.looseObjectRead(target) && this.maybeUndefined(target))) ? '!' : '');
			if (method === 'fill' && this.isArrayConstruction(target) && target.arguments?.length === 1 && e.arguments.length === 1) {
				// `new Array(n).fill(v)` or `Array(n).fill(v)`: n copies of v, typed as the array is declared (`const widths: number[] = …`).
				const context = this.checker.getContextualType(e);
				const declared = context ? this.type(context, e) : null;
				const at = t === 'JSArray<Any?>' && declared?.startsWith('JSArray<') ? declared : t;
				return `${at}(Array(repeating: ${this.coerce(e.arguments[0], at.replace(/^JSArray<(.*)>$/, '$1'))}, count: ${this.arrayLength(target.arguments[0])}))`;
			}
			if (method === 'join' && isTypedArrayType(t) && !q && e.arguments.length === 1 && !ts.isSpreadElement(e.arguments[0])) return `${this.expr(target)}.join(${this.joinSeparator(e.arguments[0])})`;
			const typedThisArg = isTypedArrayType(t) ? this.typedArrayThisArgCall(e) : null;
			if (typedThisArg) return this.ignoringThisArg(e, target, () => this.call(typedThisArg));
			if (isKit(spelledType(t), 'JSArray')) {
				// `observers?.find(…)` on an array TypeScript types as present, which lenient code may hold as undefined: cast to optional, valid either way.
				const checked = !callee.questionDotToken && !ts.isOptionalChain(callee) ? this.receiver(target, method) : null;
				if (checked) return this.arrayMethod(method, target, e, '', this.marks.ownTried(checked));
				const asserted = callee.questionDotToken ? null : assertedReceiverCell(this.receivers, target, method);
				if (asserted?.cell === 'present') return this.arrayMethod(method, target, e, q, this.marks.ownTried(this.receiverCode(asserted, method)!));
				if (!callee.questionDotToken || q || !this.lenient) return this.arrayMethod(method, target, e, q);
				const x = this.expr(target);
				const code = this.arrayMethod(method, target, e, '', this.marks.leading(`(${x} as ${optionalType(receiverType)})?`, x));
				const rt = this.typeOf(e);
				return rt.endsWith('?') || isUntyped(spelledType(rt)) || rt === 'Void' || ts.isExpressionStatement(e.parent) || comparedToNullish(e) || this.rawOptional.has(e) ? code : this.undefinedAs(this.marks.parens(code), rt);
			}
			if (t === 'JSMatch' && method !== 'toString') {
				this.subst.set(target, `${this.expr(target)}${q}.${this.matchElement(target, method) === 'String' ? 'jsStrings' : 'values'}`);
				try {
					return this.arrayMethod(method, target, e, '');
				} finally {
					this.subst.delete(target);
				}
			}
			if (t.startsWith('(') && this.checker.isTupleType(this.checker.getTypeAtLocation(target))) {
				// A tuple used as an array: its elements as one.
				const n = this.checker.getTypeArguments(this.checker.getTypeAtLocation(target) as ts.TypeReference).length;
				const el = this.typeOf(target).slice(1, -1).split(', ');
				const element = el.every((x) => x === el[0]) ? el[0] : 'Any?';
				const tmp = this.fresh('__tuple');
				const value = this.expr(target),
					valueTry = this.tryPrefix(target);
				this.subst.set(target, `JSArray<${element}>([${Array.from({ length: n }, (_, k) => `${tmp}.${k}`).join(', ')}])`);
				try {
					const tr = this.tryPrefix(e);
					return `{ () ${tr || valueTry ? 'throws ' : ''}-> ${this.typeOf(e)} in let ${tmp}: ${t} = ${valueTry}${value}; return ${tr}${this.arrayMethod(method, target, e, '')} }()`;
				} finally {
					this.subst.delete(target);
				}
			}
			// `n?.toString()`, `s?.trim().split(',')`: the method on the value when there is one.
			if ((t === 'String' || t === 'Double') && (callee.questionDotToken || continued !== null) && this.typeOf(target).endsWith('?')) {
				const recv = this.expr(target);
				const v = this.fresh('__v');
				this.subst.set(target, v);
				try {
					return `(${recv}).map { (${v}: ${t}) in ${t === 'String' ? this.stringMethod(method, target, e) : this.numberMethod(method, target, e)} }`;
				} finally {
					this.subst.delete(target);
				}
			}
			const missing = (t === 'String' || t === 'Double') && !callee.questionDotToken && !this.subst.has(target) ? this.receiver(target, method) : null;
			if (missing) {
				this.subst.set(target, missing);
				try {
					return t === 'String' ? this.stringMethod(method, target, e) : this.numberMethod(method, target, e);
				} finally {
					this.subst.delete(target);
				}
			}
			// `s.slice(…)` of null or undefined throws, as unwrapping traps; only a chain reads undefined.
			if ((t === 'String' || t === 'Double') && (this.typeOf(target).endsWith('?') || this.optionalResult(target)) && !ts.isOptionalChain(e)) {
				this.subst.set(target, this.unsetGroupReceiver(target) ? this.expr(target) : this.marks.unwrappedCode(this.expr(target)));
				try {
					return t === 'String' ? this.stringMethod(method, target, e) : this.numberMethod(method, target, e);
				} finally {
					this.subst.delete(target);
				}
			}
			if (t === 'String') return this.stringMethod(method, target, e);
			if (t === 'Double') return this.numberMethod(method, target, e);
			if (t === 'JSBigInt' && method === 'toLocaleString') return `${RT.jsBigIntToLocaleString}(${[this.expr(target), ...e.arguments.map((x) => this.restArgument(e, x, 'Any?'))].join(', ')})`;
			if (isKit(spelledType(t), 'JSPromise')) return this.promiseMethod(method, target, e);
			if (/^JS(Iterator|Generator)</.test(t) && ['next', 'return', 'throw'].includes(method)) {
				return `${this.expr(target)}${q}.js${method[0].toUpperCase()}${method.slice(1)}Result(${e.arguments[0] ? this.coerce(e.arguments[0], 'Any?') : method === 'throw' ? 'nil' : ''})`;
			}
			if (/^JS(AsyncIterator|AsyncGenerator)</.test(t) && ['next', 'return', 'throw'].includes(method)) {
				return `${this.expr(target)}${q}.${ident(method)}(${e.arguments[0] ? this.coerce(e.arguments[0], 'Any?') : method === 'throw' ? 'nil' : ''})`;
			}
			if (isKit(spelledType(t), 'JSMap') || isKit(spelledType(t), 'JSSet')) {
				// `seen?.has(x)` on a value TypeScript types as present: cast to optional, valid whether Swift holds it as present or implicitly unwrapped.
				if (!callee.questionDotToken || q) return this.collectionMethod(method, target, e, q);
				const code = this.collectionMethod(method, target, e, '', `(${this.expr(target)} as ${optionalType(receiverType)})?`);
				const rt = this.typeOf(e);
				return rt.endsWith('?') || isUntyped(spelledType(rt)) || rt === 'Void' || ts.isExpressionStatement(e.parent) || comparedToNullish(e) || this.rawOptional.has(e) ? code : this.undefinedAs(this.marks.parens(code), rt);
			}
			// `this.method.bind(this)`: the method, which Swift binds to its object already.
			if (method === 'bind' && e.arguments.length === 1 && e.arguments[0].kind === ts.SyntaxKind.ThisKeyword && ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
				return this.expr(target);
			}
			// A property holding an optional function, called (`this.onDone(x)` after a check TypeScript does not keep).
			const held = this.checker.getSymbolAtLocation(callee.name)?.valueDeclaration;
			const optionalFn = !!held && (ts.isPropertyDeclaration(held) || ts.isPropertySignature(held) || (ts.isParameter(held) && !!ts.getModifiers(held)?.length)) && isOptional(this.declaredTypeOf(callee) ?? '') && hasTopLevelArrow(this.declaredTypeOf(callee)!.replace(/^\((.*)\)\?$/, '$1'));
			const checked = !callee.questionDotToken ? this.receiver(target, method) : null;
			// `x?.method()` on a value Swift has as non-optional: cast to optional, valid for an implicitly unwrapped one too.
			const tt = this.typeOf(target);
			if (callee.questionDotToken && !tt.endsWith('?') && !tt.endsWith('!') && !hasTopLevelArrow(tt) && !ts.isOptionalChain(target) && !(ts.isCallExpression(target) && this.maybeUndefined(target))) {
				const asserted = this.assertedUntyped(target);
				const x = asserted ? '' : this.expr(target);
				const recv = asserted ? this.assertedOptional(asserted) : this.marks.leading(`(${x} as ${optionalType(tt)})`, x);
				const code = this.marks.leading(`${recv}?.${ident(method)}${optionalFn ? '!' : ''}(${this.args(e, this.arity(e)).join(', ')})`, recv);
				const rt = this.typeOf(e);
				return rt.endsWith('?') || isUntyped(spelledType(rt)) || rt === 'Void' || ts.isExpressionStatement(e.parent) || this.rawOptional.has(e) ? code : this.undefinedAs(this.marks.parens(code), rt);
			}
			if (nullishField(this, callee) && !callee.questionDotToken) {
				const fn = e.questionDotToken ? `${this.nullishCode(callee)}.optional?` : this.marks.ownTried(`${this.nullishCode(callee)}.present(${swiftString(method)})`);
				return `${fn}(${this.args(e, this.arity(e)).join(', ')})`;
			}
			// A method Optional also declares (`series.map(f)`), on a value held implicitly unwrapped: the class's, not Optional's.
			const own = !this.library && !checked && !q && ['map', 'flatMap'].includes(method) && /^[\w.]+(<.*>)?$/.test(tt) ? `(${this.expr(target)} as ${tt})` : null;
			const recv = checked ?? own ?? this.expr(target);
			const member = `${recv}${(checked ?? own) ? '' : q}.${ident(method)}`;
			const plain = this.marks.leading(`${this.heldFunctionCall(e) ? `${RT.jsCallable}(${member}, ${swiftString(callee.getText().replace(/\s+/g, ' '))})` : member}(${this.args(e, this.arity(e)).join(', ')})`, recv);
			// An override emitted with its base's signature gives what the base's result type holds.
			const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
			if (decl && ts.isMethodDeclaration(decl) && decl.body && !decl.getSourceFile().isDeclarationFile && !isStatic(decl) && baseMethod(decl, this.checker)) {
				const emitted = this.emittedSignature(decl).ret,
					own = this.typeOf(e);
				// A plugin's result is held optional, whatever its root declares.
				const held = this.loose(e) && !emitted.endsWith('?') ? optionalType(emitted.replace(/!$/, '')) : emitted.replace(/!$/, '?');
				if (emitted !== 'Void' && emitted.replace(/!$/, '') !== own.replace(/!$/, '') && !q) return this.convert(plain, held, own);
			}
			// The chain ends at a call through a link Swift holds optional: TypeScript types its result present.
			const rt = this.typeOf(e),
				p = e.parent;
			const ends = !!p && !((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === e && ts.isOptionalChain(p));
			if (openChain && continued === '?' && ends && !isOptional(rt) && !isUntyped(spelledType(rt)) && rt !== 'Void' && !ts.isExpressionStatement(p) && !this.rawOptional.has(e)) return this.undefinedAs(this.marks.parens(plain), rt);
			return plain;
		}
		if (ts.isElementAccessExpression(callee) && isSymbolIterator(callee.argumentExpression, this.checker) && !e.arguments.length) return this.iteratorCode(callee.expression, true);
		if (ts.isElementAccessExpression(callee) && isSymbolAsyncIterator(callee.argumentExpression, this.checker) && !e.arguments.length) return this.asyncIteration(callee.expression);
		if (ts.isElementAccessExpression(callee) && this.setNativeOf(callee.argumentExpression) && this.keyedSetNative(callee.expression)) {
			// `super[prop.setNative](value)`: the base class's method under the symbol, with this object as `this`.
			const args = `[${e.arguments.map((a) => this.restArgument(e, a, 'Any?')).join(', ')}]`;
			if (callee.expression.kind === ts.SyntaxKind.SuperKeyword) return `${RT.jsCallFound}(super.jsSymbolMethod(${this.propertyKey(callee.argumentExpression)}), self, ${args})`;
			return `${RT.jsCallMethod}(${this.coerce(callee.expression, 'Any?')}, ${this.propertyKey(callee.argumentExpression)}${this.untypedArgs(e)})`;
		}
		if (ts.isElementAccessExpression(callee)) {
			const property = this.setNativeOf(callee.argumentExpression);
			if (property) return `${this.expr(callee.expression)}.__setNative_${property}(${e.arguments.map((a) => this.restArgument(e, a, 'Any?')).join(', ')})`;
		}
		let fn: ts.Expression = callee;
		while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
		// `(function () { … })()`: the closure, called.
		if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) return `${this.closure(fn)}(${this.args(e).join(', ')})`;
		// A callee the factory would parenthesize again (`(f as F)(…)`) is called through its own translation.
		if (ts.isParenthesizedExpression(callee) && (ts.isIdentifier(callee.expression) || ts.isPropertyAccessExpression(callee.expression) || ts.isElementAccessExpression(callee.expression) || ts.isCallExpression(callee.expression) || ts.isParenthesizedExpression(callee.expression))) return this.call(ts.factory.updateCallExpression(e, callee.expression, e.typeArguments, e.arguments));
		// `(value as F)(…)` of an untyped value: called as script calls it, its result read as F gives it.
		if (ts.isParenthesizedExpression(callee) && (ts.isAsExpression(callee.expression) || ts.isTypeAssertionExpression(callee.expression)) && this.isAny(callee.expression.expression)) {
			const code = `${RT.jsCall}(${[this.expr(callee.expression.expression), ...e.arguments.map((a) => this.restArgument(e, a, 'Any?'))].join(', ')})`;
			const t = this.typeOf(e);
			return isUntyped(spelledType(t)) || t === 'Void' ? code : this.fromAnyCode(code, t, true);
		}
		// `(value as F)(…)`: the value read as the function type, called.
		if (ts.isParenthesizedExpression(callee)) return `${this.expr(callee)}(${this.args(e).join(', ')})`;
		// `view[setNative](value)` (library mode): the method under that key, called with the object as `this`.
		if (this.library && ts.isElementAccessExpression(callee) && (this.isAny(callee.expression) || this.isAny(callee))) {
			return `${RT.jsCallMethod}(${this.coerce(callee.expression, 'Any?')}, ${this.propertyKey(callee.argumentExpression)}${this.untypedArgs(e)})`;
		}
		// App mode: a function held untyped (`closeModalGetter(args)(result)` of a `Function`, `knownFolders.ios[name]()`): called as script calls it.
		if (!this.library && (ts.isElementAccessExpression(callee) || ts.isCallExpression(callee)) && this.isAny(callee)) {
			const code = ts.isElementAccessExpression(callee) ? `${RT.jsCallMethod}(${this.coerce(callee.expression, 'Any?')}, ${this.propertyKey(callee.argumentExpression)}${this.untypedArgs(e)})` : `${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`;
			const t = this.typeOf(e);
			return isUntyped(spelledType(t)) || t === 'Void' ? code : this.fromAnyCode(code, t, true);
		}
		if (ts.isElementAccessExpression(callee) || ts.isCallExpression(callee)) {
			// A function that may be missing (`handlers.get(key)()`): undefined is not a function.
			const maybe = !isOptional(this.typeOf(callee)) ? this.maybeUndefined(callee) : null;
			return `${maybe ? `${RT.jsCallee}(${maybe})` : this.expr(callee)}(${this.args(e).join(', ')})`;
		}
		// `handler!(…)`: the function, where undefined is not a function.
		if (ts.isNonNullExpression(callee)) {
			if (!/[?!]$/.test(this.typeOf(callee.expression))) return this.call(ts.factory.updateCallExpression(e, callee.expression, e.typeArguments, e.arguments));
			const fn = this.expr(callee.expression);
			if (/^(?:try\s+)?FunctionCell_\w+\.present\(/.test(fn)) return `(${fn})(${this.args(e).join(', ')})`;
			const label = ts.isPropertyAccessExpression(callee.expression) || ts.isIdentifier(callee.expression) ? callee.expression.getText() : null;
			const fnType = this.typeOf(callee.expression).replace(/^\((.*)\)[?!]$/, '$1').replace(/[?!]$/, '');
			return label ? `({ () throws -> ${fnType} in guard let __fn = ${this.tryPrefix(callee.expression)}${fn} else { throw JSException(JSTypeError(${swiftString(`${label} is not a function`)})) }; return __fn }())(${this.args(e).join(', ')})` : `${RT.jsCallee}(${fn})(${this.args(e).join(', ')})`;
		}
		throw this.error(e, 'call');
	},

	/** An Error (or a subclass the program declares without its own toString), which Swift holds as a JSError. */
	isErrorObject(this: Translator, e: ts.Expression): boolean {
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
		const own = t.getProperty('toString')?.valueDeclaration;
		if (own && !isLibDeclaration(own)) return false;
		const message = t.getProperty('message')?.valueDeclaration;
		if (!message || !isLibDeclaration(message) || !ts.isInterfaceDeclaration(message.parent) || message.parent.name.text !== 'Error') return false;
		const swift = this.typeOf(e).replace(/[?!]$/, '');
		return /^JS\w*Error$/.test(swift) || !!this.classNamed(swift);
	},
};
