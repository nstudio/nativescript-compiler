// `new` as Kotlin: constructions, arrays, errors and RegExp.
import ts from 'typescript';
import { BUFFER_TYPES, ERRORS, errorArguments, isLibGlobal } from '../semantics/globals.ts';
import { ident, isNullable, kotlinString, mentions, splitTopLevel, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { intlConstructor } from '../semantics/lang.ts';
import { isKit, isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import { hasModifier, isLibDeclaration } from '../semantics/ast.ts';
import { isPromiseType } from '../semantics/spelled.ts';

export const constructionMethods = {
	/** `new RegExp(…)`: from a pattern, or a copy of an expression with its flags unless others are given. */
	regExpConstruct(this: Translator, args: readonly ts.Expression[], call = false): string {
		if (args[0] && this.isRegExp(args[0])) return `${this.expr(args[0])}.let { __re -> JSRegExp(__re.source, ${args[1] ? this.str(args[1]) : '__re.flags'}) }`;
		if (args[0] && !this.isString(args[0])) return `${RT.jsRegExpConstruct}(${[this.coerce(args[0], 'Any?'), ...(args[1] ? [this.coerce(args[1], 'Any?')] : []), ...(call ? ['call = true'] : [])].join(', ')})`;
		return `JSRegExp(${args[0] ? this.str(args[0]) : '"(?:)"'}${args[1] ? `, ${this.str(args[1])}` : ''})`;
	},

	newExpr(this: Translator, e: ts.NewExpression): string {
		const t = this.typeOf(e);
		let callee: ts.Expression = e.expression;
		while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
		const name = ts.isIdentifier(callee) ? callee.text : '';
		const args = e.arguments ?? ts.factory.createNodeArray();
		if (this.library && ts.isClassExpression(callee) && !args.length) return this.classExpressionObject(callee);
		if (name === 'Worker' && this.workerScripts && args.length) {
			const script = this.workerScript(args[0]);
			if (script) return `JSWorker(${this.coerce(args[0], 'Any?')}, ${kotlinString(script)})`;
		}
		if (BUFFER_TYPES.has(name) && this.resolve(callee)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return this.newBuffer(name, args);
		if (/^JS(Map|Set)</.test(t)) {
			if (!args.length) return `${t}()`;
			const src = args[0];
			if (ts.isArrayLiteralExpression(src) && isKit(spelledType(t), 'JSMap')) {
				const [k, v] = splitTopLevel(/^JSMap<(.*)>$/.exec(t)![1]);
				return `${t}(listOf(${src.elements.map((x) => (ts.isArrayLiteralExpression(x) ? `Pair<${k}, ${v}>(${this.coerce(x.elements[0], k)}, ${this.coerce(x.elements[1], v)})` : this.expr(x))).join(', ')}))`;
			}
			// An untyped source: nothing for null or undefined, each value converted to the collection's types.
			if (this.isAny(src) && !this.library) {
				const set = /^JSSet<(.*)>$/.exec(t)?.[1];
				if (set) return `${t}(${RT.jsCollectionSource}(${this.expr(src)})${isUntyped(spelledType(set)) ? '' : `.map { ${this.fromAnyCode('it', set, true)} }`})`;
				const [k, v] = splitTopLevel(/^JSMap<(.*)>$/.exec(t)![1]);
				return `${t}(${RT.jsMapEntries}(${this.expr(src)})${isUntyped(spelledType(k)) && isUntyped(spelledType(v)) ? '' : `.map { Pair<${k}, ${v}>(${this.fromAnyCode('it.first', k, true)}, ${this.fromAnyCode('it.second', v, true)}) }`})`;
			}
			return `${t}(${this.iterable(src)})`;
		}
		if (isPromiseType(parseNativeType(t))) {
			const v = t.replace(/^JSPromise<(.*)>$/, '$1');
			const ex = args[0];
			if (!ex || !(ts.isArrowFunction(ex) || ts.isFunctionExpression(ex))) throw this.error(e, 'a Promise executor that is not a function literal');
			const r = this.fresh('__resolvers');
			const [res, rej] = ex.parameters.map((p) => p.name as ts.Identifier);
			const binds: string[] = [];
			if (res) {
				this.resolvers.set(this.resolve(res)!, { name: r, type: v });
				binds.push(v === 'Unit' ? `val ${ident(res.text)}: (${v}) -> Unit = { _: Unit? -> ${r}.resolve(Unit) }` : `val ${ident(res.text)}: (${v}) -> Unit = { ${r}.resolve(it) }`);
			}
			if (rej) binds.push(`val ${ident(rej.text)}: (Any?) -> Unit = { ${r}.reject(it) }`);
			const label = this.fresh('executor');
			const body = this.functionBody(ex, 'Unit', this.indent, label);
			const inner = this.indent + '    ';
			// `resolve(x)` calls the resolvers directly: a binding only where the body takes the function itself.
			const used = binds.filter((b) => mentions(body, /^val (\S+):/.exec(b)![1]));
			const lines = body.slice(2, body.lastIndexOf('\n')).split('\n');
			if (lines.at(-1)?.replace(/^\/\*@ns:[^*]*\*\//, '') === `${inner}return@${label}`) lines.pop();
			const text = [...used.map((b) => inner + b), ...lines].join('\n');
			return `JSPromise<${v}> ${text.includes(`return@${label}`) ? `${label}@` : ''}{ ${r}: JSResolvers<${v}> ->\n${text}\n${this.indent}}`;
		}
		if (ERRORS[name]) {
			const appError = ts.isIdentifier(callee) && !isLibGlobal(this, callee) && !(this.resolve(callee)?.declarations ?? []).every((d) => isLibDeclaration(d));
			if (!appError) return this.errorValue(name, args);
		}
		if (name === 'Date' && isLibGlobal(this, callee as ts.Identifier)) {
			// An untyped value (a JSON field): a string parsed, anything else as its number, as the constructor tells them apart at run time.
			if (args.length === 1 && this.isAny(args[0])) return `${RT.jsNewDate}(${this.expr(args[0])})`;
			if (args.length === 1) return `JSDate(${this.isString(args[0]) ? this.expr(args[0]) : this.toNumber(args[0])})`;
			return `JSDate(${args.map((a) => this.toNumber(a)).join(', ')})`;
		}
		this.refuseWrapper(e);
		// `new String(x)`, `new Number(x)`, `new Boolean(x)`: script's wrapper objects, held as the value they wrap.
		if (this.library && ['String', 'Number', 'Boolean'].includes(name) && isLibGlobal(this, callee as ts.Identifier) && args.length === 1) return name === 'String' ? this.str(args[0]) : name === 'Number' ? this.toNumber(args[0]) : this.cond(args[0]);
		if (name === 'RegExp') return this.regExpConstruct(args);
		const intl = intlConstructor(callee, this.checker);
		if (intl) return `JS${intl}(${args.map((a) => this.coerce(a, 'Any?')).join(', ')})`;
		this.refuseIntl(callee);
		// `new Object()`: an empty object.
		if (name === 'Object' && isLibGlobal(this, callee as ts.Identifier) && !args.length) return 'JSObject()';
		// `new Object(v)`: v itself, a new object for undefined and null (a primitive stays one, as `new String(x)` does).
		if (name === 'Object' && isLibGlobal(this, callee as ts.Identifier)) {
			const made = `(${this.coerce(args[0], 'Any?')}).let { if (${RT.jsIsNullish}(it)) JSObject() else it }`;
			return isUntyped(spelledType(t)) ? made : this.fromAny(made, t);
		}
		if (name === 'WeakRef' && isLibGlobal(this, callee as ts.Identifier)) {
			const target = this.expr(args[0]);
			// Core's untyped target may be a primitive it holds boxed (as Swift's jsCoreWeakTarget does); an app's is an object.
			if (this.isAny(args[0]) && !this.library) return `${t}(${RT.jsWeakTarget}(${this.unasserted(target)}))`;
			return `${t}(${this.isAny(args[0]) || (this.library && isNullable(this.declaredTypeOf(args[0]) ?? this.typeOf(args[0]))) ? `${RT.jsWeakRefTarget}(${this.unasserted(target)})` : target})`;
		}
		if ((name === 'WeakMap' || name === 'WeakSet') && isLibGlobal(this, callee as ts.Identifier)) return args.length ? `${t}(${this.iterable(args[0])})` : `${t}()`;
		if (name === 'Array' && isLibGlobal(this, callee as ts.Identifier)) return this.arrayConstruct(e, t, args);
		const core = this.core?.construct(e) ?? this.native?.construct(e);
		if (core) return core;
		return this.newExprRest(e, t, callee, name);
	},

	/** `new Array(…)`, or `Array(…)`, which constructs the same. */
	arrayConstruct(this: Translator, e: ts.NewExpression | ts.CallExpression, t: string, args: ts.NodeArray<ts.Expression>): string {
		{
			const el = t.replace(/^JSArray<(.*)>$/, '$1');
			if (args.length !== 1) return args.length ? `${RT.jsArrayOf}<${el}>(${args.map((a) => this.coerce(a, el)).join(', ')})` : `${t}()`;
			if (this.typeOf(args[0]) !== 'Double') {
				// Lenient code: a length or the one element, as the value is when this runs.
				if (this.isAny(args[0]) && this.lenient && (isUntyped(spelledType(el)) || el.endsWith('?'))) return `run { val __n: Any? = ${this.expr(args[0])}; if (__n is Double) ${RT.jsArrayFilled}<${el}>(__n, null) else ${RT.jsArrayOf}<${el}>(__n as ${el}) }`;
				// A value TypeScript types as no number (a core interface Kotlin holds untyped): the one element.
				const declared = this.checker.getTypeAtLocation(args[0]);
				const element = !(declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NumberLike | ts.TypeFlags.TypeParameter)) && !(declared.isUnion() && declared.types.some((u) => u.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Any)));
				if (this.isAny(args[0]) && !element && !(this.lenient && !isUntyped(spelledType(el)) && el !== 'Double')) throw this.error(e, 'new Array of one untyped value (a length or an element)');
				return `${RT.jsArrayOf}<${el}>(${this.coerce(args[0], el)})`;
			}
			if (el.endsWith('?') || ['Double', 'String', 'Boolean'].includes(el)) return `${RT.jsArrayOfHoles}<${el}>(${this.toNumber(args[0])})`;
			throw this.error(e, `new Array of a length, of ${el} (empty slots need an optional element type)`);
		}
	},

	newExprRest(this: Translator, e: ts.NewExpression, t: string, callee: ts.Expression, name: string): string {
		// `new Trace.Writer()`: a namespace's class.
		if (ts.isPropertyAccessExpression(callee) && this.namespaceMember(callee)) return `${t}(${this.args(e).join(', ')})`;
		if (!this.library && this.constructsHeldClass(e)) {
			const code = `${RT.jsNew}(${this.coerce(callee, 'Any?')}${this.untypedArgs(e)})`;
			return isUntyped(spelledType(t)) ? code : this.fromAnyCode(code, t);
		}
		if (ts.isIdentifier(callee)) {
			const hooked = this.framework.hooks.newCall?.(this, name, e);
			if (hooked !== undefined) return hooked;
			this.refuseFunctionNew(e);
			const decl = this.checker.getTypeAtLocation(callee).getSymbol()?.valueDeclaration;
			if (decl && ts.isClassLike(decl) && !decl.getSourceFile().isDeclarationFile) return `${isUntyped(spelledType(t)) && ts.isClassDeclaration(decl) ? this.className(decl) : t}(${this.args(e).join(', ')})`;
			// Library mode: a variable holding a class (`new ListViewAdapterClass(this)`): the class its instances have, else the one it holds when this runs.
			const held = this.resolve(callee)?.valueDeclaration;
			if (this.library && held && ts.isVariableDeclaration(held) && !held.getSourceFile().isDeclarationFile) {
				const made = this.checker.getTypeAtLocation(e).getSymbol()?.valueDeclaration;
				if (made && ts.isClassDeclaration(made) && !made.getSourceFile().isDeclarationFile && !this.native?.isNativeDeclaration(made)) return `${this.className(made)}(${this.args(e).join(', ')})`;
				const code = `${RT.jsNew}(${this.expr(callee)}${this.untypedArgs(e)})`;
				return isUntyped(spelledType(t)) ? code : this.fromAnyCode(code, t);
			}
			// What script constructs untyped (a class looked up in a table).
			if (isUntyped(spelledType(t)) && (this.library || this.isAny(callee))) return `${RT.jsNew}(${this.coerce(callee, 'Any?')}${this.untypedArgs(e)})`;
			// A variable a lazily defined class is assigned to (`PagerAdapter = PagerAdapterImpl as any` in `initPagerAdapter()`): that class.
			const lazy = !this.library && held && ts.isVariableDeclaration(held) ? this.assignedClass(held) : null;
			if (lazy) return `${this.className(lazy)}(${this.args(e).join(', ')})`;
			return `${t}(${this.args(e).join(', ')})`;
		}
		this.refuseFunctionNew(e);
		// `new (initializeImpl())()`: the class a value of that class's type holds, once the value is computed.
		const made = this.checker.getTypeAtLocation(e).getSymbol()?.valueDeclaration;
		if (this.library && made && ts.isClassDeclaration(made) && !made.getSourceFile().isDeclarationFile && !hasModifier(made, ts.SyntaxKind.DeclareKeyword)) return `run { ${this.exprStatement(callee)}; ${t}(${this.args(e).join(', ')}) }`;
		// Library mode: `new (initNativeScriptLifecycleCallbacks())()`, the class the call gives, constructed when this runs; and
		// what any code constructs untyped (`new global.X.Y()`).
		// A class held in a field or parameter (`new this.schedulerActionCtor(this, work)`): constructed when this runs.
		if (this.library || this.isAny(callee) || this.checker.getTypeAtLocation(callee).getConstructSignatures().length) {
			const code = `${RT.jsNew}(${this.coerce(callee, 'Any?')}${this.untypedArgs(e)})`;
			return isUntyped(spelledType(t)) ? code : this.fromAnyCode(code, t);
		}
		throw this.error(e, 'new');
	},

	/** The one source class a module variable is ever assigned, as plugins define their Java subclasses lazily. */
	assignedClass(this: Translator, d: ts.VariableDeclaration): ts.ClassDeclaration | null {
		if (!ts.isIdentifier(d.name) || d.initializer || !ts.isVariableDeclarationList(d.parent) || !ts.isVariableStatement(d.parent.parent) || !ts.isSourceFile(d.parent.parent.parent)) return null;
		const sym = this.checker.getSymbolAtLocation(d.name);
		const found = new Set<ts.ClassDeclaration>();
		let other = false;
		const visit = (n: ts.Node): void => {
			if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && this.checker.getSymbolAtLocation(n.left) === sym) {
				const decl = this.resolve(ts.skipOuterExpressions(n.right))?.valueDeclaration;
				if (decl && ts.isClassDeclaration(decl) && !decl.getSourceFile().isDeclarationFile) found.add(decl);
				else other = true;
			}
			ts.forEachChild(n, visit);
		};
		visit(d.getSourceFile());
		return !other && found.size === 1 ? [...found][0] : null;
	},

	/** One of the library's error classes, constructed: an AggregateError takes its errors first. */
	errorValue(this: Translator, name: string, args: readonly ts.Expression[]): string {
		return `${ERRORS[name]}(${this.errorArgs(name, args).join(', ')})`;
	},

	/** The runtime error class's constructor arguments for a library error class's (`new Error(…)`, `super(…)`). */
	errorArgs(this: Translator, name: string, args: readonly ts.Expression[]): string[] {
		const { errors: list, message: first, options } = errorArguments(name, args);
		const errors = name === 'AggregateError' ? [list ? `JSArray<Any?>((${this.iterable(list)}).toList())` : 'JSArray<Any?>()'] : [];
		// An optional string parameter left out (`new Error(message)` of `message?: string`): no message, as undefined gives none.
		const param = first && ts.isIdentifier(first) ? this.resolve(first)?.valueDeclaration : undefined;
		const message = first && param && ts.isParameter(param) && /^String\??$/.test(this.typeOf(first)) && isNullable(this.paramType(param)) ? `(${this.expr(first)} ?: "")` : first ? this.str(first) : null;
		const cause = options ? [`${RT.jsGetIfPresent}(${this.coerce(options, 'Any?')}, "cause")`] : [];
		return [...errors, ...(message ? [message] : cause.length ? ['""'] : []), ...cause];
	},
};
