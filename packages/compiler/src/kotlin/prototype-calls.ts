// Calls of prototype methods as Kotlin: a program's, a built-in's and the kit's, bound calls and a plugin's.
import ts from 'typescript';
import { isLibGlobal } from '../semantics/globals.ts';
import { cast, functionTypeParts, ident, isFunctionType, isNullable, kotlinString, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { aliasedPrototypeMember } from '../semantics/lang.ts';
import { isLibDeclaration, nonVirtualName, implementationOf } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { programBase, declaringMethod } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const prototypeCallsMethods = {
	/**
	 * `X.prototype.m.call(r, …)` and `X.prototype.m.apply(r, [ … ])` of a class the program declares: `m` called on `r`
	 * as an `X`. A compiled class keeps its methods on the class, not on its prototype object.
	 */
	prototypeMethodCall(this: Translator, e: ts.CallExpression): string | null {
		const callee = e.expression;
		if (!ts.isPropertyAccessExpression(callee) || !['call', 'apply'].includes(callee.name.text) || !e.arguments.length) return null;
		const method = aliasedPrototypeMember(callee.expression, this.checker) ?? callee.expression;
		if (!ts.isPropertyAccessExpression(method) || !ts.isPropertyAccessExpression(method.expression) || method.expression.name.text !== 'prototype') return null;
		const builtin = this.builtinPrototypeCall(e, callee.name.text, method.expression.expression, method.name.text);
		if (builtin) return builtin;
		const cls = this.resolve(method.expression.expression)?.valueDeclaration;
		if (!cls || !ts.isClassDeclaration(cls)) return null;
		const rest = callee.name.text === 'call' ? e.arguments.slice(1) : e.arguments[1] && ts.isArrayLiteralExpression(e.arguments[1]) && !e.arguments[1].elements.some(ts.isSpreadElement) ? [...e.arguments[1].elements] : e.arguments.length === 1 ? [] : null;
		if (cls.getSourceFile().isDeclarationFile) return rest && this.kitPrototypeCall(cls, method.name.text, e, rest);
		const decl = declaringMethod(cls, method.name.text, this.checker);
		const restAt = decl ? decl.parameters.findIndex((p) => p.dotDotDotToken) : -1;
		const fixed = rest && restAt >= 0 ? rest.slice(0, restAt) : rest;
		if (!decl || !rest || !fixed || fixed.length > decl.parameters.length) return null;
		const receiver = this.coerce(e.arguments[0], 'Any?');
		const args = fixed.map((a, k) => this.coerce(a, this.paramType(decl.parameters[k])));
		// Parameters left out are undefined: Kotlin's defaults for the trailing ones that declare one, null up to them.
		const left = decl.parameters.slice(fixed.length, restAt >= 0 ? restAt : undefined);
		for (const p of left.slice(0, left.findLastIndex((x) => !x.initializer && !x.questionToken) + 1)) {
			if (p.initializer || !isNullable(this.paramType(p))) throw this.error(e, `${callee.name.text} of ${cls.name?.text}.prototype.${method.name.text} leaving out \`${p.name.getText()}\`, which can't hold undefined`);
			args.push('null');
		}
		if (restAt >= 0) args.push(this.packed(rest.slice(restAt), this.typeOf(decl.parameters[restAt].name)));
		const owner = decl.parent as ts.ClassDeclaration;
		const name = this.nonVirtualEntry(decl) ? ident(nonVirtualName(method.name.text, owner.name!.text)) : this.methodIdent(method.name.text);
		return `${this.checkedCast(receiver, this.className(owner))}.${name}(${args.join(', ')})`;
	},

	/**
	 * `Array.prototype.slice.call(list, 1)`: a built-in's method called on another value, as that value's own method of the
	 * name.
	 */
	builtinPrototypeCall(this: Translator, e: ts.CallExpression, how: string, owner: ts.Expression, name: string): string | null {
		if (!ts.isIdentifier(owner) || !['Array', 'String', 'Number', 'Boolean'].includes(owner.text) || !isLibGlobal(this, owner)) return null;
		const [thisArg, ...rest] = e.arguments;
		const each = (xs: readonly ts.Expression[]) => xs.map((x) => `, ${this.coerce(x, 'Any?')}`).join('');
		const spread = (list: string) => `, *${list}.storage.toTypedArray()`;
		const list = how === 'call' ? (rest.some(ts.isSpreadElement) ? spread(this.packed(rest, 'JSArray<Any?>')) : each(rest)) : !rest.length ? '' : ts.isArrayLiteralExpression(rest[0]) && !rest[0].elements.some(ts.isSpreadElement) ? each(rest[0].elements) : spread(this.coerce(rest[0], 'JSArray<Any?>'));
		const code = `${owner.text === 'Array' && this.arrayPrototypeGeneric(name) ? RT.jsArrayPrototypeCall : RT.jsCallMethod}(${thisArg ? this.coerce(thisArg, 'Any?') : 'null'}, ${kotlinString(name)}${list})`;
		const t = this.typeOf(e);
		return isUntyped(spelledType(t)) || t === 'Unit' ? code : this.fromAnyCode(code, t, true);
	},

	/**
	 * `KitClass.prototype.m.call(obj, …)` of a kit class: its final copy of `m` where the kit has one, and `super.m` for
	 * `this` where neither the kit nor a program class between overrides it.
	 */
	kitPrototypeCall(this: Translator, cls: ts.ClassDeclaration, name: string, e: ts.CallExpression, rest: ts.Expression[]): string | null {
		const kit = cls.name && this.core?.has(cls.name.text) ? cls.name.text : null;
		const thisArg = e.arguments[0];
		if (!kit || !this.core) return null;
		const plain = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(x) || (ts.isPropertyAccessExpression(x) ? plain(x.expression) : this.pure(x));
		const isInstance = plain(thisArg) && this.checker.isTypeAssignableTo(this.checker.getTypeAtLocation(thisArg), this.checker.getDeclaredTypeOfSymbol(this.resolve(cls.name!)!));
		const target = ts.isPropertyAccessExpression(e.expression) ? e.expression.expression : undefined;
		const member = target && this.checker.getSymbolAtLocation((target as ts.PropertyAccessExpression).name);
		const params = member?.valueDeclaration && ts.isMethodDeclaration(member.valueDeclaration) ? member.valueDeclaration.parameters : undefined;
		if (isInstance && params && !params.some((p) => p.dotDotDotToken) && rest.length <= params.length && !rest.some(ts.isSpreadElement)) {
			const args = rest.map((a, k) => this.coerce(a, this.paramType(params[k])));
			const entry = this.core.nonVirtualEntry(kit, name);
			if (entry) return `${this.expr(thisArg)}.${ident(entry)}(${args.join(', ')})`;
			const host = thisArg.kind === ts.SyntaxKind.ThisKeyword ? ts.findAncestor(e, (n) => ts.isClassLike(n) || (ts.isFunctionLike(n) && !ts.isArrowFunction(n) && !ts.isMethodDeclaration(n) && !ts.isConstructorDeclaration(n) && !ts.isAccessor(n))) : undefined;
			if (host && ts.isClassLike(host) && this.core.kitMember(kit, name)) {
				let between = false;
				for (let b = programBase(host, this.checker); b; b = programBase(b, this.checker)) if (b.members.some((x) => !isStatic(x) && x.name?.getText() === name)) between = true;
				if (!between) return `super.${this.methodIdent(name)}(${args.join(', ')})`;
			}
		}
		throw this.error(e, `${ts.isPropertyAccessExpression(e.expression) ? e.expression.name.text : 'call'} of ${cls.name?.text}.prototype.${name} on an object whose class may override it`);
	},

	/**
	 * `f.call(thisArg, …)`, `f.bind(thisArg)` of a typed function: one declaring `this` takes it as its first
	 * parameter; any other ignores it, as an arrow function does.
	 */
	boundCall(this: Translator, method: string, target: ts.Expression, e: ts.CallExpression): string | null {
		const member = this.checker.getSymbolAtLocation((e.expression as ts.PropertyAccessExpression).name);
		if (!member?.declarations?.every(isLibDeclaration)) return null;
		const sig = this.checker.getTypeAtLocation(target).getCallSignatures()[0];
		const declared = this.declaredTypeOf(target) ?? this.typeOf(target);
		const parts = functionTypeParts(declared.replace(/^\((.*)\)\?$/, '$1'));
		if (!sig || !parts || e.arguments.some(ts.isSpreadElement)) return null;
		const self = (sig as ts.Signature & { thisParameter?: ts.Symbol }).thisParameter;
		const takesThis = !!self && this.type(this.checker.getTypeOfSymbolAtLocation(self, target), target) !== 'Unit';
		const fn = /\)\?$/.test(declared) ? `(${this.unasserted(this.expr(target))} ?: ${RT.jsCannotRead}(${kotlinString(method)}))` : this.expr(target);
		const [thisArg, ...rest] = e.arguments;
		const effectless = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(x) || (ts.isPropertyAccessExpression(x) && effectless(x.expression)) || this.pure(x);
		if (!takesThis && thisArg && !effectless(thisArg)) return null;
		const given = [...(takesThis ? [thisArg] : []), ...rest];
		if (method === 'bind') {
			if (!takesThis && !rest.length) return fn;
			const names = parts.params.map((_, k) => this.marks.pureCode(`__b${k}`));
			const fixed = given.map((a, k) => (a ? this.coerce(a, parts.params[k]) : 'null'));
			return `{ ${names
				.slice(given.length)
				.map((n, k) => `${n}: ${parts.params[given.length + k]}`)
				.join(', ')} -> ${fn}(${[...fixed, ...names.slice(given.length)].join(', ')}) }`;
		}
		const targetDecl = ts.isIdentifier(target) ? this.resolve(target)?.valueDeclaration : undefined;
		if (method === 'call' && targetDecl && !ts.isJSDocSignature(targetDecl) && ts.isFunctionLike(targetDecl) && this.readsArguments(targetDecl)) {
			const selfArg = takesThis ? [thisArg ? this.coerce(thisArg, parts.params[0]) : 'null'] : [];
			return `${fn}(${[...selfArg, this.packed(rest, 'JSArray<Any?>', this.restSlot(e, 'Any?'))].join(', ')})`;
		}
		const args = parts.params.map((t, k) => (given[k] ? this.coerce(given[k], t) : t.endsWith('?') ? 'null' : (this.zero(t) ?? 'null')));
		return `${fn}(${args.join(', ')})`;
	},

	/** A call of a plugin function Kotlin types more loosely (a generic result is `Any?`): the value as the call site's type. */
	fromPluginCall(this: Translator, e: ts.CallExpression, code: string): string {
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		code = this.lenientResult(e, code);
		if (!decl || ts.isJSDocSignature(decl)) return code;
		const site = this.typeOf(e);
		// An overload's call, where Kotlin's one function gives what the implementation returns (`getWindows`'s `WindowBase[]` for `NativeWindow[]`).
		const impl = implementationOf(decl as ts.SignatureDeclaration);
		const made = impl && impl !== decl ? this.returnTypeOf(impl) : null;
		const overloaded = !!made && made.replace(/\?$/, '') !== site.replace(/\?$/, '') && site !== 'Unit' && !isUntyped(spelledType(site)) && made !== 'Unit';
		const fromOverload = () => (isUntyped(spelledType(made)) ? this.fromAnyCode(code, site, true) : cast(code, this.isAsserted(code) || (!this.library && !isNullable(made!)) ? site : optionalType(site)));
		if (!this.pluginFiles.has(decl.getSourceFile().fileName)) return overloaded && !this.library ? fromOverload() : code;
		const declared = this.returnTypeOf(decl as ts.SignatureDeclaration);
		if (isUntyped(spelledType(declared)) && !isUntyped(spelledType(site)) && site !== 'Unit') return this.fromAnyCode(code, site, true);
		if (overloaded) return fromOverload();
		// A generic function's result, its type parameters erased (`makeParser<T>` gives `(Any?) -> Any?`): what this call instantiates.
		const generic = !!(decl as ts.SignatureDeclaration).typeParameters?.length && declared !== site && site !== 'Unit' && !isUntyped(spelledType(site)) && declared.includes('Any?');
		return generic && (isFunctionType(declared.replace(/^\((.*)\)\?$/, '$1')) || /^JS\w+</.test(declared)) ? cast(code, site) : code;
	},
};
