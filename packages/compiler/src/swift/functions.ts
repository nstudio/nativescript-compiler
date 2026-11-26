// Functions as Swift: parameters, defaults, return types, generics, bodies, closures.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { ARRAY_CALLBACK_METHODS, kitFunctionThrows } from './library.ts';
import { ERRORS, TYPED_ARRAYS } from '../semantics/globals.ts';
import { functionParts, ident, isFunctionType, isMethodValue, isOptional, metatype, optionalType, refersTo, splitTopLevel, RT, type FunctionParts } from './syntax.ts';
import type { Translator } from './translator.ts';
import { returnCell } from '../semantics/placement.ts';
import { hasModifier, isLibDeclaration, withoutDefault, implementationOf, declaresThis } from '../semantics/ast.ts';
import { isAsync, isStatic } from '../semantics/throws.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { methodValues } from '../semantics/lang.ts';
import { baseMethod } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const functionsMethods = {
	/** The value undefined reads as where Swift holds `type` (nil, NaN, "undefined", false); null where it has none. */
	undefinedValue(this: Translator, type: string): string | null {
		if (isOptional(type) || isUntyped(spelledType(type)) || type.endsWith('!')) return 'nil';
		const value = type === 'Double' ? '.nan' : type === 'String' ? '"undefined"' : type === 'Bool' ? 'false' : null;
		if (value) heldLoss('undefinedValue', value);
		return value;
	},

	/**
	 * An app function that calls itself (`depth(n - 1)`): it checks the stack on entry, so recursion too deep for
	 * it is JavaScript's catchable RangeError rather than a crash. Library code (the kit) recurses over view trees only.
	 */
	selfRecursive(this: Translator, fn: ts.Node): boolean {
		if (this.library || this.lenient || !(ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) || !fn.body || isAsync(fn) || fn.asteriskToken) return false;
		const own = fn.name && this.checker.getSymbolAtLocation(fn.name);
		if (!own) return false;
		let found = false;
		const visit = (n: ts.Node): void => {
			if (found) return;
			if (ts.isCallExpression(n)) {
				const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
				if (this.checker.getSymbolAtLocation(callee) === own) {
					found = true;
					return;
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(fn.body);
		return found;
	},

	/** A function's body block (`{ … }`), lowered when the function is async. */
	functionBody(this: Translator, fn: ts.FunctionLikeDeclaration, ret: string, base: string): string {
		const counterpart = this.memberCounterpart(fn) ?? this.functionCounterpart(fn);
		if (counterpart) {
			const args = [...(ts.isFunctionDeclaration(fn) ? [] : ['self']), ...fn.parameters.map((p) => ident((p.name as ts.Identifier).text))];
			const call = this.marks.tryIf(this.throwsInfo.fn(fn), `${counterpart}(${args.join(', ')})`);
			return `{\n${base}    ${ret === 'Void' ? call : `return ${call}`}\n${base}}`;
		}
		this.lenientParams(fn);
		this.availability.push(0);
		let needs = 0;
		const body = this.functionBodyLines(fn, ret, base);
		needs = this.availability.pop()!;
		if (!needs) return body;
		const inner = body.slice(2, body.length - base.length - 2);
		return `{\n${this.availableOnly(needs, inner, base + '    ', this.unavailable(needs, ret, this.throwsInfo.fn(fn) && !isAsync(fn) && !fn.asteriskToken))}\n${base}}`;
	},

	/** Whether the kit's Swift implementing a function (its counterpart) is declared `throws`; undefined where it has none the kit declares. */
	counterpartThrows(this: Translator, fn: ts.Node): boolean | undefined {
		if (!ts.isFunctionLike(fn)) return undefined;
		const named = ts.isFunctionDeclaration(fn) && fn.name && ts.isSourceFile(fn.parent) ? this.library?.counterpart?.(fn.getSourceFile().fileName, fn.name.text) : null;
		const counterpart = this.memberCounterpart(fn as ts.FunctionLikeDeclaration) ?? named;
		const m = counterpart ? /^([\w.]+)\.(\w+)$/.exec(counterpart) : null;
		const member = m ? this.core.kitMember(m[1], m[2]) : null;
		if (member) return member.kind === 'func' ? !!member.throws : undefined;
		return m ? kitFunctionThrows(m[2], this.config.adapter.kit.apple) : undefined;
	},

	/** The kit's implementation of a class's method or accessor (`iOSApplication.addDelegateHandler`), which its body calls with the object. */
	memberCounterpart(this: Translator, fn: ts.FunctionLikeDeclaration): string | null {
		if (!this.library?.counterpart || !(ts.isMethodDeclaration(fn) || ts.isAccessor(fn)) || !ts.isClassDeclaration(fn.parent) || !fn.parent.name || isStatic(fn)) return null;
		return this.library.counterpart(fn.getSourceFile().fileName, `${fn.parent.name.text}.${fn.name.getText()}`);
	},

	/**
	 * Library mode: the kit's implementation of a module's exported function that gives nothing (`startMonitoring` of connectivity),
	 * which the module's function of that name calls, for the app to call through the module.
	 */
	functionCounterpart(this: Translator, fn: ts.Node): string | null {
		if (!this.library?.counterpart || !ts.isFunctionDeclaration(fn) || !fn.name || !fn.body || !ts.isSourceFile(fn.parent) || fn.name.text.startsWith('_') || !hasModifier(fn, ts.SyntaxKind.ExportKeyword)) return null;
		const counterpart = this.library.counterpart(fn.getSourceFile().fileName, fn.name.text);
		const sig = counterpart && this.checker.getSignatureFromDeclaration(fn);
		return counterpart && sig && /^[A-Z]\w*\.\w+$/.test(counterpart) && this.checker.getReturnTypeOfSignature(sig).flags & ts.TypeFlags.Void && fn.parameters.every((p) => ts.isIdentifier(p.name)) ? counterpart : null;
	},

	/**
	 * `return undefined` where Swift declares `ret`: nil, or the value undefined converts to (NaN,
	 * "undefined", false); for an object that cannot be missing, a TypeError where the function throws.
	 */
	undefinedReturn(this: Translator, ret: string, throws: boolean): string {
		if (isOptional(ret) || isUntyped(spelledType(ret)) || ret.endsWith('!')) return 'return nil';
		if (ret === 'Double') return 'return .nan';
		if (ret === 'String') return 'return "undefined"';
		if (ret === 'Bool') return 'return false';
		if (this.native.isStructType(ret) || /^JSArray<.*>$/.test(ret)) return `return ${ret}()`;
		return throws ? 'throw JSException(JSTypeError("undefined where a value is declared"))' : `return ${RT.jsNativeZero}(${metatype(ret)})`;
	},

	functionBodyLines(this: Translator, fn: ts.FunctionLikeDeclaration, ret: string, base: string): string {
		return this.inFunction(ret, () => {
			const saved = this.indent;
			this.indent = base + '    ';
			try {
				let lines: string[];
				if (fn.asteriskToken) lines = this.lowering.generatorBody(fn, ret.replace(/^JS\w+<(.*)>$/, '$1'), isAsync(fn));
				else if (isAsync(fn)) lines = this.lowering.body(fn, ret.replace(/^JSPromise<(.*)>[?!]?$/, '$1'));
				else if (fn.body && ts.isBlock(fn.body)) {
					lines = [...(this.selfRecursive(fn) ? [`${this.indent}try ${RT.jsCheckStack}()`] : []), ...this.paramPrelude(fn), ...this.statements([...fn.body.statements])];
					// The checker proved every path returns (an exhaustive switch), or one that falls off the end returns undefined; Swift cannot see either.
					const last = fn.body.statements.at(-1);
					const endReached = !last || !this.endUnreachable(last);
					// A value outside the union the cases cover (from JSON, an untyped caller) gives undefined, as its type reads it.
					if (!['Void', 'Never'].includes(ret) && last && ts.isSwitchStatement(last)) {
						if (endReached) lines.push(`${this.indent}${this.undefinedReturn(ret, this.throwsInfo.fn(fn))}`);
					} else if (isUntyped(spelledType(ret)) && this.returnTypeOf(fn) === 'Void' && endReached) lines.push(`${this.indent}return nil`);
					// A function that may give undefined (`if (big) return load();`) gives it past its last statement.
					else if (isOptional(ret) && last && endReached) lines.push(`${this.indent}return nil`);
					// A function returning on some paths only (`if (ok) return p.then(…)`, typed `Promise<void> | undefined`) gives undefined where its end is reached.
					else if ((isOptional(ret) || isUntyped(spelledType(ret)) || ret.endsWith('!')) && fn.flags & ts.NodeFlags.HasImplicitReturn && endReached) lines.push(`${this.indent}return nil`);
					// Lenient code: a function returning on some paths only gives undefined past them, read as its type reads undefined.
					else if (last && (this.lenient || this.lenientApp) && endReached && !['Void', 'Never'].includes(ret)) {
						const none = isOptional(ret) || isUntyped(spelledType(ret)) || ret.endsWith('!') ? 'nil' : (this.zero(ret) ?? (this.native.isStructType(ret) ? `${ret}()` : null));
						lines.push(`${this.indent}${none ? `return ${none}` : this.undefinedReturn(ret, this.throwsInfo.fn(fn))}`);
					}
				} else {
					const e = fn.body as ts.Expression;
					const slot = this.resultSlot(e);
					const body = this.bodyReturned(returnCell(this.returns, e, slot, true), slot);
					lines = [...this.paramPrelude(fn), body && (this.lines?.markLine(e) ?? '') + body];
				}
				return `{\n${lines.filter(Boolean).join('\n')}\n${base}}`;
			} finally {
				this.indent = saved;
			}
		});
	},

	func(this: Translator, fn: ts.FunctionDeclaration | ts.MethodDeclaration, name: string, modifiers = '', extraParams: string[] = []): string {
		this.generics(fn);
		const base = ts.isMethodDeclaration(fn) && /\boverride\b/.test(modifiers) ? baseMethod(fn, this.checker) : null;
		if (base && ts.isMethodDeclaration(fn)) {
			const b = this.emittedSignature(fn),
				own = this.signatureOf(fn);
			if (b.ret !== own.ret || b.params.length !== own.params.length || b.params.some((p, k) => p.type !== own.params[k].type)) return this.adaptedOverride(fn, name, modifiers, b);
		}
		// A signature naming a native type newer than the deployment target: the function exists only where the OS has it.
		// A type looked up on the way to one the signature does not name (`UIGlassEffectStyle | 1`, held as `Any?`) needs nothing.
		const types = new Map<string, number>();
		this.availability.push(0);
		this.statementTypes.set(this.availability.length, types);
		const ret = this.returnTypeOf(fn);
		const throws = !isAsync(fn) && this.throwsInfo.fn(fn) ? ' throws' : '';
		const widened = ts.isMethodDeclaration(fn) && !base ? this.hierarchyExtras(fn).map((p) => p.decl) : [];
		const params = [this.params(fn, false), ...extraParams, ...widened].filter(Boolean).join(', ');
		const declared = this.inNativeClass(fn) ? ret : this.lenientRef(ret);
		this.statementTypes.delete(this.availability.length);
		let needs = this.availability.pop()!;
		for (const [type, version] of types) if (version > needs && new RegExp(`(?<!\\w)${type.replace(/[.$]/g, '\\$&')}\\b`).test(`${params} ${declared}`)) needs = version;
		if (needs) {
			this.gatedFunctions.set(fn, needs);
			modifiers = `@available(iOS ${needs}, *) ${modifiers}`;
		}
		// A function declaring `this` reads it as its first parameter.
		const first = fn.parameters[0];
		// Declared `@available` for what its signature names, the body checks for no older iOS.
		const body = this.availableFrom(needs, () => (ts.isFunctionDeclaration(fn) && this.takesThis(fn) ? this.withThis(fn, ident('this'), !declaresThis(fn) || isUntyped(spelledType(this.paramType(first))), () => this.functionBody(fn, ret, this.indent)) : this.functionBody(fn, ret, this.indent)));
		this.lastSignature = { kind: 'func', mods: modifiers, params, throws: !!throws, type: ret === 'Void' ? 'Void' : declared, generics: this.generics(fn) };
		return `${modifiers}func ${name}${this.generics(fn)}(${params})${throws}${ret === 'Void' ? '' : ` -> ${declared}`} ${body}`;
	},

	/** The Swift signature a method is emitted with: its root's, which every override in Swift matches. */
	emittedSignature(this: Translator, m: ts.MethodDeclaration): { params: { decl: string; type: string }[]; ret: string } {
		let root = m;
		for (let b = baseMethod(root, this.checker); b; b = baseMethod(root, this.checker)) root = b;
		if (root !== m) {
			const sig = this.emittedSignature(root);
			const bound = this.boundTypeParameters(m.parent as ts.ClassLikeDeclaration, root.parent as ts.ClassLikeDeclaration);
			if (!bound.size) return sig;
			const sub = (t: string) => t.replace(/\b[A-Z]\w*\b/g, (n) => bound.get(n) ?? n);
			return { params: sig.params.map((p) => ({ decl: p.decl.slice(0, p.decl.indexOf(':') + 1) + sub(p.decl.slice(p.decl.indexOf(':') + 1)), type: sub(p.type) })), ret: sub(sig.ret) };
		}
		const own = this.signatureOf(m);
		return { params: [...own.params, ...this.hierarchyExtras(m)], ret: own.ret };
	},

	/**
	 * Library mode: the parameters overrides add past their root method's
	 * (`layout(l, t, r, b, setFrame)` over `layout(l, t, r, b)`), which the root
	 * takes too, optional, so every override has one Swift signature and a call
	 * passing them reaches the override that reads them.
	 */
	hierarchyExtras(this: Translator, root: ts.MethodDeclaration): { decl: string; type: string }[] {
		if (!this.library || !ts.isClassLike(root.parent)) return [];
		const n = root.parameters.length;
		if (root.parameters.some((p) => p.dotDotDotToken)) return [];
		const extras: { decl: string; type: string }[] = [];
		for (const m of this.overridesOf(root)) {
			for (let k = n; k < m.parameters.length; k++) {
				const p = m.parameters[k];
				if (p.dotDotDotToken || !ts.isIdentifier(p.name)) break;
				if (extras[k - n]) continue;
				const t = optionalType(this.typeOf(p.name).replace(/!$/, ''));
				extras[k - n] = { decl: `_ __extra${k - n}: ${t} = nil`, type: t };
			}
		}
		const dense: { decl: string; type: string }[] = [];
		for (const e of extras) {
			if (!e) break;
			dense.push(e);
		}
		return dense;
	},

	/**
	 * A built-in constructor as a value: an error constructor its class, as an instance's `constructor` reads
	 * (`e.constructor === TypeError`); `Number`, `String` (`map(Number)`) a function of the value its slot gives first,
	 * the conversion calling them does. `Boolean` is the array methods' own (`filter(Boolean)`).
	 */
	builtinConstructorValue(this: Translator, e: ts.Identifier, decl: ts.Declaration | undefined): string | null {
		const p = e.parent;
		const asValue = !((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === e) && !(ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === e) && !(ts.isPropertyAccessExpression(p) && p.expression === e) && !ts.isTypeOfExpression(p);
		if (!asValue || !isLibDeclaration(decl)) return null;
		if (ERRORS[e.text]) return `${ERRORS[e.text]}.self`;
		if (e.text === 'Promise') return 'JSPromiseConstructor.promise';
		if (e.text === 'Date') return 'jsDateBuiltin';
		if (e.text === 'Array') return 'jsArrayBuiltin';
		const conversion = ({ Number: [RT.jsToNumber, 'Double'], String: [RT.jsToString, 'String'], Boolean: [RT.jsTruthy, 'Bool'] } as Record<string, [string, string]>)[e.text];
		if (!conversion) return null;
		const context = this.checker.getContextualType(e);
		const slot = context && this.checker.getNonNullableType(context).getCallSignatures()[0];
		// Placed untyped (`const f: any = Number`, `s.constructor === String`): singleton builtin constructor.
		if (!slot) return `js${e.text}Constructor`;
		const param = slot?.getParameters()[0];
		const t = param ? this.type(this.checker.getTypeOfSymbolAtLocation(param, e), e) : 'Any?';
		const call = p && ts.isCallExpression(p) && p.arguments[0] === e && ts.isPropertyAccessExpression(p.expression) ? p.expression.expression : null;
		return `{ (__p0: ${call && this.states.optionalElements(call) ? optionalType(t) : t}) -> ${conversion[1]} in ${conversion[0]}(__p0) }`;
	},

	/** `parseInt`, `parseFloat` as values (`valueConverter: parseInt`): functions of the string they are given, and their Swift type. */
	parseFunction(this: Translator, e: ts.Identifier): { code: string; type: string } | null {
		const name = e.text;
		if (!(name === 'parseInt' || name === 'parseFloat') || (ts.isCallExpression(e.parent) && e.parent.expression === e) || !isLibDeclaration(this.resolve(e)?.declarations?.[0])) return null;
		// The closure takes the parameters its slot gives (`map` passes an index, which parseInt reads as the radix).
		// Without a slot (`static parse = parseInt`), the function's own parameters.
		const context = this.checker.getContextualType(e);
		const given = context && this.checker.getNonNullableType(context).getCallSignatures()[0];
		const slot = given ?? this.checker.getTypeAtLocation(e).getCallSignatures()[0];
		const types = (slot?.getParameters() ?? []).map((p) => {
			const t = this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e);
			return p.valueDeclaration && ts.isParameter(p.valueDeclaration) && p.valueDeclaration.questionToken ? optionalType(t) : t;
		});
		// Placed untyped (`const f: any = parseInt`), it may be given anything, converted to a string as JavaScript converts it.
		const first = given && types.length ? types[0] : context ? 'Any?' : 'String';
		const params = types.length ? types.map((t, k) => (k === 0 ? first : t)) : [first];
		const radix = types.length > 1 ? (types[1].endsWith('?') ? '__p1' : 'Optional(__p1)') : 'nil';
		const text = first === 'String' ? '__p0' : `${RT.jsToString}(__p0)`;
		const body = name === 'parseInt' ? `${RT.jsParseInt}(${text}, ${radix})` : `${RT.jsParseFloat}(${text})`;
		return { code: `{ (${params.map((t, k) => `__p${k}: ${t}`).join(', ')}) -> Double in ${body} }`, type: `(${params.join(', ')}) throws -> Double` };
	},

	/** A function value's Swift type: a function declaration's as it is emitted (see `functionValueType`). */
	functionValueOf(this: Translator, e: ts.Expression): string {
		const decl = this.resolve(ts.isPropertyAccessExpression(e) ? e.name : e)?.valueDeclaration;
		return decl && ts.isFunctionDeclaration(decl) && decl.body ? this.functionValueType(decl) : this.typeOf(e);
	},

	/** A function declaration's Swift type as a value: lenient code's object results and parameters may be undefined. */
	functionValueType(this: Translator, fn: ts.FunctionDeclaration | ts.MethodDeclaration): string {
		const impl = implementationOf(fn);
		if (impl && (ts.isFunctionDeclaration(impl) || ts.isMethodDeclaration(impl))) fn = impl;
		const params = this.readsArguments(fn)
			? ['JSRest<Any?>']
			: fn.parameters.length
				? splitTopLevel(this.params(fn, false)).map((decl) =>
						withoutDefault(decl.slice(decl.indexOf(':') + 1))
							.trim()
							.replace(/^@escaping /, '')
							.replace(/!$/, '?'),
					)
				: [];
		const ret = this.returnTypeOf(fn);
		return `(${params.join(', ')}) throws -> ${
			ret === 'Void'
				? ret
				: this.lenientRef(ret)
						.replace(/!$/, '?')
						.replace(/^\((.*)\)\?$/, '($1)?')
		}`;
	},

	/** A method's Swift signature as declared: each parameter's type, and the result. */
	signatureOf(this: Translator, m: ts.MethodDeclaration | ts.FunctionDeclaration): { params: { decl: string; type: string }[]; ret: string } {
		const params = m.parameters.length
			? splitTopLevel(this.params(m, false)).map((decl) => ({
					decl: withoutDefault(decl).trim(),
					type: withoutDefault(decl.slice(decl.indexOf(':') + 1))
						.trim()
						.replace(/^@escaping /, ''),
				}))
			: [];
		const ret = !m.body && !m.type ? 'Void' : this.returnTypeOf(m);
		return { params, ret: ret === 'Void' || this.inNativeClass(m) ? ret : this.lenientRef(ret) };
	},

	/**
	 * A method overriding one whose Swift signature differs (a narrower result, a
	 * parameter typed otherwise): Swift's override takes the base's signature, and
	 * the method's own parameters and result are converted to and from it.
	 */
	adaptedOverride(this: Translator, fn: ts.MethodDeclaration, name: string, modifiers: string, base: { params: { decl: string; type: string }[]; ret: string }): string {
		const plain = (t: string) => t.replace(/!$/, '?');
		const own = this.signatureOf(fn);
		const ret = this.inNativeClass(fn) ? this.returnTypeOf(fn) : this.lenientRef(this.returnTypeOf(fn));
		const throws = !isAsync(fn) && this.throwsInfo.fn(fn);
		const pad = this.indent + '    ';
		const binds = fn.parameters
			.map((p, k) => {
				if (!ts.isIdentifier(p.name) || !this.isRead(p.name)) return '';
				const t = own.params[k].type;
				// A rest parameter over the base's: the arguments from here on, as one array.
				if (p.dotDotDotToken) {
					const el = t.replace(/^JSArray<(.*)>$/, '$1');
					const rest = base.params.slice(k).map((b, j) => this.convert(`__b${k + j}`, plain(b.type), el));
					return `${pad}let ${ident(p.name.text)}: ${t} = ${t}([${rest.join(', ')}])`;
				}
				const from = base.params[k] ? plain(base.params[k].type) : null,
					to = plain(t);
				// An argument the base takes as optional, for a parameter with a default: the default when it is missing.
				if (from && p.initializer && from.endsWith('?') && !to.endsWith('?')) return `${pad}let ${ident(p.name.text)}: ${t} = ${this.convert(`__b${k}`, from, optionalType(to))} ?? ${this.stored(p.initializer, p, to)}`;
				// Lenient code: a string, number or boolean the base takes as optional stays undefined where it is, though this override declares it present.
				if (this.lenient && from === `${to}?` && (to === 'Double' || to === 'String' || to === 'Bool')) return `${pad}let ${ident(p.name.text)}: ${this.bindsOptional(p.name, to)} = __b${k}`;
				const converted = from ? this.convert(`__b${k}`, from, to) : (this.zero(t) ?? 'nil');
				// A parameter narrowed to a subclass: the argument as that class, undefined where it is not one.
				const value = from && converted === `__b${k}` && from !== to && this.nullableRef(to.replace(/\?$/, '')) !== to.replace(/\?$/, '') ? this.marks.unwrappedIf(this.marks.castCode(`__b${k}`, to.replace(/\?$/, ''), 'as?'), !to.endsWith('?')) : converted;
				return `${pad}let ${ident(p.name.text)}: ${t} = ${value}`;
			})
			.filter(Boolean);
		// An optional parameter keeps its default: `super.m(x)` resolves against this signature.
		let root: ts.MethodDeclaration = fn;
		for (let b = baseMethod(root, this.checker); b; b = baseMethod(root, this.checker)) root = b;
		const omittable = (k: number) => {
			const p = root.parameters[k];
			return base.params[k].type.endsWith('?') && (!p || !!p.questionToken || !!p.initializer);
		};
		const params = base.params.map((p, k) => `_ __b${k}: ${p.decl.slice(p.decl.indexOf(':') + 1).trim()}${omittable(k) && !/=/.test(p.decl) ? ' = nil' : ''}`).join(', ');
		const body = this.functionBody(fn, ret, pad);
		const call = this.marks.tryIf(throws, `{ () ${throws ? 'throws ' : ''}-> ${ret} in${body.slice(1)}()`);
		const result = base.ret === 'Void' ? `${pad}_ = ${call}` : `${pad}let __result: ${ret} = ${call}\n${pad}return ${this.convert('__result', plain(ret), plain(base.ret))}`;
		this.lastSignature = { kind: 'func', mods: modifiers, params, throws, type: base.ret };
		return `${modifiers}func ${name}(${params})${throws ? ' throws' : ''}${base.ret === 'Void' ? '' : ` -> ${base.ret}`} {\n${[...binds, result].join('\n')}\n${this.indent}}`;
	},

	/** `(r) => r.id` as a Swift closure with explicit types. */
	closure(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression, pad: string[] = []): string {
		if (ts.isFunctionExpression(fn) && ((this.library && this.readsArguments(fn)) || (methodValues(this, fn) && isMethodValue(fn)))) return this.methodValue(fn);
		// A callback whose slot returns void returns nothing, whatever its expression body evaluates to.
		const ret = this.closureResult(fn).target;
		const throws = !isAsync(fn) && this.throwsInfo.fn(fn) ? 'throws ' : '';
		// A function expression's name is only for itself: one that never refers to itself is an anonymous function.
		if (fn.name && refersTo(fn.body, this.checker.getSymbolAtLocation(fn.name), this.checker)) {
			const fnName = ident(fn.name.text);
			const extra = this.unusedParameters(fn).map((t, k) => `_ __unused${k}: ${t}`);
			const fnParams = [this.params(fn, false), ...extra, ...pad.map((p) => (p.startsWith('_ ') ? p : `_ ${p}`))].filter(Boolean).join(', ');
			const pTypes = fnParams
				? splitTopLevel(fnParams).map((d) =>
						withoutDefault(d.slice(d.indexOf(':') + 1))
							.trim()
							.replace(/^@escaping /, ''),
					)
				: [];
			const fnType = `(${pTypes.join(', ')}) ${throws}-> ${ret}`;
			const body = this.functionBody(fn, ret, this.indent + '    ');
			return `{ () -> ${fnType} in\n${this.indent}    func ${fnName}(${fnParams}) ${throws}-> ${ret} ${body}\n${this.indent}    return ${fnName}\n${this.indent}}()`;
		}
		if (this.takesRestArray(fn) && !pad.length) {
			const inner = this.indent + '    ';
			const binds = fn.parameters.map((p, k) => {
				const t = this.closureParamType(p);
				const read = t.endsWith('!') ? optionalType(t.slice(0, -1)) : t;
				return `\n${inner}let ${ident((p.name as ts.Identifier).text)}: ${t} = ${this.fromAnyCode(`${RT.jsArg}(__rest.storage, ${k})`, read, true)}`;
			});
			return `{ (__rest: JSArray<Any?>) ${throws}-> ${ret} in${binds.join('')}${this.functionBody(fn, ret, this.indent).slice(1)}`;
		}
		if (ts.isFunctionExpression(fn) && this.readsArguments(fn) && !pad.length) {
			const slot = this.slotOf(fn);
			if (slot && slot.getDeclaration() !== fn) {
				const slotParams = slot.getParameters().filter((p) => p.name !== 'this');
				const pTypes = slotParams.map((p) => this.type(this.checker.getTypeOfSymbolAtLocation(p, fn), fn));
				const names = pTypes.map((_, k) => `__a${k}`);
				const inner = `{ (__arguments: JSArray<Any?>) ${throws}-> ${ret} in${this.functionBody(fn, ret, this.indent).slice(1)}`;
				const call = `${throws ? 'try ' : ''}(${inner})(JSArray<Any?>([${names.map((n, k) => this.convert(n, pTypes[k], 'Any?')).join(', ')}]))`;
				return `{ (${names.map((n, k) => `${n}: ${pTypes[k]}`).join(', ')}) ${throws}-> ${ret} in ${ret === 'Void' ? call : `return ${call}`} }`;
			}
		}
		const extra = this.unusedParameters(fn).map((t, k) => `_ __unused${k}: ${t}`);
		const weak = ret === 'Void' && this.weakCapture(fn);
		return `{ ${weak ? '[weak self] ' : ''}(${[this.params(fn, true), ...extra, ...pad].filter(Boolean).join(', ')}) ${throws}-> ${ret} in${weak ? ' guard let self else { return }' : ''}${this.functionBody(fn, ret, this.indent).slice(1)}`;
	},

	/** A closure assigned to a field of `this` that `weak.captures` names: it holds `this` weakly, and does nothing once it is gone. */
	weakCapture(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
		if (!this.weak.captures.size || !ts.isArrowFunction(fn)) return false;
		const at = fn.parent;
		const name = ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken && at.right === fn && ts.isPropertyAccessExpression(at.left) && at.left.expression.kind === ts.SyntaxKind.ThisKeyword ? at.left.name.text : ts.isPropertyDeclaration(at) && at.initializer === fn ? at.name.getText() : null;
		const cls = name && ts.findAncestor(fn, ts.isClassLike);
		return !!cls && this.weak.captures.has(`${cls.name?.text}.${name}`);
	},

	/**
	 * A closure stored where a function taking all its arguments as one array is declared (`(...args: any[]) => void`,
	 * XMLHttpRequest's `onload`): it takes the array, and its parameters are the array's elements. A builtin's
	 * callback (`setTimeout`'s) is the closure the runtime calls with none.
	 */
	takesRestArray(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
		const at = fn.parent;
		const stored = (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken && at.right === fn) || ((ts.isPropertyDeclaration(at) || ts.isVariableDeclaration(at)) && at.initializer === fn && !!at.type);
		if (!stored || this.closureSlots.has(fn) || this.readsArguments(fn) || this.implicitThis(fn)) return false;
		if (fn.parameters.some((p) => p.dotDotDotToken || p.initializer || !ts.isIdentifier(p.name) || p.name.text === 'this')) return false;
		const first = this.slotOf(fn)?.getParameters()[0];
		const decl = first?.valueDeclaration;
		return !!decl && ts.isParameter(decl) && !!decl.dotDotDotToken && this.type(this.checker.getTypeOfSymbolAtLocation(first!, fn), fn) === 'JSArray<Any?>';
	},

	/** A closure parameter's Swift type, as `params` declares it. */
	closureParamType(this: Translator, p: ts.ParameterDeclaration): string {
		let t = this.typeOf(p.name);
		if (ts.isIdentifier(p.name) && !p.questionToken && this.states.optionalBinding(p.name)) return this.bindsOptional(p.name, t);
		if (this.states.mayBeNull(p) || (!isFunctionType(t) && this.lenientAppParameter(p, t))) t = this.lenient ? optionalType(t) : `${t}!`;
		return p.questionToken ? optionalType(t) : t;
	},

	/** A field read by name: a function it holds as the script function a caller can call (`TRANSFORM_MATRIXES[property](value)`). */
	boxedField(this: Translator, code: string, type: string): string {
		const inner = type.replace(/^\((.*)\)[?!]$/, '$1');
		// Through an optional: a field Swift holds implicitly unwrapped is nil until set, which reads as undefined.
		return functionParts(inner) ? this.convert(code, `(${inner})?`, 'Any?') : code;
	},

	/** A Swift function type's parameters and result, or null for any other type. */
	functionTypeParts(this: Translator, type: string): FunctionParts | null {
		return functionParts(type);
	},

	/** The types of the arguments a callback's slot passes past those the closure declares, which Swift closures still take. */
	unusedParameters(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
		const forced = this.closureSlots.get(fn);
		if (forced) return forced.slice(fn.parameters.length).map((p) => p.replace(/^@escaping /, ''));
		const slot = this.slotOf(fn);
		// The runtime's array and typed array methods take callbacks of one to three parameters, never none.
		const call = fn.parent;
		const method = ts.isCallExpression(call) && call.arguments[0] === fn && ts.isPropertyAccessExpression(call.expression) && ARRAY_CALLBACK_METHODS.has(call.expression.name.text) ? call.expression : null;
		const receiver = method && this.checker.getNonNullableType(this.checker.getTypeAtLocation(method.expression));
		if (!fn.parameters.length && slot && receiver && (this.checker.isArrayType(receiver) || TYPED_ARRAYS.includes(receiver.getSymbol()?.name ?? ''))) {
			const first = slot.getParameters()[0];
			if (first) {
				const t = this.type(this.checker.getTypeOfSymbolAtLocation(first, fn), fn);
				return [this.states.optionalElements(method!.expression) ? optionalType(t) : t];
			}
		}
		const coreSlot = !!slot?.getDeclaration() && isCoreDeclaration(slot.getDeclaration() as ts.Declaration);
		// The app's own function types are Swift's as declared: every parameter, whatever the closure uses.
		const appSlot = !!slot?.getDeclaration() && !slot.getDeclaration().getSourceFile().isDeclarationFile;
		if (!((coreSlot && !fn.parameters.length) || appSlot)) return [];
		// As the slot's Swift function type has them (an object parameter optional).
		const whole = appSlot ? functionParts(this.type(this.checker.getNonNullableType(this.checker.getContextualType(fn)!), fn)) : null;
		if (whole && whole.rest < 0 && whole.params.length === slot!.getParameters().length) return whole.params.slice(fn.parameters.length).map((p) => p.replace(/^@escaping /, ''));
		return slot!
			.getParameters()
			.filter((p) => !(p.valueDeclaration && ts.isParameter(p.valueDeclaration) && p.valueDeclaration.dotDotDotToken))
			.slice(fn.parameters.length)
			.map((p) => {
				const pt = this.type(this.checker.getTypeOfSymbolAtLocation(p, fn), fn);
				const optional = p.valueDeclaration && ts.isParameter(p.valueDeclaration) && (p.valueDeclaration.questionToken || p.valueDeclaration.initializer);
				return optional ? optionalType(pt) : pt;
			});
	},
};
