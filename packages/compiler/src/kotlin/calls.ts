// Arguments and calls as Kotlin: functions, methods, JavaScript globals and statics.
import ts from 'typescript';
import { TYPED_ARRAYS, isLibGlobal } from '../semantics/globals.ts';
import { cast, functionTypeParts, ident, isFunctionType, kotlinString, optionalType, splitTopLevel, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { assertedReceiverCell, nullishField } from '../semantics/placement.ts';
import { intlConstructor, isObjectToStringCall, literalKey, mergedInterfaceMemberOf, isSelf } from '../semantics/lang.ts';
import { callableSignal } from '../semantics/signals.ts';
import { isLibDeclaration, isSymbolIterator, implementationOf } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { programBase } from '../semantics/classes.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { globalOp, type NamedGlobal } from '../semantics/apis/globals.ts';

export const callsMethods = {
	arity(this: Translator, e: ts.CallExpression): number | undefined {
		const sig = this.checker.getResolvedSignature(e);
		const decl = sig?.getDeclaration();
		if (!decl || ts.isJSDocSignature(decl)) return undefined;
		if (decl.parameters.some((p) => p.dotDotDotToken)) return undefined;
		// Library mode: a method core's declarations describe with more parameters than its compiled class takes (`accessibilityScreenChanged(refocus)`).
		if (this.library && decl.getSourceFile().isDeclarationFile && ts.isMethodDeclaration(decl) && ts.isClassDeclaration(decl.parent) && decl.parent.name) {
			const compiled = this.compiledClasses().get(decl.parent.name.text);
			const name = decl.name.getText();
			const own = compiled?.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.body && m.name.getText() === name) ?? (compiled && this.inheritedMethod(compiled, name));
			if (own && !own.parameters.some((p) => p.dotDotDotToken) && !this.readsArguments(own)) return Math.min(decl.parameters.length, own.parameters.length);
		}
		return decl.parameters.length;
	},

	call(this: Translator, e: ts.CallExpression): string {
		const mark = this.checkedReceivers.length;
		try {
			return this.callExpr(e);
		} finally {
			while (this.checkedReceivers.length > mark) {
				const r = this.checkedReceivers.pop()!;
				this.subst.delete(r);
				this.checkedSubst.delete(r);
			}
		}
	},

	callExpr(this: Translator, e: ts.CallExpression): string {
		const callee = e.expression;
		if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken && !e.questionDotToken) {
			const continued = this.continuedChain(e, callee.expression, () => this.callExpr(e));
			if (continued) return continued;
		}
		this.refuseCallReceiver(e);
		const onPrototype = this.prototypeMethodCall(e);
		if (onPrototype) return onPrototype;
		if (ts.isPropertyAccessExpression(callee) && callee.expression.kind !== ts.SyntaxKind.SuperKeyword && !this.ownCalls.has(e) && this.isInstanceKey(callee.name)) return this.ownValueCall(e, callee);
		// A static method of a class whose instances are the kit's collection: its object's.
		const aliasClass = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? this.resolve(callee.expression)?.valueDeclaration : undefined;
		if (!this.library && aliasClass && ts.isClassDeclaration(aliasClass) && this.collectionAlias(aliasClass)) return `${this.className(aliasClass)}.${ident((callee as ts.PropertyAccessExpression).name.text)}(${this.args(e).join(', ')})`;
		// `require` of the global object (`__non_webpack_require__('system_lib://libx.so')`): the runtime's.
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require' && ts.isIdentifier(callee.expression) && ['global', 'globalThis'].includes(callee.expression.text) && e.arguments.length === 1) return `${RT.jsRequire}(${this.coerce(e.arguments[0], 'Any?')})`;
		// A generic lambda (`const find = <T extends View>(name) => …`), its type parameters erased to their constraints: its result as this call types it.
		const lambda = ts.isIdentifier(callee) ? this.resolve(callee)?.valueDeclaration : undefined;
		const init = lambda && ts.isVariableDeclaration(lambda) ? lambda.initializer : undefined;
		if (!this.library && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.typeParameters?.length && !this.erasedCall.has(e)) {
			this.erasedCall.add(e);
			try {
				const t = this.typeOf(e);
				const code = this.call(e);
				return t === 'Unit' || isUntyped(spelledType(t)) ? code : cast(code, t);
			} finally {
				this.erasedCall.delete(e);
			}
		}
		// A method of an app's generic interface, whose Kotlin interface erases its type parameters: its result as this call types it.
		const member = !this.library && ts.isPropertyAccessExpression(callee) && !this.erasedCall.has(e) ? this.checker.getResolvedSignature(e)?.getDeclaration() : undefined;
		if (member && !ts.isJSDocSignature(member) && ts.isMethodSignature(member) && this.erasingInterface(member)) {
			this.erasedCall.add(e);
			try {
				const t = this.typeOf(e),
					declared = this.returnTypeOf(member);
				const code = this.call(e);
				return t === 'Unit' || t === declared || !isUntyped(spelledType(declared)) ? code : cast(code, t);
			} finally {
				this.erasedCall.delete(e);
			}
		}
		if (!e.arguments.length && callableSignal(this.framework.signalKind(this.symbolName(callee)))) {
			if (ts.isPropertyAccessExpression(callee) && isSelf(callee.expression, this.subst) && this.props.has(callee.name.text)) return `this.${ident(callee.name.text)}.value`;
			return this.framework.signalKind(this.symbolName(callee)) === 'computed' && this.isComputedProperty(callee) ? this.expr(callee) : `${this.expr(callee)}.value`;
		}
		if (callee.kind === ts.SyntaxKind.SuperKeyword) throw this.error(e, 'super() outside the start of a constructor');
		// `getWindow<UIWindow>?.()`: the type arguments are only TypeScript's, and a function declaration is always there.
		const declaredFunction = (x: ts.Expression) => ts.isIdentifier(x) && !!this.resolve(x)?.declarations?.some(ts.isFunctionDeclaration);
		if (ts.isExpressionWithTypeArguments(callee) && (!e.questionDotToken || declaredFunction(callee.expression))) return this.call(ts.factory.updateCallExpression(e, callee.expression, callee.typeArguments, e.arguments));
		if (e.questionDotToken && this.isAny(callee)) return `${RT.jsCallOptional}(${this.expr(callee)}${this.untypedArgs(e)})`;
		// `obj.method?.()`: a method the program declares is always there.
		const declaredMethod = ts.isPropertyAccessExpression(callee) && !!this.resolve(callee.name)?.declarations?.some((d) => ts.isMethodDeclaration(d) && !!d.body);
		// `iterator.next?.()`: a method the library declares on a typed value is always there too.
		const libMethod = !this.library && ts.isPropertyAccessExpression(callee) && !this.isAny(callee.expression) && !!this.resolve(callee.name)?.declarations?.length && this.resolve(callee.name)!.declarations!.every((d) => isLibDeclaration(d) && (ts.isMethodSignature(d) || ts.isMethodDeclaration(d)));
		if (e.questionDotToken && !declaredMethod && !libMethod && !this.core?.isKitMethod(callee) && !declaredFunction(callee) && !(ts.isPropertyAccessExpression(callee) && mergedInterfaceMemberOf(callee, this.checker))) {
			const fn = this.expr(callee);
			// A Java method read untyped (`window.getInsetsController?.()`): called as script calls it.
			if (/^js(Java)?Get(Optional)?\(/.test(fn)) return this.fromAnyCode(`${RT.jsCallOptional}(${fn}${this.untypedArgs(e)})`, this.typeOf(e), true);
			return `${fn}?.invoke(${this.args(e).join(', ')})`;
		}
		// A function taking an implicit `this`, called plainly: undefined is its `this`.
		const implicitCallee = ts.isIdentifier(callee) ? this.resolve(callee)?.declarations?.find((d) => this.implicitThis(d)) : undefined;
		if (implicitCallee) return `${this.refName(callee as ts.Identifier)}(${['null', ...this.args(e)].join(', ')})`;
		// Called as a namespace's member: the namespace is its `this`.
		const namespace = ts.isPropertyAccessExpression(callee) ? this.resolve(ts.isPropertyAccessExpression(callee.expression) ? callee.expression.name : callee.expression)?.valueDeclaration : undefined;
		if (ts.isPropertyAccessExpression(callee) && namespace && ts.isModuleDeclaration(namespace) && !namespace.getSourceFile().isDeclarationFile && this.resolve(callee.name)?.declarations?.some((d) => this.implicitThis(d))) {
			return `${this.expr(callee)}(${[this.expr(callee.expression), ...this.args(e)].join(', ')})`;
		}
		// The module registry, where modules only `await import(…)` reaches run when imported: each module's exports read when
		// they are first loaded, the module run first.
		if (this.moduleKey && ts.isIdentifier(callee) && callee.text === '__nsRegisterAppModules' && e.arguments[0] && ts.isObjectLiteralExpression(e.arguments[0])) {
			const entries = e.arguments[0].properties.filter(ts.isPropertyAssignment).map((p) => {
				const first = ts.isObjectLiteralExpression(p.initializer) ? p.initializer.properties.find(ts.isPropertyAssignment) : undefined;
				const ref = first && (ts.isIdentifier(first.initializer) ? first.initializer : ts.isCallExpression(first.initializer) && ts.isArrowFunction(first.initializer.arguments[0]) && ts.isNewExpression(first.initializer.arguments[0].body) ? first.initializer.arguments[0].body.expression : undefined);
				const sym = ref && ts.isIdentifier(ref) ? this.checker.getSymbolAtLocation(ref) : undefined;
				const file = (sym && sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym)?.declarations?.[0]?.getSourceFile().fileName;
				const run = file ? `AppModules.runImport(${kotlinString(this.moduleKey!(file))}); ` : '';
				return `AppModules.register(${kotlinString(literalKey(p.name, this.checker) ?? p.name.getText())}) { ${run}${ts.isObjectLiteralExpression(p.initializer) ? this.dynamicObject(p.initializer) : this.stored(p.initializer, p, 'Any?')} }`;
			});
			return `run { ${entries.join('; ')} }`;
		}
		if (ts.isIdentifier(callee)) return this.core?.call(e) ?? this.globalCall(callee, e);
		const nsMember = ts.isPropertyAccessExpression(callee) ? this.namespaceMember(callee) : null;
		if (nsMember) {
			if (this.isAny(callee)) {
				const code = `${RT.jsCall}(${this.narrowed(callee, nsMember)}${this.untypedArgs(e)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
			}
			const declared = this.checker.getResolvedSignature(e)?.getDeclaration();
			const isFunctionValue = !declared || ts.isJSDocSignature(declared) || !('body' in declared && declared.body) || ts.isArrowFunction(declared) || ts.isFunctionExpression(declared);
			const call = `${this.narrowed(callee, nsMember)}(${this.args(e, isFunctionValue ? undefined : this.arity(e)).join(', ')})`;
			return this.library ? this.fromPluginCall(e, call) : call;
		}
		const intl = intlConstructor(callee, this.checker);
		if (intl) return `JS${intl}(${e.arguments.map((a) => this.restArgument(e, a, 'Any?')).join(', ')})`;
		this.refuseIntlMember(callee);
		if (isObjectToStringCall(callee, this.checker)) return `${RT.jsObjectToString}(${e.arguments[0] ? this.coerce(e.arguments[0], 'Any?') : 'null'})`;
		if (ts.isPropertyAccessExpression(callee) && isSelf(callee.expression, this.subst) && this.props.has(callee.name.text)) {
			const fn = `this.${ident(callee.name.text)}.value`;
			return `${/^\(.*\)\?$/.test(this.declaredTypeOf(callee) ?? '') ? this.callable(fn, callee) : fn}(${this.args(e, this.arity(e)).join(', ')})`;
		}
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'then' && ts.isCallExpression(callee.expression) && ts.isIdentifier(callee.expression.expression) && callee.expression.expression.text === '$showModal') {
			return this.showModal(callee.expression, e.arguments[0]);
		}
		if (ts.isPropertyAccessExpression(callee)) {
			const method = callee.name.text;
			const target = callee.expression;
			// `await import('./x')`, which the build reads as `Promise.resolve({ a: __import0_a })`: the module runs first, if it has not.
			const imported = this.moduleKey && method === 'resolve' && ts.isIdentifier(target) && target.text === 'Promise' && isLibGlobal(this, target) ? this.dynamicImport(e.arguments[0]) : null;
			if (imported) return `run { AppModules.runImport(${kotlinString(this.moduleKey!(imported))}); ${this.staticCall('Promise', method, e)} }`;
			// `(super[prop.setNative] as any).call(this, value)`: the base class's method under the key, called on this object.
			let inner: ts.Expression = target;
			while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
			if (!this.library && method === 'call' && ts.isElementAccessExpression(inner) && inner.expression.kind === ts.SyntaxKind.SuperKeyword && e.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword) {
				const code = `${RT.jsCall}(super.jsGet(${this.propertyKey(inner.argumentExpression)})${this.untypedArgs(e, 1)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
			}
			const owner = this.symbolName(target);
			const kind = this.framework.signalKind(owner);
			const signalValue = () => this.typeOf(target).replace(/^Signal<(.*)>$/, '$1');
			if ((kind === 'store' || kind === 'writable') && method === 'set') return `${this.expr(target)}.value = ${this.signalWrite(target, e.arguments[0], signalValue(), true, e)}`;
			// A prop (`this.x`) reads as its value: the signal itself is the field.
			if (kind === 'input' && method === '$assign') return `${ts.isPropertyAccessExpression(target) && isSelf(target.expression, this.subst) && this.props.has(target.name.text) ? `this.${ident(target.name.text)}` : this.expr(target)}.value = ${this.signalWrite(target, e.arguments[0], signalValue(), true, e)}`;
			if ((kind === 'store' || kind === 'writable') && method === 'update') return `${this.expr(target)}.update(${this.closure(e.arguments[0] as ts.ArrowFunction, `(${signalValue()}) -> ${signalValue()}`)})`;
			if (kind === 'writable' && method === '$write') {
				const a = e.arguments[0];
				if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return `${this.expr(target)}.update(${this.closure(a)})`;
				return `${this.expr(target)}.value = ${this.coerce(a, signalValue())}`;
			}
			const hooked = this.framework.hooks.methodCall?.(this, owner, method, e);
			if (hooked !== undefined) return hooked;
			if ((kind === 'writable' || kind === 'computed') && method === 'asReadonly') return this.expr(target);
			// `String.fromCharCode.apply(_, codes)`, `Math.max.apply(_, xs)`: the library function of the list's elements.
			if (method === 'apply' && e.arguments.length === 2 && this.pure(e.arguments[0]) && ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && isLibGlobal(this, target.expression)) {
				const listed = ({ 'String.fromCharCode': RT.jsFromCharCodeList, 'Math.max': RT.jsMathMaxList, 'Math.min': RT.jsMathMinList } as Record<string, string>)[`${target.expression.text}.${target.name.text}`];
				if (listed) return `${listed}(${this.coerce(e.arguments[1], 'Any?')})`;
			}
			if (ts.isIdentifier(target) && isLibGlobal(this, target)) return this.staticCall(target.text, method, e);
			// `object.hasOwnProperty(key)`, Object.prototype's.
			if (method === 'hasOwnProperty' && e.arguments.length === 1 && this.resolve(callee.name)?.declarations?.every((d) => isLibDeclaration(d))) return `${RT.jsHasOwn}(${this.coerce(target, 'Any?')}, ${this.propertyKey(e.arguments[0])})`;
			// Core's `timer` module imported whole (`timer.setTimeout(…)`): the runtime's timers.
			const timers = ts.isIdentifier(target) ? this.resolve(target)?.declarations?.[0] : undefined;
			if (timers && ts.isSourceFile(timers) && /[\\/]timer[\\/]index(\.d)?(\.android)?\.ts$/.test(timers.fileName) && ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].includes(method)) {
				const Name = RT[globalOp(method as NamedGlobal)];
				const a = e.arguments;
				return method.startsWith('set') ? `${Name}(${this.callback(a[0])}, ${a[1] ? this.toNumber(a[1]) : '0.0'})` : `${Name}(${a[0] ? this.coerce(a[0], 'Double?') : 'null'})`;
			}
			// Library mode: `super.m(…)` of a Java class script reaches untyped (through a local alias of the class): Kotlin's super call.
			if (this.library && target.kind === ts.SyntaxKind.SuperKeyword && this.isAny(target)) return this.native?.call(e) ?? `super.${ident(method)}(${e.arguments.map((a) => this.expr(a)).join(', ')})`;
			// A member the receiver's type does not have (a plugin's code for the other platform, typed against this one's stub): called by name.
			if (!this.library && this.inPluginFile(e) && !this.checker.getSymbolAtLocation(callee.name) && !this.isAny(target)) {
				const recv = ts.isIdentifier(target) && (this.resolve(target)?.flags ?? 0) & ts.SymbolFlags.Class ? `${this.expr(target)}::class.java` : this.coerce(target, 'Any?');
				const code = `${RT.jsCallMethod}(${recv}, ${kotlinString(method)}${this.untypedArgs(e)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
			}
			if (mergedInterfaceMemberOf(callee, this.checker)) {
				const o = this.fresh('__o'),
					key = kotlinString(method);
				const call = `${RT.jsCallMethod}(${o}, ${key}${this.untypedArgs(e)})`;
				const present = [...(callee.questionDotToken ? [`${RT.jsIsNullish}(${o})`] : []), ...(e.questionDotToken ? [`${RT.jsIsNullish}(${RT.jsGet}(${o}, ${key}))`] : [])].join(' || ');
				const code = `run { val ${o}: Any? = ${this.coerce(target, 'Any?')}; ${present ? `if (${present}) null else ` : ''}${call} }`;
				const rt = present ? optionalType(this.typeOf(e)) : this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
			}
			const bound = this.library && (method === 'call' || method === 'bind') ? this.boundCall(method, target, e) : null;
			if (bound) return bound;
			// `fn.apply(thisArg, args)`, `fn.call(thisArg, …)` of a function value: as script calls it.
			if ((method === 'apply' || method === 'call' || (method === 'bind' && !this.library)) && isFunctionType(this.typeOf(target).replace(/^\((.*)\)\?$/, '$1')) && this.resolve(callee.name)?.declarations?.every((d) => isLibDeclaration(d))) {
				const code = `${RT.jsCallMethod}(${this.coerce(target, 'Any?')}, ${kotlinString(method)}${this.untypedArgs(e)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
			}
			const untypedJavaField = this.library && ts.isPropertyAccessExpression(target) && this.untypedJavaFields().has(this.checker.getSymbolAtLocation(target.name)?.valueDeclaration as ts.Node);
			const core = untypedJavaField ? null : (this.core?.call(e) ?? this.native?.call(e));
			if (core) return core;
			let bare: ts.Expression = target;
			while (ts.isParenthesizedExpression(bare) || ts.isAsExpression(bare) || ts.isTypeAssertionExpression(bare)) bare = bare.expression;
			if (method === 'create' && e.arguments.length === 2 && ts.isIdentifier(bare) && bare.text === 'Array' && isLibGlobal(this, bare)) return `${RT.jsArrayCreate}(${this.coerce(e.arguments[0], 'Any?')}, ${this.toNumber(e.arguments[1])})`;
			if (method === 'from' && e.arguments.length === 1 && ts.isIdentifier(bare) && bare.text === 'ArrayBuffer' && bare !== target) return `JSArrayBuffer.from((${this.coerce(e.arguments[0], 'Any?')} as java.nio.ByteBuffer))`;
			// `this.m(…)` in a static method, of a static method the class declares: the companion's.
			const staticOwn = target.kind === ts.SyntaxKind.ThisKeyword && !!this.resolve(callee.name)?.declarations?.some((d) => ts.isMethodDeclaration(d) && !!d.body && isStatic(d));
			// `(<any>Object).entries(x)`: the library's own function, whatever the assertion says.
			if (!this.library && inner !== target && ts.isIdentifier(inner) && isLibGlobal(this, inner)) return this.staticCall(inner.text, method, e);
			if ((this.isAny(target) && !staticOwn) || (!this.library && this.isGlobalObject(target))) {
				const code = `${callee.questionDotToken ? RT.jsCallMethodIfPresent : RT.jsCallMethod}(${this.isGlobalObject(target) ? 'jsGlobalThis' : this.expr(target)}, ${kotlinString(method)}${this.untypedArgs(e)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : callee.questionDotToken ? (this.library ? this.fromAnyCode(code, optionalType(rt), true) : code) : this.untypedResult(e, code, rt);
			}
			// An untyped field holding a function (`private _resolve;`, `_loader: Function`), called as script calls it.
			const untypedField = this.library || this.holdsFunctionObject(callee) || this.isAny(callee) ? this.checker.getSymbolAtLocation(callee.name)?.valueDeclaration : undefined;
			// A namespace's const among them, reached through an alias of the namespace.
			const namespaceConst = !!untypedField && ts.isVariableDeclaration(untypedField) && ts.isModuleBlock(untypedField.parent.parent.parent);
			if (untypedField && (ts.isPropertyDeclaration(untypedField) || ts.isPropertySignature(untypedField) || namespaceConst) && this.isAny(callee)) {
				const code = `${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
			}
			const t = this.typeOf(target).replace(/\?$/, '');
			// Within a chain Kotlin's value is nullable after any `?.`, whatever TypeScript types the link; `?.` on a value present is legal.
			let q = callee.questionDotToken || (callee.flags & ts.NodeFlags.OptionalChain && (this.typeOf(target).endsWith('?') || !this.library)) ? '?' : this.typeOf(target).endsWith('?') ? '!!' : '';
			// A call of a function an untrusted value may be returned from, too: its member read is JavaScript's TypeError where it gives undefined.
			const looseCall = ts.isCallExpression(target) && !this.library && this.unwrapsResult(target);
			const assertedArray = isKit(spelledType(t), 'JSArray') && q !== '?' && !this.subst.has(target) ? assertedReceiverCell(this.receivers, target, method) : null;
			const missing = (t === 'String' || t === 'Double' || t === 'Boolean') && q !== '?' && !this.subst.has(target) ? this.receiver(target, method) : assertedArray?.cell === 'present' ? this.receiverCode(assertedArray, method) : null;
			if (missing) {
				this.subst.set(target, missing);
				this.checkedReceivers.push(target);
				this.checkedSubst.add(target);
				q = '';
			}
			if (!this.subst.has(target) && !t.startsWith('JSMatch') && (q === '!!' || (q === '' && (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) || ts.isNonNullExpression(target) || looseCall)))) {
				const code = this.expr(target);
				const checked = q === '!!' || this.isAsserted(code);
				this.subst.set(target, checked ? this.present(code, method, target) : code);
				this.checkedReceivers.push(target);
				if (checked) this.checkedSubst.add(target);
				q = '';
			}
			if (method === 'fill' && (ts.isNewExpression(target) || ts.isCallExpression(target)) && ts.isIdentifier(target.expression) && target.expression.text === 'Array' && target.arguments?.length === 1 && e.arguments.length === 1) {
				return `${RT.jsArrayFilled}<${t.replace(/^JSArray<(.*)>$/, '$1')}>(${this.toNumber(target.arguments[0])}, ${this.coerce(e.arguments[0], t.replace(/^JSArray<(.*)>$/, '$1'))})`;
			}
			if (method === 'join' && TYPED_ARRAYS.includes(t.replace(/^JS/, '')) && !q && e.arguments.length === 1 && !ts.isSpreadElement(e.arguments[0])) return `${this.expr(target)}.join(${this.joinSeparator(e.arguments[0])})`;
			const typedThisArg = TYPED_ARRAYS.includes(t.replace(/^JS/, '')) ? this.typedArrayThisArgCall(e) : null;
			if (typedThisArg) return this.ignoringThisArg(e, target, () => this.call(typedThisArg));
			if (isKit(spelledType(t), 'JSArray')) return this.arrayMethod(method, target, e, q);
			if (t === 'JSMatch' && method !== 'toString') {
				const chain = q === '?' || (q === '' && this.typeOf(target).endsWith('?'));
				this.subst.set(target, `${q === '!!' ? this.present(this.expr(target), method, target) : `${this.expr(target)}${chain ? '?' : ''}`}.values`);
				try {
					return this.arrayMethod(method, target, e, chain ? '?' : '');
				} finally {
					this.subst.delete(target);
				}
			}
			if (t.startsWith('Pair<') || t.startsWith('Triple<')) {
				const el = splitTopLevel(t.replace(/^(Pair|Triple)<(.*)>$/, '$2'));
				const element = el.every((x) => x === el[0]) ? el[0] : 'Any?';
				this.subst.set(target, `JSArray<${element}>(${cast(`${RT.jsTupleList}(${this.expr(target)})`, `List<${element}>`)})`);
				try {
					return this.arrayMethod(method, target, e, '');
				} finally {
					this.subst.delete(target);
				}
			}
			// Library mode: an untyped member asserted a string (`(ctor[KNOWN_FUNCTIONS] as string).indexOf(name)`, an array): called as script calls it.
			let asserted: ts.Expression = target;
			while (ts.isParenthesizedExpression(asserted)) asserted = asserted.expression;
			const operand = ts.isAsExpression(asserted) || ts.isTypeAssertionExpression(asserted) ? asserted.expression : undefined;
			if (this.library && t === 'String' && operand && ['indexOf', 'includes', 'slice', 'concat', 'lastIndexOf', 'at'].includes(method) && this.isAny(operand)) {
				const call = `${RT.jsCallMethod}(${this.expr(operand)}, ${kotlinString(method)}${e.arguments.map((a) => `, ${this.coerce(a, 'Any?')}`).join('')})`;
				return this.fromAnyCode(call, this.typeOf(e), true);
			}
			// `s?.trim()` of an optional string: nothing where it is missing.
			if (t === 'String' && q === '?' && this.typeOf(target).endsWith('?')) return `${this.expr(target)}?.let { __s -> ${this.stringMethod(method, target, e, '__s')} }`;
			if (t === 'String') return this.stringMethod(method, target, e);
			if (t === 'Double') return this.numberMethod(method, target, e);
			if (t === 'JSBigInt' && method === 'toLocaleString') return `${RT.jsBigIntToLocaleString}(${[this.expr(target), ...e.arguments.map((x) => this.restArgument(e, x, 'Any?'))].join(', ')})`;
			// A typed array's predicate, which the library types `unknown`: a Boolean, as the kit's overloads take it.
			const predicate = e.arguments[0];
			if (/^JS(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64)Array$/.test(t) && ['some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'filter'].includes(method) && e.arguments.length === 1 && predicate && (ts.isArrowFunction(predicate) || ts.isFunctionExpression(predicate))) {
				return `${this.expr(target)}${q}.${method}(${this.closure(predicate, `(Double, Double, ${t}) -> Boolean`)})`;
			}
			if (isKit(spelledType(t), 'JSPromise')) return this.promiseMethod(method, target, e);
			if (isKit(spelledType(t), 'JSMap') || isKit(spelledType(t), 'JSSet')) return this.collectionMethod(method, target, e, q);
			if (this.library && isKit(spelledType(t), 'JSWeakMap') && method === 'get' && e.arguments.length === 1) {
				const k = splitTopLevel(t.slice('JSWeakMap<'.length, -1))[0];
				const map = `${this.expr(target)}${q}`,
					key = this.coerce(e.arguments[0], k);
				const read = this.marks.marked(`${map}.get(${key})`, { op: 'entry', of: this.marks.valueOf(map), key: this.marks.valueOf(key) });
				const rt = this.typeOf(e);
				return rt.endsWith('?') ? read : this.undefinedAs(read, rt);
			}
			if (t === 'JSDate' && method === 'toISOString') return `${this.expr(target)}${q}.toISOString()`;
			if (/^JS(Iterator|Generator)</.test(t) && ['next', 'return', 'throw'].includes(method)) {
				return `${this.expr(target)}${q}.js${method[0].toUpperCase()}${method.slice(1)}Result(${e.arguments[0] ? this.coerce(e.arguments[0], 'Any?') : method === 'throw' ? 'null' : ''})`;
			}
			if (/^JS(AsyncIterator|AsyncGenerator)</.test(t) && ['next', 'return', 'throw'].includes(method)) {
				return `${this.expr(target)}${q}.${ident(method)}(${e.arguments[0] ? this.coerce(e.arguments[0], 'Any?') : method === 'throw' ? 'null' : ''})`;
			}
			// `this.method.bind(this)`: the method, bound to its object.
			if (method === 'bind' && e.arguments.length === 1 && e.arguments[0].kind === ts.SyntaxKind.ThisKeyword && ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
				return `${this.expr(target.expression)}::${ident(target.name.text)}`;
			}
			// A property holding an optional function, called (`this.onDone(x)` after a check TypeScript does not keep).
			const held = this.checker.getSymbolAtLocation(callee.name)?.valueDeclaration;
			// Library mode: a method an interface declares (`interface ItemSpec { toJSON() }`) that the class holds as an optional function field.
			const memberField = this.library && held && !(ts.isPropertyDeclaration(held) || ts.isPropertySignature(held)) ? this.fieldIn(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)), method) : undefined;
			const optionalFn = (!!held && (ts.isPropertyDeclaration(held) || ts.isPropertySignature(held) || (ts.isParameter(held) && ts.isParameterPropertyDeclaration(held, held.parent))) && /^\(.*\)\?$/.test(this.declaredTypeOf(callee) ?? '') && isFunctionType((this.declaredTypeOf(callee) ?? '').slice(1, -2))) || (!!memberField && (!!memberField.questionToken || !!(this.resolve(memberField.name) && this.nullableDecls.has(this.resolve(memberField.name)!))));
			const checked = !callee.questionDotToken ? this.receiver(target, method) : null;
			const args = this.args(e, this.arity(e));
			// A field holding a function (an overloaded method type, its first signature's): the arguments script leaves out are undefined.
			// So does an object type's method its class holds as a field (`waitUntilTestElementLayoutIsValid(timeoutSec?)`).
			const signatureField = !!held && ts.isMethodSignature(held) && this.isFunctionField(this.checker.getSymbolAtLocation(callee.name)!);
			const field = !!held && (ts.isPropertyDeclaration(held) || ts.isPropertySignature(held) || signatureField || (this.library && (ts.isPropertyAssignment(held) || ts.isShorthandPropertyAssignment(held)))) ? functionTypeParts((this.declaredTypeOf(callee) ?? this.typeOf(callee)).replace(/^\((.*)\)\?$/, '$1')) : null;
			for (let k = args.length; field && k < field.params.length; k++) args.push(field.params[k] === 'Unit' ? 'Unit' : 'null');
			// Kotlin's super calls take every argument: those script leaves out are the defaults the parameters declare.
			if (target.kind === ts.SyntaxKind.SuperKeyword) {
				const sd = this.checker.getResolvedSignature(e)?.getDeclaration();
				const impl = sd && !ts.isJSDocSignature(sd) ? (implementationOf(sd) ?? sd) : undefined;
				if (impl && ts.isMethodDeclaration(impl) && !impl.getSourceFile().isDeclarationFile && !this.readsArguments(impl)) {
					for (let k = args.length; k < impl.parameters.length && !impl.parameters[k].dotDotDotToken; k++) {
						const p = impl.parameters[k];
						args.push(this.constantDefault(p) ? this.stored(p.initializer!, p, this.typeOf(p.name)) : 'null');
					}
				}
			}
			if (nullishField(this, callee) && !callee.questionDotToken) return `${this.nullishCode(callee)}${e.questionDotToken ? '.optional?.invoke' : `.present(${kotlinString(method)})`}(${args.join(', ')})`;
			// Library mode: a call of a field holding a JSMethod (`itemSpec.toJSON()`), as script calls it: the object is its `this`.
			const methodField = this.library ? this.compiledField(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)), method) : undefined;
			// A field held untyped whose function declares the `this` it takes (a package's `this.work(state)`): called with the object as its `this`.
			const thisField =
				!this.library &&
				!q &&
				this.isAny(callee) &&
				this.checker
					.getNonNullableType(this.checker.getTypeAtLocation(callee))
					.getCallSignatures()
					.some((sig) => !!sig.thisParameter);
			if (thisField || (this.library && (this.isThisValue(callee) || (methodField && this.thisValues().symbols.has(methodField))))) {
				const code = `${RT.jsCallMethod}(${this.coerce(target, 'Any?')}, ${kotlinString(method)}${this.untypedArgs(e)})`;
				return this.typeOf(e) === 'Unit' || this.isAny(e) ? code : this.fromAnyCode(code, this.typeOf(e), true);
			}
			// `subtle.generateKey(…)` giving a key pair: the runtime's method of its own name, as Kotlin overloads by parameters alone.
			const named = method === 'generateKey' && isNamed(spelledType(this.typeOf(target)), 'JSSubtleCrypto', false) && this.typeOf(e) === 'JSPromise<JSCryptoKeyPair>' ? 'generateKeyPair' : method;
			const member = this.checker.getSymbolAtLocation(callee.name);
			const receiverCode = checked ?? (q === '!!' ? this.present(this.expr(target), method, target) : `${this.expr(target)}${q ? '?' : ''}`);
			const memberCode = `${receiverCode}.${member && this.isCompiledMethod(member) ? this.compiledMethodIdent(member, named) : ident(named)}`;
			let call = `${optionalFn ? `(${memberCode} ?: ${RT.jsNotAFunction}(${kotlinString(callee.getText().replace(/\s+/g, ''))}))` : memberCode}(${args.join(', ')})`;
			if (named === 'get' && args.length === 1 && !optionalFn) this.marks.marked(call, { op: 'entry', of: this.marks.valueOf(receiverCode), key: this.marks.valueOf(args[0]) });
			// Library mode: `ref.get()` read on, as if the object were there (script throws reading a member of undefined).
			if (/^JSWeakRef</.test(this.typeOf(target)) && ['get', 'deref'].includes(method) && !q && ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e && !e.parent.questionDotToken) call = this.present(call, e.parent.name.text);
			// An override taking its base's signature gives what the base's result type holds.
			const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
			if (decl && ts.isMethodDeclaration(decl) && decl.body && ts.isClassLike(decl.parent) && !q) {
				let root: ts.MethodDeclaration = decl;
				for (let b = this.inheritedMethod(root.parent as ts.ClassLikeDeclaration, method); b; b = this.inheritedMethod(b.parent as ts.ClassLikeDeclaration, method)) root = b;
				const emitted = this.returnTypeOf(root),
					own = this.typeOf(e);
				if (root !== decl && emitted !== 'Unit' && emitted !== this.returnTypeOf(decl)) return this.convert(this.fromPluginCall(e, call), emitted, own);
			}
			return this.fromPluginCall(e, call);
		}
		if (ts.isElementAccessExpression(callee) && isSymbolIterator(callee.argumentExpression, this.checker) && !e.arguments.length) return this.iteratorCode(callee.expression, true);
		if (ts.isElementAccessExpression(callee) && this.library && this.typeOf(callee.argumentExpression) === 'JSSymbol') {
			// `view[prop.setNative](value)`, `super[prop.setNative](value)`: the method under the symbol, found when the program runs.
			const key = this.propertyKey(callee.argumentExpression);
			if (callee.expression.kind === ts.SyntaxKind.SuperKeyword) {
				// The method is the one the key names (`super[whiteSpaceProperty.setNative]`): every such key has the type `symbol`,
				// so the signature TypeScript resolves may be another of them.
				const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
				const keyed = decl && !ts.isJSDocSignature(decl) && ts.isMethodDeclaration(decl) && !decl.getSourceFile().isDeclarationFile ? this.symbolMember(decl.name) : null;
				const named = keyed ? this.symbolMember(ts.factory.createComputedPropertyName(callee.argumentExpression)) : null;
				const own = keyed && named && named.member !== keyed.member ? named : keyed;
				return own ? `super.${own.member}(${this.args(e).join(', ')})` : `${RT.jsCall}(super.jsGet(${key})${this.untypedArgs(e)})`;
			}
			return `${RT.jsCallMethod}(${this.coerce(callee.expression, 'Any?')}, ${key}${this.untypedArgs(e)})`;
		}
		if (ts.isElementAccessExpression(callee)) {
			const property = this.setNativeOf(callee.argumentExpression);
			// One a subclass declares (a plugin's `PagerBase` calling its platform class's setter): by its symbol, as script calls it.
			const holder = this.checker.getNonNullableType(this.checker.getTypeAtLocation(callee.expression)).getSymbol()?.valueDeclaration;
			const declares = (c: ts.ClassLikeDeclaration | undefined): boolean => !!c && (c.members.some((m) => ts.isMethodDeclaration(m) && !!m.name && ts.isComputedPropertyName(m.name) && this.setNativeOf(m.name.expression) === property) || declares(programBase(c, this.checker) ?? undefined));
			if (property && !this.library && holder && ts.isClassDeclaration(holder) && !holder.getSourceFile().isDeclarationFile && !declares(holder)) {
				return `${RT.jsCallMethod}(${this.coerce(callee.expression, 'Any?')}, (${this.expr(callee.argumentExpression)} as JSSymbol).key${this.untypedArgs(e)})`;
			}
			if (property) return `${this.expr(callee.expression)}.__setNative_${property}(${e.arguments.map((a) => this.restArgument(e, a, 'Any?')).join(', ')})`;
			// `obj[key](…)`: a method call, the object its `this`.
			if (this.isAny(callee) && !this.library && !ts.isOptionalChain(e) && this.checker.getTypeAtLocation(callee.argumentExpression).flags & ts.TypeFlags.StringLike && callee.expression.kind !== ts.SyntaxKind.SuperKeyword) {
				return `${RT.jsCallMethod}(${this.coerce(callee.expression, 'Any?')}, ${this.str(callee.argumentExpression)}${this.untypedArgs(e)})`;
			}
			if (this.isAny(callee)) return `${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`;
		}
		let fn: ts.Expression = callee;
		while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
		// `(function () { … })()`: the function, called.
		if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) return `(${this.closure(fn)})(${this.args(e).join(', ')})`;
		// `(value as F)(…)`: the value read as the function type, called (the factory would parenthesize the cast again).
		if (ts.isParenthesizedExpression(callee) && (ts.isAsExpression(callee.expression) || ts.isTypeAssertionExpression(callee.expression) || ts.isSatisfiesExpression(callee.expression))) {
			// A value held untyped (`(<Template>this.itemTemplate)()`, a field of a union type): called as script calls it.
			const inner = callee.expression.expression;
			if (this.library && (this.isAny(inner) || isUntyped(spelledType(this.declaredTypeOf(inner))))) {
				const code = `${RT.jsCall}(${this.expr(inner)}${this.untypedArgs(e)})`;
				const rt = this.typeOf(e);
				return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
			}
			return `${this.expr(callee)}(${this.args(e).join(', ')})`;
		}
		// `(a || b)(…)`: the factory would parenthesize the operand again.
		if (ts.isParenthesizedExpression(callee) && (ts.isBinaryExpression(callee.expression) || ts.isConditionalExpression(callee.expression))) {
			const t = this.typeOf(callee);
			if (!isFunctionType(t.replace(/^\((.*)\)\?$/, '$1'))) return this.fromAnyCode(`${RT.jsCall}(${this.expr(callee.expression)}${this.untypedArgs(e)})`, this.typeOf(e), true);
			return `${this.callable(this.coerce(callee.expression, t.replace(/^\((.*)\)\?$/, '$1')), callee)}(${this.args(e).join(', ')})`;
		}
		if (ts.isParenthesizedExpression(callee)) return this.call(ts.factory.updateCallExpression(e, callee.expression, e.typeArguments, e.arguments));
		// A function read from a record may be missing: calling it then throws, as calling undefined does.
		if (ts.isElementAccessExpression(callee) && /^JSRecord</.test(this.typeOf(callee.expression))) return `(${this.expr(callee)} ?: ${RT.jsNotAFunction}(${kotlinString(callee.getText().replace(/\s+/g, ''))}))(${this.args(e).join(', ')})`;
		// A call's untyped result called (`closeModalGetter(args)(result)`, a `Function`): as script calls it.
		if (ts.isCallExpression(callee) && this.isAny(callee)) {
			const code = `${RT.jsCall}(${this.expr(callee)}${this.untypedArgs(e)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || rt === 'Unit' ? code : this.fromAnyCode(code, rt, true);
		}
		if (ts.isElementAccessExpression(callee) || ts.isCallExpression(callee)) return `${this.expr(callee)}(${this.args(e).join(', ')})`;
		// `handler!(…)`: the function, where undefined is not a function.
		if (ts.isNonNullExpression(callee) && /\?$/.test(this.typeOf(callee.expression))) return `(${this.expr(callee.expression)} ?: ${RT.jsNotAFunction}(${kotlinString(callee.expression.getText().replace(/\s+/g, ''))}))(${this.args(e).join(', ')})`;
		// `comparator!(a, b)` where the checker has already narrowed it: the call without the assertion.
		if (ts.isNonNullExpression(callee) && ts.isIdentifier(callee.expression)) return `${this.expr(callee.expression)}(${this.args(e).join(', ')})`;
		throw this.error(e, 'call');
	},
};
