// Calls of prototype methods as Swift: a program's, a built-in's and the kit's, and a function's own methods (`call`, `apply`, `bind`).
import ts from 'typescript';
import { isLibGlobal } from '../semantics/globals.ts';
import { functionParts, ident, isFunctionType, isOptional, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { nonVirtualName, thisNodes } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { declaringMethod } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { otherReceiverRefusal } from '../semantics/refuse-receivers.ts';

export const prototypeCallsMethods = {
	/** `X.prototype.m`, directly or through a constant holding it (`const has = Object.prototype.hasOwnProperty`): X and m. `{}.m` is Object's. */
	prototypeMethod(this: Translator, target: ts.Expression): { owner: ts.Expression; name: string; plainObject?: boolean } | null {
		let held = target;
		while (ts.isParenthesizedExpression(held) || ts.isNonNullExpression(held) || ts.isAsExpression(held)) held = held.expression;
		if (ts.isIdentifier(held)) {
			const d = this.resolve(held)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && d.parent.flags & ts.NodeFlags.Const && d.initializer) held = d.initializer;
		}
		if (ts.isPropertyAccessExpression(held) && ts.isObjectLiteralExpression(held.expression) && !held.expression.properties.length) return { owner: held.expression, name: held.name.text, plainObject: true };
		if (!ts.isPropertyAccessExpression(held) || !ts.isPropertyAccessExpression(held.expression) || held.expression.name.text !== 'prototype') return null;
		return { owner: held.expression.expression, name: held.name.text };
	},

	/**
	 * `Base.prototype.m.call(obj, …)` of the program's class: the receiver that calls Base's `m` in Swift. That is the object
	 * itself where no subclass overrides `m`, and `super` for `this` in a subclass whose superclasses below Base don't.
	 */
	classPrototypeReceiver(this: Translator, held: ts.Expression, thisArg: ts.Expression | undefined, e: ts.CallExpression, method: string): string | null {
		if (!ts.isPropertyAccessExpression(held)) return null;
		const found = this.prototypeMethod(held);
		const cls = found && this.resolve(found.owner)?.valueDeclaration;
		if (!found || !cls || !ts.isClassDeclaration(cls) || cls.getSourceFile().isDeclarationFile) return null;
		const name = found.name;
		const declares = (c: ts.ClassLikeDeclaration) => c.members.some((m) => !isStatic(m) && m.name?.getText() === name);
		const below = (c: ts.ClassLikeDeclaration) => {
			for (let b = this.sourceBase(c); b; b = this.sourceBase(b)) if (b === cls) return true;
			return false;
		};
		const overridden = [...this.facts.classes()].some((c) => c !== cls && below(c) && declares(c));
		const plain = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(x) || (ts.isPropertyAccessExpression(x) ? plain(x.expression) : this.pure(x));
		const typed = thisArg && this.classNamed(this.typeOf(thisArg).replace(/[?!]$/, ''));
		if (thisArg && plain(thisArg) && typed && (typed === cls || below(typed))) {
			const receiver = this.expr(thisArg).replace(/!$/, '');
			if (!overridden) return `${receiver}.${ident(name)}`;
			const entry = declaringMethod(cls, name, this.checker);
			if (entry && this.nonVirtualEntry(entry)) return `${receiver}.${ident(nonVirtualName(name, (entry.parent as ts.ClassLikeDeclaration).name!.text))}`;
		}
		throw this.error(e, `${method} of ${found.owner.getText()}.prototype.${name} on an object whose class may override it`);
	},

	/** `X.prototype.m` of a method of a class the program declares. */
	programPrototypeMethod(this: Translator, target: ts.Expression): ts.MethodDeclaration | undefined {
		const found = this.prototypeMethod(target);
		const cls = found && this.resolve(found.owner)?.valueDeclaration;
		return found && cls && ts.isClassDeclaration(cls) && !cls.getSourceFile().isDeclarationFile ? declaringMethod(cls, found.name, this.checker) : undefined;
	},

	/**
	 * `KitClass.prototype.m.call(obj, …)` of a kit class: its final copy of `m` where the kit has one, and `super.m` for
	 * `this` where neither the kit nor a program class between overrides it.
	 */
	kitPrototypeCall(this: Translator, held: ts.Expression, e: ts.CallExpression, method: string): string | null {
		const found = this.prototypeMethod(held);
		const cls = found && this.resolve(found.owner)?.valueDeclaration;
		if (!found || !cls || !ts.isClassDeclaration(cls) || !cls.getSourceFile().isDeclarationFile || !cls.name) return null;
		const kit = this.core.kitTypeName(cls.name.text);
		if (!kit || !this.core.kitMember(kit, found.name)) return null;
		const [thisArg, ...rest] = e.arguments;
		const args = method === 'call' ? rest : !rest.length ? [] : ts.isArrayLiteralExpression(rest[0]) ? [...rest[0].elements] : null;
		const plain = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(x) || (ts.isPropertyAccessExpression(x) ? plain(x.expression) : this.pure(x));
		const isInstance = !!thisArg && plain(thisArg) && this.checker.isTypeAssignableTo(this.checker.getTypeAtLocation(thisArg), this.checker.getDeclaredTypeOfSymbol(this.resolve(cls.name)!));
		if (method !== 'bind' && isInstance && args && !args.some(ts.isSpreadElement)) {
			const entry = this.core.nonVirtualEntry(kit, found.name);
			if (entry) return this.core.nonVirtualCall(e, this.expr(thisArg).replace(/!$/, ''), kit, entry, args);
			const host = thisArg.kind === ts.SyntaxKind.ThisKeyword ? ts.findAncestor(e, (n) => ts.isClassLike(n) || (ts.isFunctionLike(n) && !ts.isArrowFunction(n) && !ts.isMethodDeclaration(n) && !ts.isConstructorDeclaration(n) && !ts.isAccessor(n))) : undefined;
			if (host && ts.isClassLike(host)) {
				let between = false;
				for (let b = this.sourceBase(host); b; b = this.sourceBase(b)) if (b.members.some((x) => !isStatic(x) && x.name?.getText() === found.name)) between = true;
				if (!between) return this.core.nonVirtualCall(e, 'super', kit, found.name, args);
			}
		}
		throw this.error(e, `${method} of ${cls.name.text}.prototype.${found.name} on an object whose class may override it`);
	},

	/**
	 * `Object.prototype.hasOwnProperty.call(o, k)`, `Array.prototype.slice.call(list, 1)`: a built-in's method called on another
	 * value, as that value's own method of the name; Object's methods, which every object has, as the runtime's.
	 */
	builtinPrototypeCall(this: Translator, method: 'call' | 'apply', target: ts.Expression, e: ts.CallExpression): string | null {
		const found = this.prototypeMethod(target);
		const owner = found?.plainObject ? 'Object' : found && ts.isIdentifier(found.owner) && isLibGlobal(this, found.owner) ? found.owner.text : null;
		if (!found || !owner || !['Object', 'Array', 'String', 'Number', 'Boolean'].includes(owner)) return null;
		const [thisArg, ...rest] = e.arguments;
		const receiver = thisArg ? this.coerce(thisArg, 'Any?') : 'nil';
		let args: string[] | null;
		if (method === 'call') args = rest.some(ts.isSpreadElement) ? null : rest.map((x) => this.coerce(x, 'Any?'));
		else args = !rest.length ? [] : ts.isArrayLiteralExpression(rest[0]) && !rest[0].elements.some(ts.isSpreadElement) ? rest[0].elements.map((x) => this.coerce(x, 'Any?')) : null;
		const t = this.typeOf(e);
		const result = (code: string, type: string) => (type === t || t === 'Void' ? code : this.convert(code, type, t));
		if (owner === 'Object') {
			const first = method === 'call' ? rest[0] : rest[0] && ts.isArrayLiteralExpression(rest[0]) ? rest[0].elements[0] : undefined;
			const key = first ? this.propertyKey(first) : '"undefined"';
			switch (found.name) {
				case 'hasOwnProperty':
					return result(`${RT.jsHasOwn}(${receiver}, ${key})`, 'Bool');
				case 'propertyIsEnumerable':
					return result(`${RT.jsPropertyIsEnumerable}(${receiver}, ${key})`, 'Bool');
				case 'toString':
					return result(`${RT.jsObjectToString}(${receiver})`, 'String');
				default:
					return null;
			}
		}
		const list = args ? args.map((a) => `, ${a}`).join('') : `, spread: ${method === 'call' ? this.packed(rest, 'JSArray<Any?>') : this.coerce(rest[0], 'JSArray<Any?>')}.storage`;
		const code = `${owner === 'Array' && this.arrayPrototypeGeneric(found.name) ? RT.jsArrayPrototypeCall : RT.jsCallMethod}(${receiver}, ${swiftString(found.name)}${list})`;
		return isUntyped(spelledType(t)) || t === 'Void' ? code : this.fromAnyCode(code, t, true);
	},

	/**
	 * `f.call(thisArg, …)`, `f.apply(thisArg, [ … ])` and `f.bind(thisArg, …)` on a typed function value.
	 * A Swift closure has no `this` of its own, and a method reference is bound to its object already:
	 * the receiver must be that object, or the function one that reads no `this`.
	 */
	functionMethod(this: Translator, method: string, target: ts.Expression, e: ts.CallExpression): string {
		const [thisArg, ...rest] = e.arguments;
		// `const toString = {}.toString; toString.call(x)`: Object.prototype.toString of x.
		const init = ts.isIdentifier(target) ? this.resolve(target)?.valueDeclaration : undefined;
		const source = init && ts.isVariableDeclaration(init) && init.parent.flags & ts.NodeFlags.Const ? init.initializer : undefined;
		if (method === 'call' && source && ts.isPropertyAccessExpression(source) && source.name.text === 'toString' && ((ts.isObjectLiteralExpression(source.expression) && !source.expression.properties.length) || source.expression.getText() === 'Object.prototype')) {
			return `${RT.jsObjectToString}(${thisArg ? this.coerce(thisArg, 'Any?') : 'nil'})`;
		}
		// `const bind = Function.prototype.bind; bind.call(f, thisArg, …)` is `f.bind(thisArg, …)`.
		if (method === 'call' && thisArg && source && ts.isPropertyAccessExpression(source) && ['call', 'apply', 'bind'].includes(source.name.text) && source.expression.getText() === 'Function.prototype') {
			if (functionParts(this.typeOf(thisArg).replace(/^\((.*)\)[?!]$/, '$1'))) return this.functionMethod(source.name.text, thisArg, Object.create(e, { arguments: { value: ts.factory.createNodeArray(rest) } }));
			return this.convert(this.marks.tryCode(`${RT.jsCallMethod}(${[this.coerce(thisArg, 'Any?'), JSON.stringify(source.name.text), ...rest.map((x) => this.coerce(x, 'Any?'))].join(', ')})`), 'Any?', this.typeOf(e));
		}
		// A method taken from its object (`const f = obj.method`) stays bound to it in Swift: called with that object, it is the same call.
		if (source && ts.isPropertyAccessExpression(source) && !(thisArg && source.expression.getText() === thisArg.getText())) throw this.error(e, `${method} of a method taken from its object, with another receiver`);
		const plain = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(x) || (ts.isPropertyAccessExpression(x) ? plain(x.expression) : this.pure(x));
		let held: ts.Expression = target;
		// `(ctx.fillText as (text: string, x: number, y: number) => void).call(ctx, …)`: the method itself, with its own signature.
		while (ts.isParenthesizedExpression(held) || ts.isNonNullExpression(held) || ts.isAsExpression(held)) held = held.expression;
		const sym = ts.isPropertyAccessExpression(held) || ts.isIdentifier(held) ? this.resolve(ts.isPropertyAccessExpression(held) ? held.name : held) : undefined;
		const decl = sym?.declarations?.find((d): d is ts.MethodDeclaration | ts.FunctionDeclaration => (ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) && !!d.body) ?? sym?.valueDeclaration;
		const bound = !!decl && (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || (ts.isFunctionDeclaration(decl) && thisNodes(decl).length > 0));
		const kitCall = this.kitPrototypeCall(held, e, method);
		if (kitCall) return kitCall;
		const viaPrototype = this.classPrototypeReceiver(held, thisArg, e, method);
		if (viaPrototype) {
			if (method === 'bind') throw this.error(e, 'bind of a method read off a prototype');
		} else if (bound) {
			const receiver = ts.isPropertyAccessExpression(held) ? held.expression : null;
			if (!receiver || !thisArg || receiver.getText() !== thisArg.getText() || !plain(thisArg)) {
				const r = otherReceiverRefusal(e, method);
				throw this.error(r.node, r.what, r.id);
			}
		} else if (ts.isFunctionExpression(held) && thisNodes(held).length) throw this.error(e, `${method} of a function that reads this`);
		if (thisArg && !plain(thisArg)) throw this.error(thisArg, `${method} with a receiver that has side effects`);
		// A method or function of the program's own is referred to with the signature Swift emits it with (an override's is its root's).
		const own = decl && !decl.getSourceFile().isDeclarationFile && ((ts.isMethodDeclaration(decl) && ts.isClassLike(decl.parent)) || (ts.isFunctionDeclaration(decl) && !!decl.body)) ? (ts.isMethodDeclaration(decl) ? this.emittedSignature(decl) : this.signatureOf(decl)) : null;
		// Implicitly unwrapped in a signature, optional in a function type.
		const plainOpt = (t: string) => t.replace(/^\((.*)\)!$/, '($1)?').replace(/!$/, '?');
		const type = own ? `(${own.params.map((p) => (isFunctionType(p.type) && !p.type.startsWith('@escaping') ? `@escaping ${p.type}` : plainOpt(p.type))).join(', ')}) throws -> ${plainOpt(own.ret)}` : this.typeOf(target);
		const fn = functionParts(type.replace(/^\((.*)\)[?!]$/, '$1'))!;
		const optional = !own && (isOptional(type) || type.endsWith('!'));
		let items: readonly ts.Expression[] = rest;
		// A rest parameter (`(...args) => …`) takes the rest of the arguments, as an array.
		const signature = (decl && (ts.isMethodDeclaration(decl) || ts.isFunctionDeclaration(decl)) && decl.body ? this.checker.getSignatureFromDeclaration(decl) : undefined) ?? this.checker.getSignaturesOfType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)), ts.SignatureKind.Call)[0];
		const restAt = signature?.getParameters().findIndex((p) => !!p.valueDeclaration && ts.isParameter(p.valueDeclaration) && !!p.valueDeclaration.dotDotDotToken) ?? -1;
		if (method === 'apply') {
			if (rest.length && !ts.isArrayLiteralExpression(rest[0])) {
				// A list known only when it runs (`arguments`, a rest array): each parameter its element, undefined past its end.
				const list = this.fresh('__list');
				const f = isOptional(type) || type.endsWith('!') ? this.marks.unwrappedCode(this.expr(target)) : this.expr(target);
				const call = `${f}(${fn.params.map((p, k) => (k === restAt ? this.presentFromAny(`JSArray<Any?>(Array(${list}.storage.dropFirst(${k})))`, p.replace(/^@escaping /, '')) : this.presentFromAny(`${RT.jsArg}(${list}.storage, ${k})`, p.replace(/^@escaping /, ''), true))).join(', ')})`;
				return this.convert(`{ (${list}: JSArray<Any?>) throws -> ${fn.result} in try ${call} }(${this.coerce(rest[0], 'JSArray<Any?>')})`, fn.result, this.typeOf(e));
			}
			items = rest.length ? (rest[0] as ts.ArrayLiteralExpression).elements : [];
		}
		if (items.some((x, k) => ts.isSpreadElement(x) && (restAt < 0 || k < restAt || method === 'bind'))) throw this.error(e, `${method} with a spread argument`);
		if (restAt < 0 && items.length > fn.params.length && !items.slice(fn.params.length).every((x) => this.pure(x))) throw this.error(items[fn.params.length], 'an extra argument that has side effects');
		const param = (k: number) => fn.params[k].replace(/^@escaping /, '');
		const given = restAt >= 0 && restAt < fn.params.length && method !== 'bind' ? fn.params.map((_, k) => (k === restAt ? this.packed(items.slice(k), param(k).replace(/[?!]$/, '')) : items[k] ? this.coerce(items[k], param(k)) : 'nil')) : items.slice(0, fn.params.length).map((x, k) => this.coerce(x, param(k)));
		const f = viaPrototype ? viaPrototype : optional && !e.questionDotToken && !ts.isOptionalChain(e) ? this.marks.unwrappedCode(this.expr(target)) : this.expr(target);
		if (method !== 'bind') {
			// A parameter left out is undefined: NaN where lenient code holds a number, the type's zero where it holds another value.
			const missing = fn.params.slice(given.length).map((p) => (p === 'Void' ? '()' : isOptional(p) || isUntyped(spelledType(p)) ? 'nil' : p === 'Double' ? '.nan' : (this.zero(p.replace(/^@escaping /, '')) ?? 'nil')));
			return this.convert(`${f}${e.questionDotToken ? '?' : ''}(${[...given, ...missing].join(', ')})`, fn.result, this.typeOf(e));
		}
		const left = fn.params.slice(given.length);
		const result =
			left.length === fn.params.length
				? f
				: (() => {
						const captured = given.map((_, k) => `__b${k}`);
						const params = left.map((p, k) => `__p${k}: ${p.replace(/^@escaping /, '')}`);
						const inner = `{ (${params.join(', ')}) throws -> ${fn.result} in try __f(${[...captured, ...left.map((_, k) => `__p${k}`)].join(', ')}) }`;
						return `{ (__f: @escaping ${fn.text}${given.map((_, k) => `, __b${k}: ${param(k)}`).join('')}) -> (${left.join(', ')}) throws -> ${fn.result} in ${inner} }(${[f, ...given].join(', ')})`;
					})();
		const boundType = `(${left.join(', ')}) throws -> ${fn.result}`;
		return this.convert(result, boundType, this.typeOf(e));
	},
};
