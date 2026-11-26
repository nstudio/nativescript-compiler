// Functions as Kotlin: parameters, return types, generics, bodies, closures.
import ts from 'typescript';
import { resultSlot, returnCell } from '../semantics/placement.ts';
import type { ResultSlot } from '../semantics/placement.ts';
import { assignsTo, branch, functionTypeParts, ident, isFunctionType, isNullable, isThisParameter, jsObjectCode, kotlinString, mentions, nullishType, numberLiteral, optionalElementsType, optionalType, refersTo, returnsNull, splitTopLevel, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { boundNames, thisNodes, takesOwnThis } from '../semantics/ast.ts';
import { isAsync } from '../semantics/throws.ts';
import { isConstant, methodValues, thisArgBound } from '../semantics/lang.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { literalCallback } from '../semantics/conversion.ts';

export const functionsMethods = {
	enumDecl(this: Translator, e: ts.EnumDeclaration, merged: string[] = []): string {
		const lines = [`object ${ident(this.topName(e, e.name.text))} {`];
		for (const m of e.members) {
			const v = this.checker.getConstantValue(m);
			if (v === undefined) throw this.error(m, 'an enum member without a constant value');
			lines.push(`    const val ${ident(m.name.getText())}: ${typeof v === 'string' ? 'String' : 'Double'} = ${typeof v === 'string' ? kotlinString(v) : numberLiteral(String(v))}`);
		}
		// The object JavaScript makes of the enum: each name to its value, and each number back to its name.
		const entries = e.members.flatMap((m) => {
			const v = this.checker.getConstantValue(m)!,
				n = m.name.getText();
			const pair: [string, string] = [kotlinString(n), typeof v === 'string' ? kotlinString(v) : numberLiteral(String(v))];
			return typeof v === 'number' ? [pair, [kotlinString(String(v)), kotlinString(n)] as [string, string]] : [pair];
		});
		lines.push(`    val jsEnumObject: JSObject by kotlin.lazy { ${jsObjectCode(entries)} }`);
		lines.push(
			...merged.map((l) =>
				l
					.split('\n')
					.map((x) => (x ? '    ' + x : x))
					.join('\n'),
			),
		);
		lines.push('}');
		return lines.join('\n');
	},

	// ---- Functions -----------------------------------------------------------------------------

	/** `override`: an override's, which takes a constant default from the method it overrides. */
	params(this: Translator, fn: ts.SignatureDeclaration, closure: boolean, override = false): string {
		if (this.readsArguments(fn)) return '__arguments: JSArray<Any?>';
		const implicit = this.implicitThis(fn) ? ['__this: Any?'] : [];
		return [
			...implicit,
			...fn.parameters.map((p, k) => {
				// `this: void` declares there is none; a `this` the function reads is its first parameter.
				if (isThisParameter(p)) return this.voidThis(p) || (ts.isFunctionExpression(fn) && thisArgBound(fn, this.checker)) ? '' : `__this: ${this.type(this.checker.getTypeAtLocation(p.name), p)}`;
				const name = this.baseParamNames.get(p) ?? (ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`);
				if (p.dotDotDotToken) return `${name}: ${this.typeOf(p.name)}`;
				if (this.typeTested(p)) return `${name}: Any?`;
				let t = this.typeOf(p.name);
				if (this.states.nullishHeld(p)) return `${name}: ${nullishType(t)}${!closure && (p.questionToken || p.initializer) ? ' = JSNullish.Undefined' : ''}`;
				// Library mode: a local function's object parameter it tests (`const addDrawable = (is) => { if (is) … }`) takes null, as script passes it.
				const localFunction = (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent);
				if (this.library && localFunction && ts.isIdentifier(p.name) && !t.endsWith('?') && this.isObjectType(t) && !isFunctionType(t) && this.truthTested(p.name)) {
					const sym = this.checker.getSymbolAtLocation(p.name);
					if (sym) this.nullableDecls.add(sym);
					t = optionalType(t);
				}
				if (this.states.mayBeNull(p)) {
					const sym = this.checker.getSymbolAtLocation(p.name);
					if (sym) this.nullableDecls.add(sym);
					t = optionalType(t);
				}
				let given = '';
				if (p.questionToken || (p.initializer && !this.templateParams)) {
					if (!closure && this.constantDefault(p)) given = ` = ${this.stored(p.initializer!, p, t)}`;
					else if (!(override && this.constantDefault(p))) {
						t = optionalType(t);
						if (!closure) given = ' = null';
					}
				}
				return `${name}: ${t}${given}`;
			}),
		]
			.filter(Boolean)
			.join(', ');
	},

	/** `this: void` or an untyped `this` parameter: no parameter. */
	voidThis(this: Translator, p: ts.ParameterDeclaration): boolean {
		return !p.type || p.type.kind === ts.SyntaxKind.VoidKeyword;
	},

	/**
	 * A parameter Kotlin gives its constant default itself. Not where another method of its override family declares the
	 * parameter otherwise: Kotlin overrides take the root's default, where JavaScript applies the default of the method that runs.
	 */
	constantDefault(this: Translator, p: ts.ParameterDeclaration): boolean {
		return !!p.initializer && isConstant(p.initializer) && !this.familyDefaultsDiffer(p) && !this.states.defaultTakesUndefined(p);
	},

	/** Statements a function body starts with: computed defaults, destructured parameters. */
	paramPrelude(this: Translator, fn: ts.SignatureDeclaration): string[] {
		const i = this.indent;
		const lines: string[] = [];
		// A default's or a destructuring's lines name the parameter's source line, as either can throw.
		const marked = new Set<ts.ParameterDeclaration>();
		const push = (p: ts.ParameterDeclaration, line: string) => {
			const mark = line && (p.initializer || !ts.isIdentifier(p.name)) && !marked.has(p) ? (this.lines?.markLine(p) ?? '') : '';
			if (mark) marked.add(p);
			lines.push(mark + line);
		};
		if (this.readsArguments(fn)) {
			// The parameters read from the arguments the call passed, undefined where it passed none.
			fn.parameters
				.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
				.forEach((p, k) => {
					if (!ts.isIdentifier(p.name)) throw this.error(p, 'a destructured parameter of a function reading `arguments`');
					const assigned = !!(fn as ts.FunctionLikeDeclaration).body && assignsTo((fn as ts.FunctionLikeDeclaration).body!, this.checker.getSymbolAtLocation(p.name), this.checker);
					const arg = this.marks.pureCode(`__arguments.storage.getOrNull(${k})`);
					const pt = this.typeOf(p.name);
					const declared = p.questionToken && !p.initializer ? optionalType(pt) : pt;
					const value = p.dotDotDotToken ? `JSArray(__arguments.storage.drop(${k}).map { ${this.fromAnyCode('it', pt.replace(/^JSArray<(.*)>$/, '$1'), true)} }.toMutableList())` : p.initializer ? `(if (${arg} == null) ${branch(this.stored(p.initializer, p, pt))} else ${this.fromAnyCode(arg, pt, true)})` : this.fromAnyCode(arg, declared, true);
					push(p, `${i}${assigned ? 'var' : 'val'} ${ident(p.name.text)}: ${declared} = ${value}`);
				});
			return lines;
		}
		fn.parameters.forEach((p, k) => {
			if (isThisParameter(p)) return;
			const name = ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`;
			// The parameter as the signature names it: the overridden method's name, where that differs.
			const given = this.baseParamNames.get(p) ?? name;
			const closure = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || (ts.isMethodDeclaration(fn) && ts.isObjectLiteralExpression(fn.parent));
			// A parameter the body assigns is a variable of its own (Kotlin parameters are constants).
			const assigned = ts.isIdentifier(p.name) && !!(fn as ts.FunctionLikeDeclaration).body && assignsTo((fn as ts.FunctionLikeDeclaration).body!, this.checker.getSymbolAtLocation(p.name), this.checker, (e) => this.staticTruth(e));
			if (p.initializer && !this.templateParams && this.states.nullishHeld(p)) {
				// Only undefined takes the default: null stays.
				const nt = nullishType(this.typeOf(p.name));
				push(p, `${i}${assigned ? 'var' : 'val'} ${name}: ${nt} = if (${given}.jsAny == null) JSNullish.of(${this.stored(p.initializer, p, nt.slice('JSNullish<'.length, -1))}) else ${given}`);
			} else if (p.initializer && !this.templateParams && (closure || !this.constantDefault(p))) {
				const t = this.typeOf(p.name);
				// Library mode: NaN is how a number slot carries undefined (`return index` of an unset `index?: number`), which the default fills in for.
				const value = this.library && t === 'Double' ? `${given}.let { if (it == null || it.isNaN()) ${this.stored(p.initializer, p, t)} else it }` : `${given} ?: ${this.patternDefault(p.initializer, p, t) ?? this.stored(p.initializer, p, t)}`;
				push(p, `${i}${assigned ? 'var' : 'val'} ${name}: ${t} = ${value}`);
			} else if (assigned) {
				const sym = this.checker.getSymbolAtLocation(p.name);
				const pt = this.lenient ? this.paramType(p) : this.typeOf(p.name);
				const known = sym && this.nullableDecls.has(sym);
				// Read where its type says it is set, as the parameter it stands for is.
				if (sym && this.library && pt !== this.typeOf(p.name)) this.nullableDecls.add(sym);
				push(p, `${i}var ${name}${known ? '' : `: ${pt}`} = ${given}`);
			} else if (given !== name && ts.isIdentifier(p.name) && (fn as ts.FunctionLikeDeclaration).body && refersTo((fn as ts.FunctionLikeDeclaration).body!, this.checker.getSymbolAtLocation(p.name), this.checker)) push(p, `${i}val ${name} = ${given}`);
			// A destructured parameter the body assigns binds variables.
			const body = (fn as ts.FunctionLikeDeclaration).body;
			let whole = given;
			if (this.states.destructuresEmpty(p)) {
				const first = ts.isObjectBindingPattern(p.name) ? p.name.elements[0] : undefined;
				const key = first && !first.dotDotDotToken ? (first.propertyName ?? first.name) : undefined;
				const keyText = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? kotlinString(key.text) : 'null';
				if (/^\w+$/.test(given) && (ts.isArrayBindingPattern(p.name) || keyText !== 'null')) push(p, `${i}${RT.jsDestructurable}(${given}, ${ts.isArrayBindingPattern(p.name) ? 'null' : keyText})`);
				else whole = this.asserted(given);
			}
			if (!ts.isIdentifier(p.name)) push(p, this.bindTo(p.name, whole, '', !!body && boundNames(p.name).some((b) => assignsTo(body, this.checker.getSymbolAtLocation(b), this.checker))));
		});
		return lines;
	},

	/** A call of an object `widenedResult` that may give undefined: missing where it gives nothing, as a string's is. One giving only null is `nullResult`'s. */
	widenedObjectCall(this: Translator, e: ts.CallExpression): boolean {
		const d = this.checker.getResolvedSignature(e)?.getDeclaration(),
			t = this.typeOf(e);
		return !!d && !ts.isJSDocSignature(d) && this.isObjectType(t) && !isFunctionType(t) && !isUntyped(spelledType(t)) && this.states.widenedResult(d) && !this.states.nullOnlyResult(d);
	},

	/** A function type's result as its group holds it (`widenedResult`). */
	widenedResultType(this: Translator, sd: ts.Declaration | undefined, t: string): string {
		if (sd && ts.isFunctionLike(sd) && !ts.isJSDocSignature(sd as ts.Node) && this.states.optionalElements(sd)) return optionalElementsType(t);
		return sd && ts.isFunctionLike(sd) && !ts.isJSDocSignature(sd as ts.Node) && !['Unit', 'Any?', 'Nothing'].includes(t) && !t.endsWith('?') && this.states.widenedResult(sd as ts.SignatureDeclaration) ? optionalType(t) : t;
	},

	returnTypeOf(this: Translator, fn: ts.SignatureDeclaration): string {
		const context = this.states.widenedContext(fn);
		if (context) return this.returnTypeOf(context);
		if (this.states.nullish().held.has(fn) || this.states.fallbackResult(fn) || (methodValues(this, fn) && this.thisValues().returning.has(fn))) return 'Any?';
		if (this.states.nullishHeld(fn)) return nullishType(this.type(this.states.resultType(fn), fn));
		if (this.library && this.returnsNullApart(fn)) return 'Any?';
		const t = this.heldElements(fn, this.type(this.checker.getSignatureFromDeclaration(fn)!.getReturnType(), fn));
		if (this.library && this.nullablePrimitiveReturn(fn) && ['String', 'Double', 'Boolean'].includes(t)) return optionalType(t);
		if (this.states.looseDeclaration(fn) || this.widenedResultType(fn, t) !== t || ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && this.unset.returnsElement(fn))) return optionalType(t);
		if (this.states.lenientAsync(fn)) return t.replace(/^JSPromise<(String|Double|Boolean)>$/, 'JSPromise<$1?>');
		return fn.getSourceFile().isDeclarationFile || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? t : this.lenientRef(t);
	},

	generics(this: Translator, fn: ts.SignatureDeclaration | ts.ClassLikeDeclaration): string {
		if (this.pluginFiles.has(fn.getSourceFile().fileName)) return '';
		// A bounded type parameter (`T extends View`) is held to its bound, which code reads it as; a function's only to a class's,
		// as an object type (`U extends { root: View }`) has no Kotlin class the arguments share (its members are read by name).
		const bound = (p: ts.TypeParameterDeclaration) => (!this.library && p.constraint && (ts.isClassLike(fn) || this.classConstraint(p)) ? this.type(this.checker.getTypeFromTypeNode(p.constraint), p).replace(/\?$/, '') : '');
		const kept = (fn.typeParameters ?? []).filter((p) => !this.erasesTypeParameter(p));
		return kept.length ? `<${kept.map((p) => (bound(p) && bound(p) !== 'Any' ? `${p.name.text} : ${bound(p)}` : p.name.text)).join(', ')}>` : '';
	},

	classConstraint(this: Translator, p: ts.TypeParameterDeclaration): boolean {
		const t = p.constraint && this.checker.getTypeFromTypeNode(p.constraint);
		return !!t && !t.isUnion() && !t.isIntersection() && !!((t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class);
	},

	/** A value typed by a function's type parameter whose constraint is an object type (`ui: U`, `U extends { root: View }`). */
	structuralTypeParam(this: Translator, e: ts.Expression): boolean {
		if (this.library) return false;
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
		if (!(t.flags & ts.TypeFlags.TypeParameter) || (t as ts.TypeParameter & { isThisType?: boolean }).isThisType) return false;
		const decl = t.symbol?.declarations?.[0];
		if (!decl || !ts.isTypeParameterDeclaration(decl) || !decl.constraint || !ts.isFunctionLike(decl.parent) || ts.isClassLike(decl.parent)) return false;
		return !this.classConstraint(decl) && !!(this.checker.getTypeFromTypeNode(decl.constraint).flags & ts.TypeFlags.Object);
	},

	/** A function's body block (`{ … }`), lowered when the function is async. */
	functionBody(this: Translator, fn: ts.FunctionLikeDeclaration, ret: string, base: string, lambdaLabel: string | null = null): string {
		const self = fn.parameters.find((p) => isThisParameter(p) && !this.voidThis(p));
		if (self && !thisNodes(fn).every((n) => this.subst.has(n))) return this.withThis(fn, '__this', false, () => this.functionBody(fn, ret, base, lambdaLabel));
		if (this.implicitThis(fn) && !thisNodes(fn).every((n) => this.subst.has(n))) return this.withThis(fn, '__this', true, () => this.functionBody(fn, ret, base, lambdaLabel));
		return this.inFunction(
			ret,
			() => {
				const saved = this.indent;
				this.indent = base + '    ';
				try {
					let lines: string[];
					if (fn.asteriskToken) lines = this.lowering.generatorBody(fn, ret.replace(/^JS\w+<(.*)>\??$/, '$1'), isAsync(fn));
					else if (isAsync(fn) && ret === 'Unit') {
						// Where nothing is returned (an async Promise executor): run for its effects, its promise left alone.
						lines = this.lowering.body(fn, this.returnTypeOf(fn).replace(/^JSPromise<(.*)>\??$/, '$1'));
						lines.pop();
					} else if (isAsync(fn)) lines = this.lowering.body(fn, ret.replace(/^JSPromise<(.*)>\??$/, '$1'));
					else if (fn.body && ts.isBlock(fn.body)) {
						lines = [...this.paramPrelude(fn), ...this.statements([...fn.body.statements])];
						// JavaScript returns undefined at the end; Kotlin needs a return where the checker proved one is never reached.
						if (!['Unit', 'Nothing'].includes(ret) && !this.exits(fn.body)) {
							lines.push(ret.endsWith('?') ? `${this.indent}${this.returnKeyword()} null` : `${this.indent}${RT.jsThrow}(JSTypeError("no value returned where the declared type needs one"))`);
						}
					} else {
						const e = fn.body as ts.Expression;
						const slot = this.resultSlot(e);
						const body = this.bodyReturned(returnCell(this.returns, e, slot, true), slot);
						lines = [...this.paramPrelude(fn), body && (this.lines?.markLine(e) ?? '') + body];
					}
					return `{\n${lines.filter(Boolean).join('\n')}\n${base}}`;
				} catch (e) {
					throw this.located(e, fn);
				} finally {
					this.indent = saved;
				}
			},
			lambdaLabel,
		);
	},

	func(this: Translator, fn: ts.FunctionDeclaration | ts.MethodDeclaration, name: string, modifiers = ''): string {
		return this.docOf(fn, this.indent) + this.suppressingDeprecations(() => this.funcCode(fn, name, modifiers));
	},

	/**
	 * A declaration's doc comment, as KDoc before its Kotlin declaration (`indent` before each line but the first), or ''.
	 * A `/*` inside it would open a nested comment in Kotlin: it is spaced apart.
	 */
	docOf(this: Translator, n: ts.Node, indent = ''): string {
		const sf = n.getSourceFile();
		const at = ts.isVariableDeclaration(n) && ts.isVariableDeclarationList(n.parent) && n.parent.declarations[0] === n ? n.parent.parent : n;
		const doc = (ts.getLeadingCommentRanges(sf.text, at.getFullStart()) ?? []).filter((r) => r.kind === ts.SyntaxKind.MultiLineCommentTrivia && sf.text.startsWith('/**', r.pos) && !sf.text.startsWith('/**/', r.pos)).at(-1);
		if (!doc) return '';
		const text = sf.text.slice(doc.pos + 3, doc.end - 2).replace(/\/\*/g, '/ *');
		const lines = text.split('\n').map((l) => l.trim().replace(/^\* ?/, ''));
		while (lines.length && !lines[0]) lines.shift();
		while (lines.length && !lines.at(-1)) lines.pop();
		if (!lines.length) return '';
		return lines.length === 1 ? `/** ${lines[0]} */\n${indent}` : `/**\n${lines.map((l) => `${indent} *${l ? ' ' + l : ''}`).join('\n')}\n${indent} */\n${indent}`;
	},

	funcCode(this: Translator, fn: ts.FunctionDeclaration | ts.MethodDeclaration, name: string, modifiers: string): string {
		const ret = this.returnTypeOf(fn);
		const params = modifiers.includes('override') ? this.params(fn, true, true) : this.params(fn, false);
		// A type parameter an untyped value is read as (`cached.data` of `T[]`) is reified: the value is converted to the class the call
		// instantiates it with, as Kotlin's erased generics cannot.
		const reifiable = !this.library && !/\b(override|open|abstract)\b/.test(modifiers) && !!fn.typeParameters?.length && !fn.asteriskToken && !isAsync(fn) && !this.isRecursive(fn);
		this.reifying.push(reifiable ? fn : null);
		let body: string;
		try {
			body = this.functionBody(fn, ret, this.indent);
		} finally {
			this.reifying.pop();
		}
		let generics = this.generics(fn);
		const reified = this.reified.get(fn);
		if (reified?.size) generics = generics.replace(/([<,]\s*)(\w+)/g, (m, sep, n) => (reified.has(n) ? `${sep}reified ${n}` : m));
		// An inline function's function parameters are values it keeps or passes on: not inlined.
		const kept = reified?.size
			? splitTopLevel(params)
					.map((p) => (/^[\w`$]+: \(/.test(p.trim()) ? `noinline ${p.trim()}` : p.trim()))
					.join(', ')
			: params;
		return `${modifiers}${reified?.size ? 'inline ' : ''}fun ${generics}${generics ? ' ' : ''}${name}(${kept})${ret === 'Unit' ? '' : `: ${ret}`} ${body}`;
	},

	/** A function read untyped as one of its type parameters (`T`): `jsCastTo<T>`, the function then reified. */
	reifiedRead(this: Translator, code: string, type: string): string | null {
		const name = type.replace(/\?$/, '');
		for (let k = this.reifying.length - 1; k >= 0; k--) {
			const fn = this.reifying[k];
			if (!fn || !fn.typeParameters?.some((p) => p.name.text === name && !this.erasesTypeParameter(p))) continue;
			if (!this.reified.has(fn)) this.reified.set(fn, new Set());
			this.reified.get(fn)!.add(name);
			return `${RT.jsCastTo}<${type}>(${code})`;
		}
		return null;
	},

	isRecursive(this: Translator, fn: ts.FunctionDeclaration | ts.MethodDeclaration): boolean {
		const sym = fn.name && this.checker.getSymbolAtLocation(fn.name);
		return !!sym && !!fn.body && refersTo(fn.body, sym, this.checker);
	},

	/** `(r) => r.id` as a Kotlin anonymous function, where `return` means what it does in JavaScript. */
	closure(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration, slot?: string): string {
		// An object literal's function for a method its interface declares with `this` is held as a method's body is: it reads its holder.
		const literalMethod = ts.isFunctionExpression(fn) && ts.isPropertyAssignment(fn.parent) && ts.isObjectLiteralExpression(fn.parent.parent) && !!slot && !!functionTypeParts(slot.replace(/^\((.*)\)\?$/, '$1')) && this.checker.getContextualType(fn)?.getCallSignatures()[0]?.getDeclaration()?.kind === ts.SyntaxKind.MethodSignature;
		if (ts.isFunctionExpression(fn) && ((methodValues(this, fn) && this.thisValues().functions.has(fn)) || (!this.library && !literalMethod && !thisArgBound(fn, this.checker) && (takesOwnThis(fn) || this.givenThis(fn))))) return this.thisMethod(fn);
		const contextual = this.checker.getContextualType(fn as ts.Expression)?.getCallSignatures()[0];
		const slotParts = slot ? functionTypeParts(slot.replace(/^\((.*)\)\?$/, '$1')) : undefined;
		const slotRet = slotParts?.ret;
		// An async function where a void callback is taken (`onTap: async () => …`): called for its effects, its promise left alone.
		if (slotRet === 'Unit' && isAsync(fn) && fn.parameters.every((p) => ts.isIdentifier(p.name))) {
			const names = fn.parameters.map((p) => ident((p.name as ts.Identifier).text));
			const extra = (slotParts?.params ?? []).slice(fn.parameters.length).map((t, k) => `__u${fn.parameters.length + k}: ${t}`);
			return `fun(${[this.params(fn, true), ...extra].filter(Boolean).join(', ')}) { (${this.closure(fn)})(${names.join(', ')}) }`;
		}
		if (ts.isFunctionExpression(fn) && this.readsArguments(fn) && slotParts && contextual && contextual.getDeclaration() !== fn) {
			const names = slotParts.params.map((_, k) => `__a${k}`);
			const inner = this.closure(fn);
			const call = `__f(${RT.jsArrayOf}<Any?>(${names.join(', ')}))`;
			return `run { val __f = ${inner}; fun(${names.map((n, k) => `${n}: ${slotParts.params[k]}`).join(', ')})${slotParts.ret === 'Unit' ? ` { ${call} }` : `: ${slotParts.ret} = ${call}`} }`;
		}
		// A slot taking the arguments as a rest (`callback: (...args: any[]) => void`) given a function of separate parameters: each read from the rest.
		const restAt = contextual?.getParameters().findIndex((p) => !!p.valueDeclaration && ts.isParameter(p.valueDeclaration) && !!p.valueDeclaration.dotDotDotToken) ?? -1;
		if (slotParts && restAt >= 0 && restAt === slotParts.params.length - 1 && /^JSArray<.*>$/.test(slotParts.params[restAt]) && fn.parameters.length > restAt && !fn.parameters.some((p) => p.dotDotDotToken) && !ts.isMethodDeclaration(fn)) {
			const own = fn.parameters.map((p) => this.paramType(p));
			const args = own.map((t, k) => (k < restAt ? (isUntyped(spelledType(slotParts.params[k])) && !isUntyped(spelledType(t)) ? this.fromAnyCode(`__p${k}`, t, true) : `__p${k}`) : this.fromAnyCode(`__rest.element(${k - restAt}.0)`, t, true)));
			const params = [...slotParts.params.slice(0, restAt).map((t, k) => `__p${k}: ${t}`), `__rest: ${slotParts.params[restAt]}`];
			const call = `__f(${args.join(', ')})`;
			return `run { val __f = ${this.closure(fn)}; fun(${params.join(', ')})${slotParts.ret === 'Unit' ? ` { ${call} }` : `: ${slotParts.ret} = ${call}`} }`;
		}
		// A slot taking an untyped or widened parameter type (`then((result: File) => …)`, a shape method whose slot widened `T` to `T?`): adapt each argument.
		if (slotParts && fn.parameters.length <= slotParts.params.length && fn.parameters.every((p) => !p.dotDotDotToken && ts.isIdentifier(p.name))) {
			const own = fn.parameters.map((p) => this.paramType(p));
			const untypedAdapt =
				!ts.isMethodDeclaration(fn) &&
				literalCallback(
					slotParts.params.map((t) => spelledType(t)),
					own.map((t) => spelledType(t)),
				) === 'adapt';
			const widenedAdapt = ts.isMethodDeclaration(fn) && own.some((t, k) => !fn.parameters[k].initializer && !fn.parameters[k].questionToken && slotParts.params[k] === optionalType(t) && t !== slotParts.params[k]);
			if (untypedAdapt || widenedAdapt) {
				const args = own.map((t, k) => {
					const from = slotParts.params[k];
					if (isUntyped(spelledType(from)) && !isUntyped(spelledType(t))) return this.fromAnyCode(`__p${k}`, t, true);
					if (from === optionalType(t) && t !== from) return this.undefinedAs(`__p${k}`, t);
					return `__p${k}`;
				});
				const call = `__f(${args.join(', ')})`;
				const params = slotParts.params.map((t, k) => `__p${k}: ${t}`);
				return `run { val __f = ${this.closure(fn, `(${own.join(', ')}) -> ${slotParts.ret}`)}; fun(${params.join(', ')})${slotParts.ret === 'Unit' ? ` { ${call} }` : `: ${slotParts.ret} = ${call}`} }`;
			}
		}
		const ret = this.closureResult(fn, slotRet).target;
		if (!ts.isMethodDeclaration(fn) && fn.name && fn.body && refersTo(fn.body, this.checker.getSymbolAtLocation(fn.name), this.checker)) throw this.error(fn, 'a named function expression', 'named-function-expression');
		let params = this.params(fn, true);
		// A slot's function type may take more parameters than the literal declares (JavaScript ignores extras).
		const slotParams = slotParts?.params ?? [];
		const given = ts.isFunctionExpression(fn) && thisArgBound(fn, this.checker) ? fn.parameters.filter((q) => !isThisParameter(q)).length : fn.parameters.length;
		for (let k = given; k < slotParams.length; k++) params += `${params ? ', ' : ''}__u${k}: ${slotParams[k]}`;
		return this.asLambda(fn, params, ret) ?? `fun(${params})${ret === 'Unit' ? '' : `: ${ret}`} ${this.functionBody(fn, ret, this.indent)}`;
	},

	/** A function literal's result slot, where `slotRet` is the result of the function type it is given as: nothing where that returns void, else its own type. */
	closureResult(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration, slotRet: string | undefined): ResultSlot {
		const contextual = this.checker.getContextualType(fn as ts.Expression)?.getCallSignatures()[0];
		const voidSlot = (!!contextual && !!(contextual.getReturnType().flags & ts.TypeFlags.Void) && !isAsync(fn)) || slotRet === 'Unit';
		let ret = voidSlot ? 'Unit' : (slotRet ?? this.returnTypeOf(fn));
		// A function giving nothing where a value or nothing is taken (`init: () => (() => void) | void`): of the slot's type,
		// so the lambda's last statement is not taken for its value; ending without a `return`, it gives null.
		const taken = !voidSlot && !slotRet && ret === 'Unit' && !isAsync(fn) ? contextual?.getReturnType() : undefined;
		if (taken?.isUnion() && taken.types.some((u) => u.flags & ts.TypeFlags.Void) && taken.types.some((u) => !(u.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)))) ret = this.type(taken, fn);
		// Library mode: a function returning null where TypeScript (unchecked for null) infers an object: nullable.
		if (this.library && !slotRet && !voidSlot && this.isObjectType(ret) && !isNullable(ret) && fn.body && returnsNull(fn.body)) ret = optionalType(ret);
		return resultSlot(ret, fn);
	},

	/**
	 * A function literal as a Kotlin lambda: its last `return` is the lambda's value, an earlier one returns to its label
	 * (`return@fn1`). Null where only an anonymous function will do: an async function or a generator, which suspend through
	 * `return`s of their own, or one with a result whose body does not end in a `return`, which Kotlin would type by it.
	 */
	asLambda(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration, params: string, ret: string): string | null {
		if (isAsync(fn) || fn.asteriskToken || !fn.body || this.readsArguments(fn)) return null;
		// A lambda's result is inferred: a function it returns (a teardown) would take its last expression's type for `Unit`.
		if (/^\(/.test(ret) && functionTypeParts(ret.replace(/^\((.*)\)\?$/, '$1'))?.ret === 'Unit') return null;
		// A lambda checks its non-null parameters, which an anonymous function does not: script may pass undefined (null) to one
		// it uses, so such a function stays anonymous; an unused one takes the nullable type, which fits the same slot.
		const declared = splitTopLevel(params)
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => {
				const [name, type] = p.split(/:\s*(.*)/s);
				return { name: name.trim(), type: type.trim() };
			});
		const checked = (t: string) => !t.endsWith('?') && !['Double', 'Boolean'].includes(t);
		const read = (p: ts.ParameterDeclaration) => !ts.isIdentifier(p.name) || refersTo(fn.body!, this.checker.getSymbolAtLocation(p.name), this.checker);
		if (fn.parameters.some((p) => read(p) && checked(declared.find((d) => ts.isIdentifier(p.name) && d.name === ident(p.name.text))?.type ?? ''))) return null;
		const last = ts.isBlock(fn.body) ? fn.body.statements.at(-1) : undefined;
		if (ret !== 'Unit' && ts.isBlock(fn.body) && !(last && ts.isReturnStatement(last) && last.expression)) return null;
		const label = this.fresh('fn');
		const body = this.functionBody(fn, ret, this.indent, label);
		const inner = this.indent + '    ';
		let lines = body.slice(2, body.lastIndexOf('\n')).split('\n');
		// The last statement's `return` is the lambda's value; a `return` alone there is its end.
		const end = lines
			.map((l, k) => [l, k] as const)
			.filter(([l]) => l.replace(/^(\/\*@ns:[^*]*\*\/)/, '').startsWith(`${inner}return@${label}`))
			.at(-1);
		if (end && !lines.slice(end[1] + 1).some((l) => l.startsWith(inner) && !l.startsWith(inner + ' ') && !/^\s*[})\]]/.test(l))) {
			const [l, k] = end;
			lines[k] = l.replace(`return@${label} `, '').replace(new RegExp(`return@${label}$`), '');
			// A lambda value on a line of its own after a call would be that call's trailing lambda.
			if (k > 0 && /[\w)\]]$/.test(lines[k - 1].trimEnd())) lines[k] = lines[k].replace(/^((?:\/\*@ns:[^*]*\*\/)?\s*)(?=(\w+@)?\{)/, '$1;');
			if (!lines[k].trim() || /^\/\*@ns:[^*]*\*\/\s*$/.test(lines[k].trim())) lines.splice(k, 1);
		} else if (ret !== 'Unit') return null;
		lines = lines.filter((l, k) => !(k === lines.length - 1 && l.trim() === ''));
		const text = lines.join('\n');
		const head = declared.length ? ` ${declared.map((p) => (mentions(text, p.name) ? `${p.name}: ${p.type}` : `_: ${checked(p.type) ? optionalType(p.type) : p.type}`)).join(', ')} ->` : '';
		return `${mentions(text, `return@${label}`) || text.includes(`return@${label}`) ? `${label}@` : ''}{${head}\n${text}\n${this.indent}}`;
	},

	/** A callback for a timer or microtask: a closure, a function value called with nothing, or a Promise's resolve. */
	callback(this: Translator, e: ts.Expression): string {
		// An async function: called for its effects, the promise it gives left alone.
		if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && isAsync(e)) return `run { val __f = ${this.closure(e)}; { __f(); Unit } }`;
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.closure(e, '() -> Unit');
		const resolvers = ts.isIdentifier(e) ? this.resolvers.get(this.resolve(e)!) : undefined;
		if (resolvers) return `{ ${resolvers.name}.resolve(${resolvers.type === 'Unit' ? 'Unit' : (this.zero(resolvers.type) ?? 'null')}) }`;
		const sig = this.checker.getTypeAtLocation(e).getCallSignatures()[0];
		const pads = (sig?.getParameters() ?? []).map((p) => (this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e) === 'Unit' ? 'Unit' : 'null'));
		const fn = this.functionValue(e);
		return `{ ${fn.includes('::') ? `(${fn})` : fn}(${pads.join(', ')}) }`;
	},
};
