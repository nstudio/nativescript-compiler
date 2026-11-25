// Methods as values in Swift: types that hold methods, forwarding and `this` functions.
import ts from 'typescript';
import { ident, isMethodValue, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { forwardedSetter, methodValues } from '../semantics/lang.ts';
import { thisNodes, declaresThis } from '../semantics/ast.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { isStatic } from '../semantics/throws.ts';

export const methodValuesMethods = {
	/**
	 * Library mode: a field that holds functions reading the `this` they are called
	 * with (`this.set = function (this: T, value) { … }`, as core's Property does) holds
	 * method values, untyped: script calls them with a receiver (`prop.set.call(view, v)`).
	 */
	holdsMethods(this: Translator, n: ts.Node): boolean {
		const target = ts.isPropertyAccessExpression(n) ? n.name : ts.isPropertyDeclaration(n) ? n.name : n;
		const decl = ts.isPropertyDeclaration(n) ? n : this.checker.getSymbolAtLocation(target)?.valueDeclaration;
		if (!decl || !ts.isPropertyDeclaration(decl) || !ts.isClassLike(decl.parent)) return false;
		let found = this.methodValued.get(decl);
		if (found !== undefined) return found;
		found = false;
		this.methodValued.set(decl, false);
		const name = decl.name.getText();
		const visit = (x: ts.Node) => {
			if (found) return;
			if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(x.left) && x.left.expression.kind === ts.SyntaxKind.ThisKeyword && x.left.name.text === name && this.carriesMethod(x.right)) found = true;
			ts.forEachChild(x, visit);
		};
		visit(decl.parent);
		this.methodValued.set(decl, found);
		return found;
	},

	/**
	 * Library mode: an expression whose value is a method value — a function
	 * expression reading `this`, a field holding them, a variable or a call of a
	 * local function that gives one.
	 */
	carriesMethod(this: Translator, n: ts.Node): boolean {
		if (!methodValues(this, n)) return false;
		while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
		if (ts.isFunctionExpression(n)) return isMethodValue(n);
		if (ts.isPropertyAccessExpression(n) || ts.isPropertyDeclaration(n)) return this.holdsMethods(n);
		const known = this.methodCarried.get(n);
		if (known !== undefined) return known;
		this.methodCarried.set(n, false);
		let found = false;
		if (ts.isIdentifier(n) && this.thisFunction(n)) found = true;
		else if (ts.isIdentifier(n) || ts.isVariableDeclaration(n)) {
			const decl = ts.isVariableDeclaration(n) ? n : this.resolve(n)?.valueDeclaration;
			found = !!decl && ts.isVariableDeclaration(decl) && !decl.type && !!decl.initializer && this.carriesMethod(decl.initializer);
		} else if (ts.isCallExpression(n)) {
			const fn = this.localFunction(n.expression);
			found = !!fn && this.returnsMethod(fn);
		}
		this.methodCarried.set(n, found);
		return found;
	},

	/** A function of the program's own, by the name or variable it is called through. */
	localFunction(this: Translator, e: ts.Expression): ts.FunctionLikeDeclaration | null {
		const decl = ts.isIdentifier(e) ? this.resolve(e)?.valueDeclaration : undefined;
		if (decl && ts.isFunctionDeclaration(decl)) return decl;
		const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
		return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
	},

	/** Whether static accessors only read and write the static field a base class declares under their name. */
	forwardsToBaseStatic(this: Translator, cls: ts.ClassLikeDeclaration, name: string, a: { get?: ts.GetAccessorDeclaration; set?: ts.SetAccessorDeclaration }): boolean {
		const field = (() => {
			for (let b = this.sourceBase(cls); b; b = this.sourceBase(b)) {
				const f = b.members.find((m) => ts.isPropertyDeclaration(m) && isStatic(m) && m.name.getText() === name);
				if (f) return b;
			}
			return null;
		})();
		if (!field || !field.name) return false;
		const target = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === name && ts.isIdentifier(e.expression) && this.resolve(e.expression)?.valueDeclaration === field;
		const get = a.get?.body?.statements;
		const getOk = !!get && get.length === 1 && ts.isReturnStatement(get[0]) && !!get[0].expression && target(get[0].expression);
		const set = a.set?.body?.statements;
		const p = a.set?.parameters[0]?.name;
		const setOk = !a.set || (!!set && set.length === 1 && ts.isExpressionStatement(set[0]) && ts.isBinaryExpression(set[0].expression) && set[0].expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && target(set[0].expression.left) && !!p && ts.isIdentifier(p) && ts.isIdentifier(set[0].expression.right) && set[0].expression.right.text === p.text);
		return getOk && setOk;
	},

	/**
	 * A property descriptor's setter that only forwards its value (`set(value) { this.style.flexGrow = value; }`),
	 * as a method value passing on what script gave it: a string the style's converter parses goes on as it is.
	 */
	forwardingSetter(this: Translator, fn: ts.FunctionLikeDeclaration): string | null {
		const forward = ts.isMethodDeclaration(fn) && fn.name.getText() !== 'set' ? null : forwardedSetter(fn);
		if (!forward || (!ts.isObjectLiteralExpression(fn.parent) && !ts.isPropertyAssignment(fn.parent))) return null;
		const target = this.withThis(fn, '__this', true, () => this.expr(forward.expression));
		return `({ (__this: Any?, __a: [Any?]) throws -> Any? in try ${RT.jsSet}(${target}, ${swiftString(forward.name.text)}, ${RT.jsArg}(__a, 0)); return nil } as JSMethod)`;
	},

	/** A function declaration with a `this` parameter, named as a value rather than called. */
	thisFunction(this: Translator, e: ts.Identifier): ts.FunctionDeclaration | null {
		if (ts.isCallExpression(e.parent) && e.parent.expression === e) return null;
		const decl = this.resolve(e)?.valueDeclaration;
		return decl && ts.isFunctionDeclaration(decl) && decl.body && this.takesThis(decl) ? decl : null;
	},

	/** Whether a function returns method values. */
	returnsMethod(this: Translator, fn: ts.FunctionLikeDeclaration): boolean {
		if (!methodValues(this, fn) || !fn.body) return false;
		if (!ts.isBlock(fn.body)) return this.carriesMethod(fn.body);
		let found = false;
		const visit = (x: ts.Node) => {
			if (found || (x !== fn && ts.isFunctionLike(x))) return;
			if (ts.isReturnStatement(x) && x.expression && this.carriesMethod(x.expression)) found = true;
			ts.forEachChild(x, visit);
		};
		ts.forEachChild(fn.body, visit);
		return found;
	},

	/** A function expression reading the `this` it is called with, as a method value (`JSMethod`) taking it. */
	methodValue(this: Translator, fn: ts.FunctionExpression): string {
		const forwarding = this.forwardingSetter(fn);
		if (forwarding) return forwarding;
		const params = fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
		const ret = this.returnTypeOf(fn);
		const localType = (p: ts.ParameterDeclaration) => (p.questionToken || (p.initializer && !this.templateParams) ? this.paramType(p) : this.states.mayBeNull(p) ? (this.lenient ? optionalType(this.typeOf(p.name)) : `${this.typeOf(p.name)}!`) : this.paramType(p));
		const selfType = declaresThis(fn) ? localType(fn.parameters[0]) : 'Any?';
		const selfBind = !isUntyped(spelledType(selfType)) ? [`let __self: ${selfType} = ${this.presentFromAny('__this', selfType.replace(/!$/, '?'), true, true)}`] : [];
		// A function reading `arguments` binds its parameters from them itself.
		const binds = [
			...selfBind,
			...(this.readsArguments(fn)
				? ['let __arguments = JSArray<Any?>(__a)']
				: params.map((p, k) => {
						const t = localType(p);
						// A rest parameter takes the arguments from its position on.
						const read = this.throwingConverts(() => this.presentFromAnyValue(`${RT.jsArg}(__a, ${k})`, t.replace(/!$/, '?'), true, true));
						const value = p.dotDotDotToken ? `${t}(__a.dropFirst(${k}).map { ${this.fromAnyCode('$0', t.replace(/^JSArray<(.*)>$/, '$1'), true)} })` : read.throws && read.mark?.op !== 'try' ? `try ${read.code}` : read.code;
						return `let ${ident((p.name as ts.Identifier).text)}: ${t} = ${value}`;
					})),
		];
		const body = this.withThis(fn, !isUntyped(spelledType(selfType)) ? '__self' : '__this', isUntyped(spelledType(selfType)), () => this.functionBody(fn, ret, this.indent + '    '));
		const call = this.marks.tryCode(`{ () throws -> ${ret} in${body.slice(1)}()`);
		const result = ret === 'Void' ? `${call}; return nil` : `return ${this.convert(call, ret, 'Any?')}`;
		return `({ (__this: Any?, __a: [Any?]) throws -> Any? in ${binds.join('; ')}${binds.length ? '; ' : ''}${result} } as JSMethod)`;
	},

	/** Runs `body` with `this` in `fn` (and in the arrow functions inside it) read as `name`. */
	withThis<T>(this: Translator, fn: ts.Node, name: string, untyped: boolean, body: () => T): T {
		const nodes = thisNodes(fn);
		for (const n of nodes) {
			this.subst.set(n, name);
			if (untyped) this.untypedThis.add(n);
		}
		try {
			return body();
		} finally {
			for (const n of nodes) {
				this.subst.delete(n);
				this.untypedThis.delete(n);
			}
		}
	},
};
