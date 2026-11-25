// Reads, writes and calls of native classes, their members, functions and constants, as Swift.
import ts from 'typescript';
import { BRIDGED, RENAMED, base, inStaticMember, optional, withErrorOut } from './bridging.ts';
import { CF_CLASSES, functionParts, RT } from '../syntax.ts';
import type { NativeAPI } from './api.ts';
import { conformsTo, constantModule, lookupClass, lookupConstant, lookupConstructor, lookupEnum, lookupFunction, lookupInit, lookupMember, lookupStruct, type NativeClass, type NativeMethod, type SwiftType } from './sdk.ts';
import { isStatic } from '../../semantics/throws.ts';
import { rethrowUnlessRefused } from '../../semantics/refusals.ts';
import { appMember } from '../../semantics/ast.ts';
import { isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeCallsMethods = {
	/** `x.prop = value` on a native type. */
	assign(this: NativeAPI, left: ts.PropertyAccessExpression, value: ts.Expression): string | null {
		if (appMember(left.name, this.t.checker)) return null;
		if (ts.isIdentifier(left.expression) && this.t.untypedLetReceiver(left.expression)) return null;
		let r = this.receiver(left.expression);
		if (!r) return null;
		// `view instanceof UIControl` narrowing a UISearchBar: the member is the narrowed class's, the object cast to it.
		let cast: string | null = null;
		const it = this.t.checker.getNonNullableType(this.t.checker.getTypeAtLocation(left.expression));
		if (it.isIntersection() && !lookupMember(r.module, r.name, left.name.text, false)) {
			for (const u of it.types) {
				const n = this.symbolModule(u.getSymbol()) ?? this.nativeBase(u);
				const c = n && lookupClass(n.module, n.name);
				if (n && c && lookupMember(n.module, n.name, left.name.text, false)) {
					r = { ...n, isStatic: false };
					cast = this.className(c);
					break;
				}
			}
		}
		const struct = !r.isStatic && lookupStruct(r.module, r.name);
		if (struct) {
			const field = struct.fields[left.name.text];
			if (!field) throw this.t.error(left, `${r.name}.${left.name.text} (not a field of ${struct.swift})`, 'native');
			const recv = this.t.expr(left.expression);
			return this.t.marks.assignedCode(this.t.marks.leading(`${recv}.${left.name.text}`, recv), this.toSwift(value, field), this.t.receiverThrows(left.expression));
		}
		const m = this.found(lookupMember(r.module, r.name, left.name.text, r.isStatic));
		if (!m || m.kind !== 'property') throw this.t.error(left, `${r.name}.${left.name.text} (no settable Swift property)`, 'native');
		if (m.readonly) throw this.t.error(left, `${r.name}.${left.name.text} (read-only)`, 'native');
		this.checkAvailable(m, left, `${r.name}.${left.name.text}`);
		// An object Swift holds as optional (`this.delay.wetDryMix = …`, `delay: AVAudioUnitDelay | null`): JavaScript's TypeError where it is missing.
		const held = this.t.typeOf(left.expression);
		const unwrap = !r.isStatic && !cast && held.endsWith('?') && !isUntyped(spelledType(held)) && !left.questionDotToken ? '!' : '';
		const erased = !r.isStatic && !cast && isUntyped(spelledType(held)) ? this.erasedReceiver(left.expression, this.t.expr(left.expression)) : null;
		const recv = r.isStatic || cast || erased ? '' : this.t.expr(left.expression);
		const target = r.isStatic ? this.className(lookupClass(r.module, r.name)!) : cast ? this.t.marks.castCode(this.t.expr(left.expression), cast, 'as!') : (erased ?? this.t.marks.leading(`${recv}${unwrap}`, recv));
		if (m.optional && !r.isStatic && !cast && lookupClass(r.module, r.name)?.kind === 'protocol') {
			return `${RT.jsSetOptionalNativeProperty}(${target}, ${JSON.stringify(left.name.text)}, ${this.toSwift(value, m.type)})`;
		}
		return this.t.marks.assignedCode(this.t.marks.leading(`${target}.${m.swift}`, target), this.toSwift(value, m.type), !r.isStatic && this.t.receiverThrows(left.expression));
	},

	/** A call of a native method, class method, `alloc().initWith…()`, `new()`, or global function. */
	call(this: NativeAPI, e: ts.CallExpression): string | null {
		const callee = e.expression;
		if (ts.isIdentifier(callee)) {
			const native = this.symbolModule(this.t.resolve(callee));
			if (!native) return null;
			// Swift manages Core Foundation memory: retain and release calls go away.
			if (/^CF(Retain|Release|Autorelease)$|^CG\w+(Retain|Release)$/.test(native.name)) return e.arguments[0] ? this.t.expr(e.arguments[0]) : '()';
			// `UIApplicationMain(0, null, …)`: Swift's overlay reads the process's arguments, which the runtime passes for it.
			if (native.name === 'UIApplicationMain' && e.arguments.length === 4) return `UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, ${this.toSwift(e.arguments[2], 'String?')}, ${this.toSwift(e.arguments[3], 'String?')})`;
			if (native.name === 'dispatch_get_current_queue' && !e.arguments.length) return this.fromSwift(`${RT.jsDispatchCurrentQueue}()`, 'dispatch_queue_t', e);
			const f = lookupFunction(native.module, native.name);
			if (!f) throw this.t.error(e, `${native.name}() (${this.noCounterpart(native.module, native.name)})`, 'native');
			this.checkAvailable(f, e, `${native.name}()`);
			const args = [...e.arguments];
			if (f.kind === 'equal') return this.fromSwift(`(${this.toSwift(args[0], f.params[0])} == ${this.toSwift(args[1], f.params[1])})`, f.returns, e);
			const selfCode = (x: ts.Expression) => (f.owner ? this.toSwift(x, f.owner) : this.t.expr(x));
			if (f.kind === 'property') return this.fromSwift(`${selfCode(args[f.self!])}.${f.swift}`, f.returns, e);
			if (f.kind === 'staticProperty') return this.fromSwift(`${f.owner}.${f.swift}`, f.returns, e);
			const self = f.self !== undefined ? args.splice(f.self, 1)[0] : undefined;
			const list = this.argList(e, args, f.labels, f.params);
			const code = f.kind === 'init' ? `${f.owner}(${list})` : f.kind === 'method' ? `${selfCode(self!)}.${f.swift}(${list})` : f.kind === 'staticMethod' ? `${f.owner}.${f.swift}(${list})` : `${f.swift}(${list})`;
			return this.fromSwift(code, f.returns, e);
		}
		if (!ts.isPropertyAccessExpression(callee)) return null;
		const requirement = appMember(callee.name, this.t.checker) ? this.protocolRequirement(callee.name) : null;
		if (appMember(callee.name, this.t.checker) && callee.name.text !== 'new' && !this.nativeOverride(callee.name) && !requirement) return null;
		const name = callee.name.text;
		// `X.alloc().initWithFrame(r)`, `X.alloc().init()`
		if (ts.isCallExpression(callee.expression) && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === 'alloc') {
			const allocated = callee.expression.expression.expression;
			// An app class extending a native one inherits its initializers.
			const own = this.t.resolve(allocated)?.valueDeclaration;
			const ownBase = own && ts.isClassDeclaration(own) && own.name && !own.getSourceFile().isDeclarationFile ? this.nativeBase(this.t.checker.getDeclaredTypeOfSymbol(this.t.resolve(allocated)!)) : null;
			const r = ownBase ? { ...ownBase, isStatic: true } : this.receiver(allocated);
			if (!r) return null;
			const cls = lookupClass(r.module, r.name);
			if (!cls) throw this.t.error(e, `${r.name}.alloc().${name}() (${this.noCounterpart(r.module)})`, 'native');
			// A class held as a value (`typeof UIGestureRecognizer`): its own initializer, which Objective-C dispatches.
			const classRef = !!((this.t.resolve(allocated)?.flags ?? 0) & ts.SymbolFlags.Class);
			const made = ownBase ? this.t.topName(own!, (own as ts.ClassDeclaration).name!.text) : r.isStatic || classRef ? this.className(cls) : `${this.t.expr(allocated)}.init`;
			if (name === 'init') return `${made}()`;
			const init = this.found(lookupInit(r.module, r.name, name));
			if (!init) throw this.t.error(e, `${r.name}.alloc().${name}() (no Swift initializer)`, 'native');
			const args = [...e.arguments];
			if (init.errorParam !== undefined) args.splice(init.errorParam, 1);
			return this.errorCall(`${made}(${this.argList(e, args, init.labels, init.params)})`, init, e);
		}
		const own = this.t.resolve(callee.expression);
		const ownDecl = own?.valueDeclaration;
		if (ownDecl && ts.isClassDeclaration(ownDecl) && !ownDecl.getSourceFile().isDeclarationFile && name === 'new' && this.nativeBase(this.t.checker.getDeclaredTypeOfSymbol(own!))) return `${this.t.topName(ownDecl, ownDecl.name!.text)}()`;
		// `super.new()` or `this.new()` in a static member of the class: an instance of that class, as the runtime makes one.
		if (name === 'new' && !e.arguments.length && (callee.expression.kind === ts.SyntaxKind.SuperKeyword || callee.expression.kind === ts.SyntaxKind.ThisKeyword) && inStaticMember(callee.expression)) {
			const cls = ts.findAncestor(callee.expression, ts.isClassDeclaration);
			if (cls?.name && !cls.getSourceFile().isDeclarationFile && this.nativeBase(this.t.checker.getTypeAtLocation(cls))) return `${this.t.topName(cls, cls.name.text)}()`;
		}
		if (ts.isCallExpression(callee.expression) && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === 'alloc' && name === 'init') {
			const allocated = this.t.resolve(callee.expression.expression.expression)?.valueDeclaration;
			if (allocated && ts.isClassDeclaration(allocated) && !allocated.getSourceFile().isDeclarationFile) return `${this.t.topName(allocated, allocated.name!.text)}()`;
		}
		const either = this.eitherCall(e);
		if (either) return either;
		const r = this.receiver(callee.expression);
		if (!r) return null;
		// `Cls.class()`: the class itself, which Swift names `Cls.self`.
		if (r.isStatic && name === 'class' && !e.arguments.length) {
			const cls = this.t.expr(callee.expression);
			return cls.endsWith('.self') ? cls : `${cls}.self`;
		}
		const collection = !r.isStatic ? this.collectionMember(callee.expression, name, e.arguments, e) : null;
		if (collection) return collection;
		const cls = lookupClass(r.module, r.name);
		if (r.isStatic && name === 'new' && cls) return this.fromSwift(`${this.className(cls)}()`, this.className(cls), e);
		if (r.isStatic && name === 'alloc') throw this.t.error(e, `${r.name}.alloc() without an init`, 'native');
		if (!r.isStatic && name === 'objectForKeyedSubscript') return this.fromSwift(`${this.t.expr(callee.expression)}[${this.t.expr(e.arguments[0])}]`, 'Any?', e);
		if (!r.isStatic && name === 'setObjectForKeyedSubscript') return `${this.t.expr(callee.expression)}[${this.t.expr(e.arguments[1])}] = ${this.t.expr(e.arguments[0])}`;
		// A native enum's value is a number in JavaScript.
		const en = !r.isStatic && name === 'toString' && !e.arguments.length ? lookupEnum(r.module, r.name) : null;
		if (en) return `String(${this.unwrapped(callee.expression)}${en.swift ? '.rawValue' : ''})`;
		// The runtime's wrapper of a native object converts to its `description`.
		if (!r.isStatic && name === 'toString' && !e.arguments.length && cls?.kind === 'class') return this.fromSwift(`${this.unwrapped(callee.expression)}.description`, 'String', e);
		const m = this.found(lookupMember(r.module, r.name, name, r.isStatic)) ?? requirement ?? this.optionsSibling(r, name, e.arguments.length) ?? (r.isStatic ? this.factoryInit(r, name) : null);
		if (!m) {
			// `o.setX(v)` for a property `x` the d.ts also lists as a method.
			const setter = /^set([A-Z]\w*)$/.exec(name);
			const prop = setter && e.arguments.length === 1 ? this.found(lookupMember(r.module, r.name, setter[1][0].toLowerCase() + setter[1].slice(1), r.isStatic)) : null;
			if (prop && prop.kind === 'property') return `${r.isStatic ? this.className(lookupClass(r.module, r.name)!) : this.t.expr(callee.expression)}.${prop.swift} = ${this.toSwift(e.arguments[0], prop.type)}`;
			throw this.t.error(e, `${r.name}.${name}() (${this.noCounterpart(r.module)})`, 'native');
		}
		this.checkAvailable(m, e, `${r.name}.${name}()`);
		// An Objective-C method Swift imports as a property.
		const chained = ts.isPropertyAccessExpression(callee) && !!callee.questionDotToken;
		// Foundation's own methods (`enumerateKeysAndObjectsUsingBlock`) on what Swift imports as its collection.
		const st = this.t.typeOf(callee.expression);
		const bridged = !r.isStatic && !chained && ((r.name === 'NSDictionary' && /^\[.*:.*\][?!]?$/.test(st)) || (r.name === 'NSArray' && /^\[[^:]*\][?!]?$/.test(st)));
		const recv = r.isStatic ? '' : bridged ? `(${this.unwrapped(callee.expression)} as ${r.name})` : !chained ? this.unwrapped(callee.expression) : this.t.typeOf(callee.expression).endsWith('?') ? `${this.t.expr(callee.expression)}?` : this.chainHead(callee.expression).slice(0, -1);
		if (m.kind === 'property') return this.fromSwift(`${r.isStatic ? this.className(lookupClass(r.module, r.name)!) : recv}.${m.swift}`, m.type, e);
		const args = [...e.arguments];
		if (m.errorParam !== undefined) args.splice(m.errorParam, 1);
		const defaults = (m as NativeMethod & { defaults?: string[] }).defaults ?? [];
		const out = this.errorOut(m, args.length);
		const list = [this.argList(e, args, m.labels, m.params), ...defaults, ...(out ? [out] : [])].filter(Boolean).join(', ');
		const target = r.isStatic ? this.className(cls!) : recv;
		// An optional requirement called through its protocol: the method where the object has one, a TypeError where not.
		const optionalCall = m.kind === 'method' && (m as NativeMethod).optional && !r.isStatic && lookupClass(r.module, r.name)?.kind === 'protocol' ? '!' : '';
		const called = m.kind === 'init' ? `${target}(${list})` : `${target}.${m.swift}${optionalCall}(${list})`;
		const code = out ? withErrorOut(called, m.returns) : called;
		const result = this.errorCall(code, m, e);
		// A chain that stops before the call gives undefined, as a number, string or boolean reads it.
		const tsType = this.t.typeOf(e);
		return (chained || ts.isOptionalChain(e)) && !this.keepOptional.has(e) && ['Bool', 'Double', 'String'].includes(tsType) ? this.t.undefinedAs(result, tsType) : result;
	},

	/**
	 * `UIViewControllerTransitionCoordinator.prototype.animateAlongsideTransitionCompletion.call(coordinator, …)`:
	 * the native class's or protocol's method sent to the object, as the runtime sends it.
	 */
	prototypeCall(this: NativeAPI, e: ts.CallExpression): string | null {
		const found = this.prototypeMethod(e);
		if (!found) return null;
		const { native, cls, name, m } = found;
		const [object, ...args] = e.arguments;
		if (!object) throw this.t.error(e, `${native.name}.prototype.${name}.call without an object`, 'native');
		this.checkAvailable(m, e, `${native.name}.${name}()`);
		if (m.errorParam !== undefined && args.length > m.errorParam) throw this.t.error(args[m.errorParam], 'an NSError out-parameter', 'native');
		const out = this.errorOut(m, args.length);
		const list = [this.argList(e, args, m.labels, m.params), ...(out ? [out] : [])].filter(Boolean).join(', ');
		const receiver = this.t.marks.castCode(this.t.expr(object), cls.kind === 'protocol' ? `any ${this.className(cls)}` : this.className(cls), 'as!');
		const called = `${receiver}.${m.swift}(${list})`;
		const code = out ? withErrorOut(called, m.returns) : called;
		return this.fromSwift(code, m.returns, e);
	},

	prototypeMethod(this: NativeAPI, e: ts.CallExpression): { native: { module: string; name: string }; cls: NativeClass; name: string; m: NativeMethod } | null {
		const callee = e.expression;
		if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'call' || !ts.isPropertyAccessExpression(callee.expression)) return null;
		const method = callee.expression;
		if (!ts.isPropertyAccessExpression(method.expression) || method.expression.name.text !== 'prototype') return null;
		const native = this.symbolModule(this.t.resolve(method.expression.expression));
		const cls = native && lookupClass(native.module, native.name);
		if (!native || !cls) return null;
		const name = method.name.text;
		const m = this.found(lookupMember(native.module, native.name, name, false));
		if (!m || m.kind === 'property') throw this.t.error(e, `${native.name}.prototype.${name} (no Swift method)`, 'native');
		return { native, cls, name, m };
	},

	/**
	 * The classes of an intersection that stands for whichever of them an object is (`data: NSDictionary & NSData & NSArray`,
	 * as plugins type a value an API gives untyped): unrelated native classes, one of them a Swift collection, which no one
	 * Swift type holds but NSObject. Null for any other type (a class narrowed by `instanceof` to another it does not extend keeps its rules).
	 */
	either(this: NativeAPI, t: ts.Type): { module: string; name: string; cls: NativeClass }[] | null {
		const type = this.t.checker.getNonNullableType(t);
		if (!type.isIntersection()) return null;
		const found = type.types.map((u) => this.symbolModule(u.getSymbol())).map((n) => n && { ...n, cls: lookupClass(n.module, n.name)! });
		if (found.length < 2 || found.some((f) => !f || f.cls?.kind !== 'class')) return null;
		const classes = found as { module: string; name: string; cls: NativeClass }[];
		if (classes.some((a) => classes.some((b) => a !== b && conformsTo(a.module, a.name, b.name)))) return null;
		return type.types.some((u) => /^\[/.test(this.type(u) ?? '')) ? classes : null;
	},

	/** `data.writeToFileAtomically(path, true)` on an `either` value: the member of the class the object is, as the runtime finds it. */
	eitherCall(this: NativeAPI, e: ts.CallExpression): string | null {
		const callee = e.expression;
		if (!ts.isPropertyAccessExpression(callee)) return null;
		const classes = this.either(this.t.checker.getTypeAtLocation(callee.expression));
		if (!classes) return null;
		const name = callee.name.text;
		const ret = this.t.typeOf(e);
		const cases = classes.flatMap((c) => {
			const m = this.found(lookupMember(c.module, c.name, name, false));
			if (!m || m.kind === 'property') return [];
			const args = [...e.arguments];
			if (m.errorParam !== undefined) {
				if (args.length > m.errorParam) throw this.t.error(args[m.errorParam], 'an NSError out-parameter', 'native');
			}
			const out = this.errorOut(m, args.length);
			const list = [this.argList(e, args, m.labels, m.params), ...(out ? [out] : [])].filter(Boolean).join(', ');
			const called = `__o.${m.swift}(${list})`;
			const code = out ? withErrorOut(called, m.returns) : called;
			const value = this.fromSwift(code, m.returns, e);
			return [`if let __o = __either as? ${this.className(c.cls)} { ${ret === 'Void' ? `${value}; return` : `return ${value}`} }`];
		});
		if (!cases.length) throw this.t.error(e, `${classes.map((c) => c.name).join(' & ')}.${name}() (no Swift method of these classes)`, 'native');
		const recv = this.t.expr(callee.expression);
		return `({ () throws -> ${ret} in let __either: AnyObject? = ${recv}; ${cases.join(' ')}; throw JSException(JSTypeError(${JSON.stringify(`${name} is not a function`)})) }())`;
	},

	/** `data.length` on an `either` value: the property of the class the object is. */
	eitherRead(this: NativeAPI, e: ts.PropertyAccessExpression): string | null {
		if (ts.isCallExpression(e.parent) && e.parent.expression === e) return null;
		const classes = this.either(this.t.checker.getTypeAtLocation(e.expression));
		if (!classes) return null;
		const name = e.name.text;
		const ret = this.t.typeOf(e);
		const cases = classes.flatMap((c) => {
			const m = this.found(lookupMember(c.module, c.name, name, false));
			if (!m) return [];
			const read = m.kind === 'property' ? `__o.${m.swift}` : m.kind === 'method' && !m.params.length ? `__o.${m.swift}()` : null;
			return read ? [`if let __o = __either as? ${this.className(c.cls)} { return ${this.fromSwift(read, m.kind === 'property' ? m.type : m.returns, e)} }`] : [];
		});
		if (!cases.length) return null;
		const none = optional(ret) ? 'return nil' : `throw JSException(JSTypeError(${JSON.stringify(`no ${name} on this object`)}))`;
		return `({ () throws -> ${ret} in let __either: AnyObject? = ${this.t.expr(e.expression)}; ${cases.join(' ')}; ${none} }())`;
	},

	/** `NSNumber.numberWithLong(n)`, a factory Swift imports only as its initializer (`initWithLong:`, `NSNumber(value:)`). */
	factoryInit(this: NativeAPI, r: { module: string; name: string }, name: string): NativeMethod | null {
		const factory = /^[a-z]+(With[A-Z]\w*)$/.exec(name);
		const init = factory && this.found(lookupInit(r.module, r.name, `init${factory[1]}`));
		return init && init.kind === 'init' ? init : null;
	},

	/**
	 * `session.setActiveError(true)` where Swift has no `setActive:error:` of its own: its overlay folds it into
	 * `setActive(_:options:)`, whose options default to none. The sibling taking the same leading arguments
	 * and only option sets beyond them, those passed empty, as Swift's default does.
	 */
	optionsSibling(this: NativeAPI, r: { module: string; name: string; isStatic: boolean }, name: string, given: number): (NativeMethod & { defaults: string[] }) | null {
		if (!name.endsWith('Error')) return null;
		const stem = name.slice(0, -'Error'.length);
		const cls = lookupClass(r.module, r.name);
		const members = cls ? (r.isStatic ? cls.static : cls.instance) : {};
		const candidates = Object.entries(members).filter(([k, v]) => k !== name && k.startsWith(`${stem}With`) && k.endsWith('Error') && v.kind === 'method' && v.throws && v.params.length > given && v.params.slice(given).every((p) => this.isOptionSet(base(p)))) as [string, NativeMethod][];
		const best = candidates.sort((a, b) => a[1].params.length - b[1].params.length)[0]?.[1];
		if (!best) return null;
		// The option sets beyond the given arguments are empty, as the overlay's defaults are; the error stays last.
		return { ...best, params: best.params.slice(0, given), labels: best.labels.slice(0, given), defaults: best.params.slice(given).map((_, k) => `${best.labels[given + k] ?? '_'}: []`), errorParam: given } as NativeMethod & { defaults: string[] };
	},

	/**
	 * A method Swift imports as `throws` (an Objective-C NSError out-parameter). Left out, the
	 * error argument makes the iOS runtime throw the error; passed as null, the call returns
	 * false or null instead.
	 */
	errorCall(this: NativeAPI, code: string, m: NativeMethod, e: ts.CallExpression): string {
		if (!m.throws) return this.fromSwift(code, m.returns, e);
		const at = m.errorParam!;
		if (e.arguments.length > at) {
			const arg = e.arguments[at];
			if (arg.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(arg) && arg.text === 'undefined')) throw this.t.error(arg, 'an NSError out-parameter', 'native');
			return m.returns === 'Void' ? `((try? ${code}) != nil)` : this.fromSwift(`(try? ${code})`, optional(m.returns) ? m.returns : `${m.returns}?`, e);
		}
		return m.returns === 'Void' ? `({ () throws -> Bool in try ${code}; return true }())` : this.fromSwift(code, m.returns, e);
	},

	/** Whether a call is of a method Swift imports as `throws`, with the error argument left out: the iOS runtime throws the error. */
	throwingCall(this: NativeAPI, e: ts.CallExpression): boolean {
		try {
			const sent = this.prototypeMethod(e);
			const m = sent?.m ?? this.calledMethod(e);
			const given = e.arguments.length - (sent ? 1 : 0);
			return !!m && ((!!m.throws && given <= m.errorParam!) || !!this.errorOut(m, given));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/**
	 * The argument for a last `NSError **` that Swift keeps as a parameter (`canEvaluatePolicy(_:error:)`,
	 * NS_SWIFT_NOTHROW) where the call leaves it out: the iOS runtime passes its own and throws the error
	 * the method writes. Null where the call passes it or the method has none.
	 */
	errorOut(this: NativeAPI, m: NativeMethod, given: number): string | null {
		const last = m.params.length - 1;
		if (m.throws || last < 0 || given !== last || !/^(NSErrorPointer|AutoreleasingUnsafeMutablePointer<NSError\?>)\??$/.test(m.params[last])) return null;
		return `${m.labels[last] ? `${m.labels[last]}: ` : ''}&__nsError`;
	},

	/**
	 * Whether `e` is an untyped argument where a native function or method takes a Core Foundation object present
	 * (`CGPathAddLineToPoint(path, …)` of a path held as `any`): its conversion throws where it is another value.
	 */
	foreignArgument(this: NativeAPI, e: ts.Expression): boolean {
		const call = e.parent;
		if (!ts.isCallExpression(call) || call.expression === e) return false;
		try {
			if (!isUntyped(spelledType(this.t.typeOf(e)))) return false;
			let k = call.arguments.indexOf(e);
			let type: SwiftType | undefined;
			if (ts.isIdentifier(call.expression)) {
				const native = this.symbolModule(this.t.resolve(call.expression));
				const f = native && lookupFunction(native.module, native.name);
				if (!f) return false;
				// The function's object argument (`CGContextSaveGState(ctx)` as `ctx.saveGState()`) converts to its owner.
				if (f.self !== undefined && k === f.self) type = f.owner ?? undefined;
				else if (f.kind !== 'property' && f.kind !== 'staticProperty') type = f.params.filter((p) => p !== '()')[f.self !== undefined && k > f.self ? k - 1 : k];
			} else type = this.calledMethod(call)?.params.filter((p) => p !== '()')[k];
			return !!type && !optional(type) && CF_CLASSES.has(base(type));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** Whether the native property an assignment writes takes nil (`view.backgroundColor = color`); undefined where it is no native property. */
	propertyOptional(this: NativeAPI, left: ts.PropertyAccessExpression): boolean | undefined {
		try {
			const r = this.receiver(left.expression);
			const m = r ? lookupMember(r.module, r.name, left.name.text, r.isStatic) : null;
			if (!m || m.kind !== 'property') return undefined;
			// An object of a class as it is: a value Swift bridges or converts (`Date?` from a JSDate) is converted present.
			const b = base(m.type);
			return optional(m.type) && /^[A-Z]\w*$/.test(b) && !this.isStructType(b) && !this.isEnumType(b) && !Object.values(BRIDGED).includes(b) && !['String', 'Double', 'Bool', 'Date', 'URL', 'Data'].includes(b);
		} catch (e) {
			rethrowUnlessRefused(e);
			return undefined;
		}
	},

	/** Whether the native method a call runs takes its `k`th argument optional (nil passing as undefined); undefined where it is no native call. */
	argumentOptional(this: NativeAPI, e: ts.CallExpression, k: number): boolean | undefined {
		try {
			const m = this.calledMethod(e);
			return m && m.params[k] !== undefined ? optional(m.params[k]) : undefined;
		} catch (e) {
			rethrowUnlessRefused(e);
			return undefined;
		}
	},

	/**
	 * Whether a typings declaration's Swift binding holds nil (an optional): a property's value, a method's result, a
	 * parameter's argument, or a parameter of a block the method takes. False where the tables have no such member.
	 */
	holdsNil(this: NativeAPI, d: ts.Declaration): boolean {
		try {
			const block = ts.isParameter(d) && ts.isFunctionTypeNode(d.parent) && ts.isParameter(d.parent.parent) ? d.parent.parent : null;
			const param = block ?? (ts.isParameter(d) ? d : null);
			const member = param ? param.parent : d;
			const owner = member.parent;
			const module = this.module(member);
			if (!module || !(ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) || !owner.name) {
				if (!module || !ts.isFunctionDeclaration(member) || !member.name) return false;
				const f = lookupFunction(module, member.name.text);
				if (!f || f.kind === 'equal') return false;
				const params = f.params.filter((_, k) => k !== f.self);
				return this.nilIn(param ? params[member.parameters.indexOf(param)] : f.returns, block, d);
			}
			const name = (member as ts.NamedDeclaration).name;
			if (!name || !ts.isIdentifier(name)) return false;
			const js = RENAMED[owner.name.text] ?? owner.name.text;
			const struct = lookupStruct(module, js);
			if (struct) return false;
			const m = lookupMember(module, js, name.text, isStatic(member));
			if (!m) return false;
			if (m.kind === 'property') return !param && optional(m.type);
			const k = param ? (member as ts.SignatureDeclaration).parameters.indexOf(param) : -1;
			return this.nilIn(param ? m.params.filter((p) => p !== '()')[k] : m.returns, block, d);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** Whether Swift type `type` holds nil, or for a block parameter `d` of `block`, the block's parameter there. */
	nilIn(this: NativeAPI, type: SwiftType | undefined, block: ts.ParameterDeclaration | null, d: ts.Declaration): boolean {
		if (!type) return false;
		if (!block) return optional(type);
		const parts = functionParts(base(type.replace(/^@escaping\s+/, '').trim()));
		const fn = block.type && ts.isFunctionTypeNode(block.type) ? block.type : null;
		const k = fn ? fn.parameters.indexOf(d as ts.ParameterDeclaration) : -1;
		return !!parts && k >= 0 && !!parts.params[k] && optional(parts.params[k]);
	},

	/** The native method or initializer a call runs, as `call` finds it; null for anything else. */
	calledMethod(this: NativeAPI, e: ts.CallExpression): NativeMethod | null {
		const callee = e.expression;
		if (!ts.isPropertyAccessExpression(callee) || appMember(callee.name, this.t.checker)) return null;
		const name = callee.name.text;
		if (ts.isCallExpression(callee.expression) && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === 'alloc') {
			const r = this.receiver(callee.expression.expression.expression);
			return r ? lookupInit(r.module, r.name, name) : null;
		}
		const r = this.receiver(callee.expression);
		const m = r ? (lookupMember(r.module, r.name, name, r.isStatic) ?? this.optionsSibling(r, name, e.arguments.length) ?? (r.isStatic ? this.factoryInit(r, name) : null)) : null;
		return m && m.kind !== 'property' ? m : null;
	},

	/** `new UIView()`, `new UIView({ frame })`. */
	construct(this: NativeAPI, e: ts.NewExpression): string | null {
		const r = this.receiver(e.expression);
		if (!r || !r.isStatic) return null;
		const cls = lookupClass(r.module, r.name);
		if (!cls) throw this.t.error(e, `new ${r.name} (no Swift class)`, 'native');
		const args = e.arguments ?? ts.factory.createNodeArray();
		if (!args.length) return `${this.className(cls)}()`;
		const o = args[0];
		if (args.length !== 1 || !ts.isObjectLiteralExpression(o)) throw this.t.error(e, `new ${r.name} with arguments other than one object literal`, 'native');
		const keys = o.properties.map((p) => p.name!.getText());
		const init = this.found(lookupConstructor(r.module, r.name, keys));
		if (!init) throw this.t.error(e, `new ${r.name}({ ${keys.join(', ')} }) (no Swift initializer)`, 'native');
		const values = keys.map((k) => {
			const p = o.properties.find((x) => x.name!.getText() === k)!;
			return ts.isPropertyAssignment(p) ? p.initializer : (p as ts.ShorthandPropertyAssignment).name;
		});
		return this.fromSwift(`${this.className(cls)}(${this.argList(e, values, init.labels, init.params)})`, init.returns, e);
	},

	/** A native constant or enum-like global (`UIFontWeightBold`), or null. */
	identifier(this: NativeAPI, e: ts.Identifier): string | null {
		const sym = this.t.resolve(e);
		const native = this.symbolModule(sym);
		if (native && sym!.flags & ts.SymbolFlags.Function) return this.functionValue(e, native);
		if (!native || !(sym!.flags & ts.SymbolFlags.Variable)) return null;
		const k = lookupConstant(native.module, native.name);
		if (!k) throw this.t.error(e, `${native.name} (${this.noCounterpart(native.module, native.name)})`, 'native');
		this.usesEnumOf(k, native.module, native.name);
		return this.fromSwift(k.swift, k.type, e);
	},

	/**
	 * A global a source file declares for itself (`declare const UIBarButtonItemVisibilityPriorityHigh: number`, a
	 * constant typings newer than its own have) that an SDK module has as a constant: that constant, or null.
	 */
	declaredConstant(this: NativeAPI, e: ts.Identifier): string | null {
		for (const module of new Set(['UIKit', 'Foundation', ...this.modules])) {
			const k = lookupConstant(module, e.text);
			if (!k) continue;
			this.uses(module);
			this.usesEnumOf(k, module, e.text);
			return this.fromSwift(k.swift, k.type, e);
		}
		return null;
	},

	/** A typed constant's enum is looked up among the modules in use, and may live in another table than the typings' module. */
	usesEnumOf(this: NativeAPI, k: { enumType?: string }, module: string, jsName: string) {
		const home = k.enumType ? constantModule(module, jsName) : null;
		if (home) this.uses(home);
	},

	/** A native function of no arguments as a value (`isRunning = UIAccessibilityIsVoiceOverRunning`): a closure calling it, as Swift may have it as a property. */
	functionValue(this: NativeAPI, e: ts.Identifier, native: { module: string; name: string }): string | null {
		const f = lookupFunction(native.module, native.name);
		if (!f || f.params.length || !['function', 'staticMethod', 'staticProperty'].includes(f.kind)) return null;
		this.checkAvailable(f, e, native.name);
		const sig = this.t.checker.getTypeAtLocation(e).getCallSignatures()[0];
		const ret = sig ? this.t.type(sig.getReturnType(), e) : null;
		if (ret !== f.returns) return null;
		const call = f.kind === 'staticProperty' ? `${f.owner}.${f.swift}` : f.kind === 'staticMethod' ? `${f.owner}.${f.swift}()` : `${f.swift}()`;
		return `{ () throws -> ${ret} in ${call} }`;
	},

	/** An object literal for a native struct (`{ origin: { x: 0, y: 0 }, size }` as a CGRect). */
	structLiteral(this: NativeAPI, e: ts.ObjectLiteralExpression, type: ts.Type): string | null {
		const native = this.symbolModule(type.getSymbol());
		const struct = native && lookupStruct(native.module, native.name);
		if (!struct) return null;
		const args = Object.entries(struct.fields).map(([name, ft]) => {
			const p = e.properties.find((x) => x.name?.getText() === name);
			if (!p) throw this.t.error(e, `${native!.name} literal without ${name}`, 'native');
			const v = ts.isPropertyAssignment(p) ? p.initializer : (p as ts.ShorthandPropertyAssignment).name;
			return `${name}: ${this.toSwift(v, ft)}`;
		});
		return `${struct.swift}(${args.join(', ')})`;
	},
};
