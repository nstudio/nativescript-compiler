// Classes as Kotlin: declarations, members, mixins, statics and constructors.
import ts from 'typescript';
import { ident, isThisParameter, kotlinString, nullishType, optionalType, setterMethod, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { allowedDeprecation, calledOnAnyThread } from '../targets/android/deprecations.ts';
import { hasModifier } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { isNativePropertyDecorator } from '../program/patterns.ts';
import { programBase, prototypeDecorated, readEarly } from '../semantics/classes.ts';
import type { ClassPlan } from '../semantics/class-plan.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const classesMethods = {
	/** A class decorator the class's translation neither refuses nor runs: one of `own` (core's) or the framework's. */
	keptDecorator(this: Translator, d: ts.Decorator, own: string[]): boolean {
		return new RegExp(`^(${[...own, ...this.framework.readDecorators()].join('|')})\\b`).test(d.expression.getText());
	},

	/**
	 * A class or object with `next` (and `return`, `throw`) is an iterator
	 * script wrote: the kit steps it through these, async when `next` returns a promise.
	 */
	iteratorProtocol(this: Translator, methods: { name: string; params: number; ret: string; param?: string }[]): { conformance: string; lines: string[] } | null {
		const next = methods.find((m) => m.name === 'next');
		if (!next || next.params > 1) return null;
		const call = (m: { name: string; params: number; param?: string }, arg: string) => `this.${ident(m.name)}(${m.params ? (m.param && !isUntyped(spelledType(m.param)) ? this.fromAnyCode(arg, m.param, true) : arg) : ''})`;
		const ret = methods.find((m) => m.name === 'return'),
			thr = methods.find((m) => m.name === 'throw');
		if (isKit(spelledType(next.ret), 'JSPromise')) {
			const promise = (m: { name: string; params: number; ret: string }, arg: string) => {
				const inner = m.ret.replace(/^JSPromise<(.*)>$/, '$1');
				const c = call(m, arg);
				return isUntyped(spelledType(inner)) ? c : `${c}.then<Any?> { it }`;
			};
			return { conformance: 'JSAsyncIteratorProtocol', lines: [`    override fun jsNextPromise(value: Any?): JSPromise<Any?> = ${promise(next, 'value')}`, `    override fun jsReturnPromise(value: Any?): JSPromise<Any?>? = ${ret ? promise(ret, 'value') : 'null'}`, `    override fun jsThrowPromise(error: Any?): JSPromise<Any?>? = ${thr ? promise(thr, 'error') : 'null'}`] };
		}
		return { conformance: 'JSIteratorProtocol', lines: [`    override fun jsNext(value: Any?): JSStep = ${RT.jsStepOf}(${call(next, 'value')})`, `    override fun jsReturn(value: Any?): JSStep = ${ret ? `${RT.jsStepOf}(${call(ret, 'value')})` : 'JSStep(value, true)'}`, `    override fun jsThrow(error: Any?): JSStep = ${thr ? `${RT.jsStepOf}(${call(thr, 'error')})` : 'throw JSException(error)'}`, `    override val jsHasReturn: Boolean get() = ${!!ret}`, `    override val jsHasThrow: Boolean get() = ${!!thr}`] };
	},

	/** A member named by a symbol (`symbolMemberOf`), its property key spelled. */
	symbolMember(this: Translator, name: ts.PropertyName): { member: string; key: string | null; fixed: boolean; either: boolean } | null {
		const s = this.symbolMemberOf(name);
		return s && { member: s.member, key: s.key && (s.key.either ? `${RT.jsPropertyKey}(${this.expr(s.key.of)})` : this.symbolKey(this.expr(s.key.of))), fixed: !!s.key?.fixed, either: !!s.key?.either };
	},
	/**
	 * A string, number or boolean field read before it is set (`readEarly`): held nullable beside the field
	 * (`earlyBacking`), null until the class's own initialization, which reads it as its type does undefined. A field of
	 * another type is null on the JVM until then.
	 */
	earlyField(this: Translator, m: ts.PropertyDeclaration): boolean {
		let found = this.earlyFields.get(m);
		if (found !== undefined) return found;
		found = readEarly(m, this) && ['String', 'Double', 'Boolean'].includes(this.typeOf(m.name)) && !this.properties?.isRegistered(m.parent as ts.ClassLikeDeclaration, (m.name as ts.Identifier).text);
		this.earlyFields.set(m, found);
		return found;
	},

	/** A method no base or subclass declares a member of its name for, so its return type is its own to choose. */
	onlyMethodOfName(this: Translator, fn: ts.Node): boolean {
		if (!ts.isMethodDeclaration(fn) || !ts.isIdentifier(fn.name) || !ts.isClassLike(fn.parent)) return false;
		const name = fn.name.text,
			cls = fn.parent;
		const declares = (c: ts.ClassLikeDeclaration) => c.members.some((m) => m !== fn && m.name?.getText() === name);
		for (let b = programBase(cls, this.checker); b; b = programBase(b, this.checker)) if (declares(b)) return false;
		if (cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) && !programBase(cls, this.checker)) return false;
		if (!this.subclassMethodNames) {
			const map = new Map<ts.Node, Set<string>>();
			const visit = (n: ts.Node) => {
				if (ts.isClassLike(n)) {
					const names = n.members.map((m) => m.name?.getText()).filter((x): x is string => !!x);
					for (let b = programBase(n, this.checker); b; b = programBase(b, this.checker)) map.set(b, new Set([...(map.get(b) ?? []), ...names]));
				}
				ts.forEachChild(n, visit);
			};
			for (const sf of this.sourceFiles) visit(sf);
			this.subclassMethodNames = map;
		}
		return !this.subclassMethodNames.get(cls)?.has(name);
	},

	/** The fields some subclass of `cls` (in the program) declares again. */
	subclassFields(this: Translator, cls: ts.ClassLikeDeclaration): Set<string> {
		if (!this.subclassFieldNames) {
			const map = new Map<ts.Node, Set<string>>();
			for (const sf of this.sourceFiles) {
				const visit = (n: ts.Node) => {
					if (ts.isClassLike(n)) {
						// A subclass's field or accessor of the name overrides the base's.
						const names = n.members.filter((m) => ts.isPropertyDeclaration(m) || ts.isAccessor(m)).map((m) => m.name!.getText());
						for (let b = programBase(n, this.checker); b; b = programBase(b, this.checker)) {
							const set = map.get(b) ?? new Set<string>();
							for (const name of names) set.add(name);
							map.set(b, set);
						}
					}
					ts.forEachChild(n, visit);
				};
				visit(sf);
			}
			this.subclassFieldNames = map;
		}
		return this.subclassFieldNames.get(cls) ?? new Set();
	},

	/** A constructor's statements before its `super(…)` when none reads `this`, the call, and what follows it. */
	statementsBeforeSuper(this: Translator, { ctor, superAt, superCall }: ClassPlan): { pre: ts.Statement[]; superCall: ts.CallExpression; rest: ts.Statement[] } | null {
		if (!ctor || superAt <= 0) return null;
		const stmts = [...ctor.body!.statements];
		const pre = stmts.slice(0, superAt);
		const readsThis = (n: ts.Node): boolean => n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || (!ts.isFunctionLike(n) && !!ts.forEachChild(n, readsThis));
		if (pre.some(readsThis)) return null;
		return { pre, superCall: superCall!, rest: stmts.slice(superAt + 1) };
	},

	/**
	 * Library mode: a parameter typed as a class whose body tests what it holds (`typeof value === 'number'`,
	 * `value instanceof Color`), as callers pass other values: untyped, each tested read as what the test proves.
	 */
	typeTested(this: Translator, p: ts.ParameterDeclaration): boolean {
		if (!this.library || !ts.isIdentifier(p.name) || p.getSourceFile().isDeclarationFile) return false;
		const known = this.typeTestedParams.get(p);
		if (known !== undefined) return known;
		const fn = p.parent as ts.FunctionLikeDeclaration;
		let result = false;
		if (fn.body && this.isObjectType(this.type(this.checker.getTypeAtLocation(p.name), p))) {
			const sym = this.checker.getSymbolAtLocation(p.name);
			const tested = (x: ts.Expression) => ts.isIdentifier(x) && this.checker.getSymbolAtLocation(x) === sym;
			const visit = (n: ts.Node): boolean => (ts.isTypeOfExpression(n) && tested(n.expression)) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && tested(n.left)) || !!ts.forEachChild(n, visit);
			result = visit(fn.body);
		}
		// A callback's number, string or boolean it only passes on (`scale: (value: number) => ({ property: 'scale', value })`),
		// which callers may give any value: untyped, as script holds it.
		if (!result && fn.body && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ['Double', 'String', 'Boolean'].includes(this.typeOf(p.name))) {
			const sym = this.checker.getSymbolAtLocation(p.name);
			let refs = 0;
			const passed = (n: ts.Identifier): boolean => {
				const at = n.parent;
				return (ts.isPropertyAssignment(at) && at.initializer === n) || ts.isShorthandPropertyAssignment(at) || ((ts.isCallExpression(at) || ts.isNewExpression(at)) && at.expression !== n) || ts.isReturnStatement(at) || (ts.isArrowFunction(at) && at.body === n);
			};
			const all = (n: ts.Node): boolean => {
				const refSym = ts.isIdentifier(n) && n !== p.name ? (ts.isShorthandPropertyAssignment(n.parent) ? this.checker.getShorthandAssignmentValueSymbol(n.parent) : this.checker.getSymbolAtLocation(n)) : undefined;
				if (refSym && refSym === sym) {
					refs++;
					return passed(n as ts.Identifier);
				}
				return !ts.forEachChild(n, (c) => (all(c) ? undefined : true));
			};
			result = all(fn.body) && refs > 0;
			if (result) this.passedParams.add(p);
		}
		this.typeTestedParams.set(p, result);
		return result;
	},

	/** The thread annotation before a declaration of a classified module (`@UiThread `, `@AnyThread `), which Android lint checks callers against, or ''. */
	threadAnnotation(this: Translator, n: ts.Node): string {
		const thread = this.moduleThread?.(n.getSourceFile().fileName);
		return thread === 'ui' ? '@UiThread ' : thread === 'any' ? '@AnyThread ' : '';
	},

	/** A use of a deprecated Android API (`android/view/View#setSystemUiVisibility`, or a class), suppressed where core may use it. */
	noteDeprecated(this: Translator, api: string): void {
		if (allowedDeprecation(api)) this.suppressionScopes.at(-1)?.add('DEPRECATION');
	},

	/** A call of an Android API (`class#member`): one lint restricts to worker threads is suppressed where core may call it. */
	noteThreadRestricted(this: Translator, api: string): void {
		if (calledOnAnyThread(api)) this.suppressionScopes.at(-1)?.add('WrongThread');
	},

	/**
	 * A declaration's code, marked `@Suppress("DEPRECATION")` where it uses an allowed deprecated API, and
	 * `@Suppress("WrongThread")` where it calls an allowed worker-thread API. `numbering`: a function, whose temporaries
	 * are numbered apart from any other top-level one's.
	 */
	suppressingDeprecations(this: Translator, make: () => string, numbering = true): string {
		const scope = new Set<string>();
		this.suppressionScopes.push(scope);
		if (numbering && this.declarationDepth === 0) this.temporaries.clear();
		if (numbering) this.declarationDepth++;
		let code: string;
		try {
			code = make();
		} finally {
			this.suppressionScopes.pop();
			if (numbering) this.declarationDepth--;
		}
		if (!scope.size) return code;
		const keys = [...scope]
			.sort()
			.map((k) => `"${k}"`)
			.join(', ');
		// One @Suppress per declaration: joined with one the code starts with.
		return /^\s*@Suppress\(/.test(code) ? code.replace(/^(\s*)@Suppress\(/, `$1@Suppress(${keys}, `) : code.replace(/^(\s*)/, `$1@Suppress(${keys}) `);
	},

	/**
	 * An override's Kotlin parameter names: the overridden method's (Kotlin's, for named arguments), or `fallback` where
	 * that name would hide another the body reads, or another parameter's.
	 */
	signatureNames(this: Translator, m: ts.FunctionLikeDeclaration | ts.Expression, names: (string | null)[], fallback: (k: number) => string): string[] {
		const own = ts.isFunctionLike(m) ? m.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null)) : [];
		const named = new Set<string>();
		const visit = (n: ts.Node): void => {
			if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) named.add(n.text);
			ts.forEachChild(n, visit);
		};
		const body = ts.isFunctionLike(m) ? (m as ts.FunctionLikeDeclaration).body : m;
		if (body) visit(body);
		return names.map((n, k) => (n && (own[k] === n || (!named.has(n) && !own.includes(n))) ? ident(n) : fallback(k)));
	},

	/** An override's parameters under the overridden method's `names` where its own differ: the body binds its own to them. */
	takeBaseNames(this: Translator, m: ts.FunctionLikeDeclaration, names: (string | null)[]): void {
		if (m.parameters.some((p) => isThisParameter(p) || p.dotDotDotToken) || this.readsArguments(m)) return;
		const own = m.parameters.map((p, k) => (ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`));
		const sig = this.signatureNames(m, names.slice(0, own.length), (k) => own[k]);
		sig.forEach((n, k) => {
			if (n !== own[k]) this.baseParamNames.set(m.parameters[k], n);
		});
	},

	/** A method's parameter names, null for a destructured one. */
	paramNames(this: Translator, m: ts.SignatureDeclaration): (string | null)[] {
		return m.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
	},

	/**
	 * A setter taking values its getter's type can't hold (`set tint(value: Color | string)`, or core's `set style(value: Style)`
	 * testing for a CSS string): the type its parameter holds, else null. Its body is then a method of its own, which writes reach.
	 */
	setterTakes(this: Translator, set: ts.SetAccessorDeclaration, t: string): string | null {
		const p = set.parameters[0];
		if (!p || !set.body || isUntyped(spelledType(optionalType(t)))) return null;
		// A destructured parameter takes apart whatever object it is given (`set offset({ x, y })` beside `get offset(): Point`).
		if (!ts.isIdentifier(p.name)) return optionalType(this.typeOf(p.name)) !== optionalType(t) ? 'Any?' : null;
		return isUntyped(spelledType(this.paramType(p))) ? 'Any?' : null;
	},

	/** A write to an accessor of the program's whose setter takes more than its getter gives: what the setter takes. */
	setterTakesAt(this: Translator, left: ts.PropertyAccessExpression): string | null {
		const decls = this.checker.getSymbolAtLocation(left.name)?.declarations ?? [];
		const set = decls.find((d): d is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(d) && !d.getSourceFile().isDeclarationFile && !isStatic(d));
		const get = decls.find((d): d is ts.GetAccessorDeclaration => ts.isGetAccessorDeclaration(d) && d.parent === set?.parent);
		return set && get && !(get.body === undefined && hasModifier(get, ts.SyntaxKind.AbstractKeyword)) ? this.setterTakes(set, this.returnTypeOf(get)) : null;
	},

	/** The modifiers of a class's setter method (`setterTakes`): an override of the one a base class declares for the same accessor. */
	setterTakesMods(this: Translator, cls: ts.ClassLikeDeclaration, n: string, open: string): string {
		const own = cls.members.find((m): m is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(m) && m.name.getText() === n);
		if (own && isStatic(own)) return '';
		return this.baseSetterMethod(cls, n) ? 'override ' : open;
	},

	/** Whether a base class of `cls` declares `setterMethod(n)` (`setterTakes`): the program's, or the generated kit's. */
	baseSetterMethod(this: Translator, cls: ts.ClassLikeDeclaration, n: string): boolean {
		for (let b = programBase(cls, this.checker); b; b = programBase(b, this.checker)) {
			const set = b.members.find((m): m is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(m) && m.name.getText() === n && !isStatic(m));
			const get = b.members.find((m): m is ts.GetAccessorDeclaration => ts.isGetAccessorDeclaration(m) && m.name.getText() === n && !isStatic(m));
			if (set && get?.body && this.setterTakes(set, this.returnTypeOf(get))) return true;
		}
		const kitRoot = !this.library && this.generatedKit ? this.kitRootOf(cls) : null;
		return !!kitRoot && !!this.core?.kitMember(kitRoot, setterMethod(n));
	},

	/** A parameter's Kotlin type as `params` declares it. */
	paramType(this: Translator, p: ts.ParameterDeclaration): string {
		if (this.typeTested(p)) return 'Any?';
		const t = this.typeOf(p.name);
		if (this.states.nullishHeld(p)) return nullishType(t);
		if (p.questionToken || (p.initializer && !this.templateParams)) return this.constantDefault(p) && !this.states.defaultPassesNull(p) ? t : optionalType(t);
		return this.states.mayBeNull(p) ? optionalType(t) : t;
	},

	/** A field decorator as a value; a factory overloaded as plugins declare them (`colorProperty(options)` beside `colorProperty(target, key)`) gives what its implementation returns. */
	decoratorValue(this: Translator, e: ts.Expression): string {
		const sym = ts.isCallExpression(e) ? this.resolve(e.expression) : undefined;
		const impl = sym && sym.declarations && sym.declarations.length > 1 ? sym.declarations.find((x): x is ts.FunctionDeclaration => ts.isFunctionDeclaration(x) && !!x.body) : undefined;
		return impl ? this.convert(this.expr(e), this.returnTypeOf(impl), 'Any?') : this.coerce(e, 'Any?');
	},

	/**
	 * A field decorated with a native-property decorator (gesturehandler's
	 * `@nativeProperty`): a decorator that defines, with `Object.defineProperty`,
	 * a getter reading `this.native[getterName]()` (else `this.options[key]`,
	 * else the default) and a setter writing `this.options[key]` and calling
	 * `this.native[setterName](value)`, each through an optional converter.
	 * The accessor goes through the native object by name.
	 */
	nativePropertyOf(this: Translator, m: ts.PropertyDeclaration): string | null {
		const d = (ts.getDecorators(m) ?? [])[0];
		if (!d) return null;
		const call = ts.isCallExpression(d.expression) ? d.expression : null;
		const fnName = call ? call.expression : d.expression;
		const fn = this.resolve(fnName)?.declarations?.find((x): x is ts.FunctionDeclaration => ts.isFunctionDeclaration(x) && !!x.body);
		if (!fn) {
			if (prototypeDecorated(this, m)) return null;
			throw this.error(d, `the property decorator ${d.expression.getText()}`);
		}
		if (!isNativePropertyDecorator(fn)) {
			if (prototypeDecorated(this, m)) return null;
			throw this.error(d, `the property decorator ${d.expression.getText()} (not a native-property decorator this build recognizes)`);
		}
		const key = m.name.getText();
		const options = call?.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0]) ? call.arguments[0] : undefined;
		const option = (o: ts.ObjectLiteralExpression | undefined, name: string) => o?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name)?.initializer;
		const android = option(options, 'android');
		const own = android && ts.isObjectLiteralExpression(android) ? android : options;
		const text = (e?: ts.Expression) => (e && ts.isStringLiteralLike(e) ? e.text : null);
		const cap = key[0].toUpperCase() + key.slice(1);
		const getterName = text(option(own, 'nativeGetterName')) ?? `get${cap}`;
		const setterName = text(option(own, 'nativeSetterName')) ?? `set${cap}`;
		const converter = option(options, 'converter');
		const fromNative = converter && ts.isObjectLiteralExpression(converter) ? option(converter, 'fromNative') : undefined;
		const toNative = converter && ts.isObjectLiteralExpression(converter) ? option(converter, 'toNative') : undefined;
		const fallback = option(options, 'defaultValue');
		const t = optionalType(this.typeOf(m.name));
		const read = `${RT.jsNativePropertyGet}(this.native, ${kotlinString(getterName)}, ${RT.jsOr}(${RT.jsField}(this.options, ${kotlinString(key)}), ${fallback ? this.coerce(fallback, 'Any?') : 'null'}))`;
		const converted = fromNative ? `${RT.jsCall}(${this.coerce(fromNative, 'Any?')}, ${read}, ${kotlinString(key)})` : read;
		const write = toNative ? `${RT.jsCall}(${this.coerce(toNative, 'Any?')}, value, ${kotlinString(key)})` : 'value';
		return [`    var ${ident(key)}: ${t}`, `        get() = ${this.fromAnyCode(converted, t)}`, '        set(__value) {', '            val value: Any? = __value', `            ${RT.jsReport} { ${RT.jsSet}(this.options, ${kotlinString(key)}, value) }`, `            ${RT.jsReport} { ${RT.jsNativePropertySet}(this.native, ${kotlinString(setterName)}, ${write}) }`, '        }'].join('\n');
	},
};
