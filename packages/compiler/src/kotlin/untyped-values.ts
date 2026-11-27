// Values Kotlin holds untyped: this-values, untyped methods and functions, and module values.
import ts from 'typescript';
import { declOf, ident, isFunctionType, isThisParameter, jsObjectCode, kotlinString, lambda, returnsNull, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { inferredFunctionName, methodValues } from '../semantics/lang.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { isLibDeclaration, thisNodes, takesOwnThis } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';

export const untypedValuesMethods = {
	thisMethod(this: Translator, fn: ts.FunctionExpression): string {
		const self = fn.parameters.find((q) => isThisParameter(q) && (this.library ? !this.voidThis(q) : takesOwnThis(fn)));
		const params = fn.parameters.filter((q) => !isThisParameter(q));
		const ret = this.returnTypeOf(fn);
		// A string, number or boolean the body reads as one (`switch (value)`): its type's, as a missing argument reads.
		const bound = (q: ts.ParameterDeclaration) => (['String', 'Double', 'Boolean'].includes(this.typeOf(q.name)) && (this.library || !q.questionToken) ? this.typeOf(q.name) : this.paramType(q));
		const binds = params.map((q, k) => `val ${ident((q.name as ts.Identifier).text)}: ${bound(q)} = ${q.dotDotDotToken ? `JSArray(__a.drop(${k}).map { ${this.fromAnyCode('it', this.typeOf(q.name).replace(/^JSArray<(.*)>$/, '$1'), true)} }.toMutableList())` : this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), bound(q), true)}`);
		for (const q of params) {
			const sym = ts.isIdentifier(q.name) && !q.dotDotDotToken && bound(q) !== this.typeOf(q.name) ? this.checker.getSymbolAtLocation(q.name) : undefined;
			if (sym) this.nullableDecls.add(sym);
		}
		const thisType = self ? this.type(this.checker.getTypeAtLocation(self.name), self) : 'Any?';
		if (!isUntyped(spelledType(thisType))) binds.unshift(`val __this: ${thisType} = (__self as ${thisType})`);
		else binds.unshift('val __this: Any? = __self');
		const body = this.withThis(fn, '__this', isUntyped(spelledType(thisType)), () => this.functionBody(fn, ret, this.indent));
		const methodName = this.library ? '' : inferredFunctionName(fn);
		const ctor = methodName ? `JSMethod(${kotlinString(methodName)}, ${params.length})` : 'JSMethod';
		return `${ctor} ${lambda(['__self', '__a'], `${binds.map((b) => b + '; ').join('')}(fun()${ret === 'Unit' ? '' : `: ${ret}`} ${body})()`)}`;
	},

	/** Library mode: a function declared to return `string | null` (or a number or boolean): null kept, as callers test for it. */
	nullablePrimitiveReturn(this: Translator, fn: ts.Node | undefined): boolean {
		if (!fn || !(ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn) || ts.isGetAccessorDeclaration(fn)) || fn.getSourceFile().isDeclarationFile || !fn.type) return false;
		// An abstract method's declared union says what its overrides give.
		if (!fn.body && !ts.isUnionTypeNode(fn.type)) return false;
		// `getString(key, defaultValue?: string): string` returning the default it may not be given: undefined then.
		if (fn.type.kind === ts.SyntaxKind.StringKeyword) {
			const optional = new Set(fn.parameters.filter((p) => p.questionToken && !p.initializer && ts.isIdentifier(p.name)).map((p) => this.checker.getSymbolAtLocation(p.name)));
			let found = false;
			const visit = (n: ts.Node): void => {
				if (found || (ts.isFunctionLike(n) && n !== fn)) return;
				if (ts.isReturnStatement(n) && n.expression && ts.isIdentifier(n.expression) && optional.has(this.checker.getSymbolAtLocation(n.expression))) found = true;
				else ts.forEachChild(n, visit);
			};
			if (optional.size) ts.forEachChild(fn.body!, visit);
			return found;
		}
		// `isA11yEnabled(): boolean` that says `return undefined` while it knows nothing yet. Not a method, whose
		// overrides and supers must keep one return type.
		if (fn.type.kind === ts.SyntaxKind.BooleanKeyword || fn.type.kind === ts.SyntaxKind.NumberKeyword) return (ts.isFunctionDeclaration(fn) || this.onlyMethodOfName(fn)) && returnsNull(fn.body!);
		if (!ts.isUnionTypeNode(fn.type)) return false;
		const missing = (x: ts.TypeNode) => (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword) || x.kind === ts.SyntaxKind.UndefinedKeyword;
		const rest = fn.type.types.filter((x) => !missing(x));
		// `'dark' | 'light' | null`: the literals' primitive, as one keyword would be.
		const kind = (x: ts.TypeNode) => (!ts.isLiteralTypeNode(x) ? x.kind : ts.isStringLiteral(x.literal) ? ts.SyntaxKind.StringKeyword : ts.isNumericLiteral(x.literal) ? ts.SyntaxKind.NumberKeyword : x.literal.kind === ts.SyntaxKind.TrueKeyword || x.literal.kind === ts.SyntaxKind.FalseKeyword ? ts.SyntaxKind.BooleanKeyword : x.kind);
		const kinds = new Set(rest.map(kind));
		return rest.length < fn.type.types.length && kinds.size === 1 && [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword].includes([...kinds][0]);
	},

	/**
	 * Library mode: a function declared to give `T | null` (`notifyLaunch(): View | null`), which callers test with `=== null`
	 * apart from undefined: untyped, holding JavaScript's null apart from undefined, as Kotlin's null is only one of them.
	 */
	returnsNullApart(this: Translator, fn: ts.SignatureDeclaration): boolean {
		if (!(ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn)) || !fn.body || fn.getSourceFile().isDeclarationFile || !fn.type || !ts.isUnionTypeNode(fn.type)) return false;
		const parts = fn.type.types;
		return parts.some((x) => ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword) && parts.every((x) => (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword) || (ts.isTypeReferenceNode(x) && ts.isIdentifier(x.typeName)));
	},
	/**
	 * Library mode: fields of a Java class that code also gives an object of an unrelated Java class, asserted
	 * (`this._simpleGestureDetector = <any>new GestureDetectorCompat(…)` of a `GestureDetector` field): untyped, their
	 * methods found on the object when called, as NativeScript's runtime finds them.
	 */
	untypedJavaFields(this: Translator): Set<ts.Node> {
		if (this.untypedJavaFieldSet) return this.untypedJavaFieldSet;
		const out = new Set<ts.Node>();
		this.untypedJavaFieldSet = out;
		const shared = this.native && 'sharedClassType' in this.native ? (parts: ts.Type[]) => (this.native as unknown as { sharedClassType(parts: ts.Type[]): string | null }).sharedClassType(parts) : null;
		if (!this.library || !shared) return out;
		for (const sf of this.sourceFiles) {
			if (sf.isDeclarationFile) continue;
			const visit = (n: ts.Node): void => {
				if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
					let right = n.right;
					while (ts.isBinaryExpression(right) && right.operatorToken.kind === ts.SyntaxKind.EqualsToken) right = right.right;
					while (ts.isParenthesizedExpression(right)) right = right.expression;
					const d = this.checker.getSymbolAtLocation(n.left.name)?.valueDeclaration;
					if (d && ts.isPropertyDeclaration(d) && !d.getSourceFile().isDeclarationFile && (ts.isAsExpression(right) || ts.isTypeAssertionExpression(right)) && right.type.kind === ts.SyntaxKind.AnyKeyword) {
						const declared = this.checker.getTypeAtLocation(d.name);
						const own = shared([declared]);
						const given = this.checker.getTypeAtLocation(right.expression);
						if (own && shared([given]) && shared([declared, given]) !== own) out.add(d);
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
		}
		return out;
	},

	/** `view['title'] as string`: a primitive asserted of an untyped object's member, which may be missing. */
	untypedAssertion(this: Translator, e: ts.Expression): boolean {
		if (!ts.isAsExpression(e) && !ts.isTypeAssertionExpression(e)) return false;
		let inner = e.expression;
		while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
		return (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) && !inner.questionDotToken && this.isAny(inner.expression) && ['String', 'Double', 'Boolean'].includes(this.typeOf(e));
	},

	/** A constant's initializer call, where the constant holds what the call gives (`const root = this.notifyLaunch()`). */
	untypedInitializer(this: Translator, n: ts.Identifier): ts.CallExpression | undefined {
		const d = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
		return d && ts.isVariableDeclaration(d) && !d.type && d.initializer && ts.isCallExpression(d.initializer) && d.parent.flags & ts.NodeFlags.Const ? d.initializer : undefined;
	},

	/** Whether a read is of a value `thisValues` holds untyped: such a field or variable, or a call giving one. */
	isThisValue(this: Translator, n: ts.Node): boolean {
		const { symbols, returning, functions } = this.thisValues();
		if (!symbols.size && !functions.size) return false;
		if (ts.isFunctionExpression(n)) return functions.has(n);
		if (ts.isCallExpression(n)) {
			const callee = ts.isIdentifier(n.expression) ? this.checker.getSymbolAtLocation(n.expression) : undefined;
			return (!!callee && symbols.has(declOf(callee)!)) || [...(callee?.declarations ?? [])].some((d) => returning.has(d) || (ts.isVariableDeclaration(d) && !!d.initializer && returning.has(d.initializer)));
		}
		const sym = ts.isIdentifier(n) ? this.checker.getSymbolAtLocation(n) : ts.isPropertyAccessExpression(n) ? this.checker.getSymbolAtLocation(n.name) : undefined;
		// A member of a union of classes is each class's.
		return !!sym && (symbols.has(declOf(sym)) || !!sym.declarations?.some((d) => symbols.has(d)));
	},
	/**
	 * Library mode: function-typed fields given functions that take a `this` their declared type omits (`this.set =
	 * function (this: T, value) { … }`), with the variables and functions those values pass through. Each is untyped in
	 * Kotlin, holding a JSMethod.
	 */
	thisValues(this: Translator): { symbols: Set<ts.Node | undefined>; functions: Set<ts.Node>; returning: Set<ts.Node> } {
		if (this.thisValueSets) return this.thisValueSets;
		const sets = { symbols: new Set<ts.Node | undefined>(), functions: new Set<ts.Node>(), returning: new Set<ts.Node>() };
		this.thisValueSets = sets;
		if (!this.library && !this.pluginFiles.size) return sets;
		const c = this.checker;
		// By declaration: a generic class's member read through `this` is a symbol of its own.
		const assigned = new Map<ts.Node, ts.Expression[]>();
		const fields: ts.Node[] = [];
		const prototypeValues: ts.Expression[] = [];
		const symbolOf = (e: ts.Node) => declOf(ts.isIdentifier(e) ? c.getSymbolAtLocation(e) : ts.isPropertyAccessExpression(e) ? c.getSymbolAtLocation(e.name) : undefined);
		const add = (d: ts.Node | undefined, e: ts.Expression) => {
			if (d) (assigned.get(d) ?? assigned.set(d, []).get(d)!).push(e);
		};
		const pluginFunctions: ts.FunctionDeclaration[] = [];
		for (const sf of this.sourceFiles) {
			if (sf.isDeclarationFile || !methodValues(this, sf)) continue;
			const visit = (n: ts.Node): void => {
				if (!this.library && ts.isFunctionDeclaration(n) && n.body) pluginFunctions.push(n);
				if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) add(symbolOf(n.left), n.right);
				// A prototype's method given as a value (`View.prototype[prop.setNative] = makeNativeSetter(…)`), called with the instance as `this`.
				if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isElementAccessExpression(n.left) || ts.isPropertyAccessExpression(n.left)) && ts.isPropertyAccessExpression(n.left.expression) && n.left.expression.name.text === 'prototype') prototypeValues.push(n.right);
				if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) add(n, n.initializer);
				if (ts.isPropertyDeclaration(n) && !isStatic(n) && ts.isClassLike(n.parent) && c.getTypeAtLocation(n.name).getCallSignatures().length) fields.push(n);
				ts.forEachChild(n, visit);
			};
			visit(sf);
		}
		const known = new Map<ts.Node, boolean>();
		const returnsOf = (f: ts.FunctionLikeDeclaration): ts.Expression[] => {
			if (!f.body) return [];
			if (!ts.isBlock(f.body)) return [f.body];
			const out: ts.Expression[] = [];
			const visit = (n: ts.Node): void => {
				if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
				if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
			};
			ts.forEachChild(f.body, visit);
			return out;
		};
		const binds = (e: ts.Expression): boolean => {
			while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
			const seen = known.get(e);
			if (seen !== undefined) return seen;
			known.set(e, false);
			const result = bindsOnce(e);
			known.set(e, result);
			return result;
		};
		const bindsOnce = (e: ts.Expression): boolean => {
			if (ts.isFunctionExpression(e)) {
				const takes = e.parameters.some((q) => isThisParameter(q) && !this.voidThis(q)) || thisNodes(e).length > 0;
				if (takes) sets.functions.add(e);
				return takes;
			}
			if (ts.isConditionalExpression(e)) return [binds(e.whenTrue), binds(e.whenFalse)].some(Boolean);
			if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
				const sym = c.getSymbolAtLocation(e.expression);
				const d = sym?.valueDeclaration;
				const f = d && ts.isFunctionDeclaration(d) ? d : d && ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : undefined;
				if (!f || f.getSourceFile().isDeclarationFile) return false;
				const gives = returnsOf(f).map(binds).some(Boolean);
				if (gives) {
					sets.returning.add(f);
					if (d && ts.isVariableDeclaration(d)) sets.symbols.add(d);
				}
				return gives;
			}
			const sym = ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? symbolOf(e) : undefined;
			if (!sym) return false;
			if (sets.symbols.has(sym)) return true;
			const gives = (assigned.get(sym) ?? []).map(binds).some(Boolean);
			if (gives) sets.symbols.add(sym);
			return gives;
		};
		for (const f of fields) if ((assigned.get(f) ?? []).map(binds).some(Boolean)) sets.symbols.add(f);
		for (const v of prototypeValues) binds(v);
		// A plugin's code is not strict: a function expression reading `this` there is a method value wherever it goes.
		for (const f of pluginFunctions) if (returnsOf(f).map(binds).some(Boolean)) sets.returning.add(f);
		if (!this.library) for (const [d, values] of assigned) if (ts.isVariableDeclaration(d) && values.map(binds).some(Boolean)) sets.symbols.add(d);
		// A library method held as a value (`const toString = {}.toString`), which script calls with `.call(x)`.
		for (const [d, values] of assigned) {
			if (!ts.isVariableDeclaration(d)) continue;
			if (
				values.some((v) => {
					while (ts.isParenthesizedExpression(v)) v = v.expression;
					const sym = ts.isPropertyAccessExpression(v) ? c.getSymbolAtLocation(v.name) : undefined;
					return !!sym && !!(sym.flags & ts.SymbolFlags.Method) && isLibDeclaration(sym.declarations?.[0]);
				})
			)
				sets.symbols.add(d);
		}
		// What reads one of them (`const setBase = this.set`) holds it as well.
		for (let grew = true; grew;) {
			grew = false;
			for (const [sym, values] of assigned) {
				if (sets.symbols.has(sym) || sym.getSourceFile().isDeclarationFile) continue;
				if (
					values.some((v) => {
						const s = symbolOf(v);
						return !!s && sets.symbols.has(s);
					})
				) {
					sets.symbols.add(sym);
					grew = true;
				}
			}
		}
		return sets;
	},

	/** A method of an untyped object literal: a function value, or one taking `this` when its body reads it. */
	untypedMethod(this: Translator, p: ts.MethodDeclaration): string {
		const rest = p.parameters.some((q) => q.dotDotDotToken);
		if (!thisNodes(p).length && !rest) {
			// Called untyped (an options object's `valueChanged`), with undefined where a number, string or boolean goes, and
			// an app's object, or null where it may be one, as the script value it is.
			const types = p.parameters.map((q) => this.paramType(q));
			const kit = this.library || this.pluginFiles.has(p.getSourceFile().fileName);
			const converted = (t: string) => (kit ? ['Double', 'Boolean', 'String'].includes(t) : !isUntyped(spelledType(t)) && (this.isObjectType(t) || /^(Double|Boolean|String)\?$/.test(t)) && !isFunctionType(t));
			if (!types.some(converted) || p.parameters.some((q) => isThisParameter(q) || !ts.isIdentifier(q.name))) return this.closure(p);
			const ret = this.returnTypeOf(p);
			const names = types.map((_, k) => this.marks.pureCode(`__u${k}`));
			const call = `__f(${types.map((t, k) => (isUntyped(spelledType(t)) ? names[k] : this.fromAnyCode(names[k], t, true))).join(', ')})`;
			return `run { val __f = ${this.closure(p, `(${types.join(', ')}) -> ${ret}`)}; { ${names.map((n) => `${n}: Any?`).join(', ')} -> ${ret === 'Unit' ? `${call}; Unit` : call} } }`;
		}
		const ret = this.returnTypeOf(p);
		const binds = p.parameters.filter((q) => !isThisParameter(q)).map((q, k) => `val ${ident((q.name as ts.Identifier).text)}: ${this.typeOf(q.name)} = ${q.dotDotDotToken ? `JSArray(__a.drop(${k}).map { ${this.fromAnyCode('it', this.typeOf(q.name).replace(/^JSArray<(.*)>$/, '$1'), true)} }.toMutableList())` : this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), this.typeOf(q.name), true)}`);
		const body = this.withThis(p, '__this', true, () => this.functionBody(p, ret, this.indent));
		return `JSMethod ${lambda(['__this', '__a'], `${binds.map((b) => b + '; ').join('')}(fun()${ret === 'Unit' ? '' : `: ${ret}`} ${body})()`)}`;
	},

	/** A function of the program called with untyped arguments (`fn.length` its required parameters), each read as it types it. */
	untypedFunction(this: Translator, decl: ts.FunctionDeclaration, name: string, keyed = true): string {
		// A generic function's type parameters, those its declaration keeps (`generics`), are whatever script passes.
		const kept = this.pluginFiles.has(decl.getSourceFile().fileName) ? [] : (decl.typeParameters ?? []).filter((p) => !this.erasesTypeParameter(p));
		const generic = kept.length ? `<${kept.map((p) => (!this.library && this.classConstraint(p) ? this.type(this.checker.getTypeFromTypeNode(p.constraint!), p).replace(/\?$/, '') : 'Any?')).join(', ')}>` : '';
		// One reading `arguments` takes them all (`__arguments`).
		const argOf = (q: ts.ParameterDeclaration, k: number) => {
			if (q.dotDotDotToken) return `JSArray(__a.drop(${k}).map { ${generic ? `${RT.jsUnchecked}(it)` : this.fromAnyCode('it', this.typeOf(q.name).replace(/^JSArray<(.*)>$/, '$1'), true)} }.toMutableList())`;
			const raw = generic ? `${RT.jsUnchecked}(__a.getOrNull(${k}))` : this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), this.paramType(q), true);
			return this.constantDefault(q) ? `if (__a.getOrNull(${k}) == null) ${this.stored(q.initializer!, q, this.paramType(q))} else ${raw}` : raw;
		};
		const args = this.readsArguments(decl) ? ['JSArray<Any?>(__a.toMutableList())'] : decl.parameters.map(argOf);
		const arity = decl.parameters.findIndex((q) => !!q.questionToken || !!q.initializer || !!q.dotDotDotToken);
		if (this.implicitThis(decl)) return `JSMethod(${arity < 0 ? decl.parameters.length : arity}) ${lambda(['__self', '__a'], `${name}${generic}(${['__self', ...args].join(', ')})${this.returnTypeOf(decl) === 'Unit' ? '; null' : ''}`)}`;
		// A reference (`(::f)`) takes no type arguments; the function's name does.
		const callee = generic ? name.replace(/^\((\S*)::([\w`]+)\)$/, (_, recv: string, fn: string) => (recv ? `${recv}.${fn}` : fn)) : name;
		const call = `${callee}${generic}(${args.join(', ')})`;
		// The function's own reference keys what script sets on it, as each wrapper is made where it is read.
		const original =
			generic || !keyed
				? undefined
				: (/^\((\S*::[\w`]+)\)$/.exec(name)?.[1] ??
					/^(?:([\w`.]+)\.)?([\w`]+)$/
						.exec(name)
						?.slice(1)
						.map((x) => x ?? '')
						.join('::'));
		const packs = this.readsArguments(decl) || decl.parameters.some((q) => !!q.dotDotDotToken);
		return `${RT.jsFunction}(${arity < 0 ? decl.parameters.length : arity}${original ? `, ${original}${packs ? ', true' : ''}` : ''}) ${lambda(['__a'], this.returnTypeOf(decl) === 'Unit' ? `${call}; null` : call)}`;
	},

	/** A module's exports as script's namespace object holds them: functions callable with untyped arguments, variables as they are now, classes. */
	moduleValue(this: Translator, at: ts.Identifier, mod: ts.Symbol): string {
		const entries: [string, string][] = [];
		for (const ex of this.checker.getExportsOfModule(mod)) {
			const target = ex.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(ex) : ex;
			const decl = target.valueDeclaration;
			if (!decl || decl.getSourceFile().isDeclarationFile) continue;
			const name = () => this.qualifiedDecl(decl, target.name) ?? this.unshadowed(at, decl, ident(this.topName(decl, target.name)));
			let value: string;
			if (ts.isFunctionDeclaration(decl) && decl.body && !decl.parameters.some((q) => q.dotDotDotToken || isThisParameter(q))) value = this.untypedFunction(decl, name());
			else if (ts.isVariableDeclaration(decl)) value = this.convert(name(), this.declaredTypeOf(decl.name as ts.Identifier) ?? this.typeOf(decl.name as ts.Identifier), 'Any?');
			else if (ts.isClassDeclaration(decl) && decl.name) value = `${this.className(decl)}::class.java`;
			else continue;
			entries.push([kotlinString(ex.name), value]);
		}
		return jsObjectCode(entries);
	},
};
