// `new` as Swift: constructions, typed arrays, arrays and errors.
import ts from 'typescript';
import { isTypedArrayType } from './library.ts';
import { ERRORS, TYPED_ARRAYS, errorArguments, isWebClass, isLibGlobal } from '../semantics/globals.ts';
import { ident, isOptional, splitTopLevel, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { intlConstructor } from '../semantics/lang.ts';
import { isArrayLengthLiteral, isAsync } from '../semantics/throws.ts';
import { isLibDeclaration } from '../semantics/ast.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { constClassExpr, constructorOf } from '../semantics/classes.ts';

export const constructionMethods = {
	/** The library error a class is under whose constructors, its own and its program bases', are none; null for another class. */
	libErrorConstructed(this: Translator, cls: ts.ClassLikeDeclaration): string | null {
		for (let c: ts.ClassLikeDeclaration | undefined = cls; c;) {
			if (c.members.some(ts.isConstructorDeclaration)) return null;
			const h: ts.ExpressionWithTypeArguments | undefined = c.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			if (!h) return null;
			if (ts.isIdentifier(h.expression) && ERRORS[h.expression.text] && (this.resolve(h.expression)?.declarations ?? []).some(isLibDeclaration)) return h.expression.text;
			const d: ts.Declaration | undefined = this.checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
			c = d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
		}
		return null;
	},

	/** `new Float32Array(x, …)`: a length, a view of a buffer's bytes, or values converted. */
	newTypedArray(this: Translator, t: string, args: readonly ts.Expression[]): string {
		const a = args[0];
		if (!a) return `${t}(length: 0)`;
		const at = this.typeOf(a).replace(/!$/, '');
		if (at === 'Double') return `${t}(length: ${this.expr(a)})`;
		if (at === 'JSArrayBuffer') return `${t}(buffer: ${[this.expr(a), ...args.slice(1).map((x) => this.toNumber(x))].join(', ')})`;
		if (args.length > 1) return `${t}.from(${[this.coerce(a, 'Any?'), ...args.slice(1).map((x) => this.toNumber(x))].join(', ')})`;
		return this.typedArrayOf(t, a);
	},

	/** A typed array of an iterable's or an array-like's values (`new Float32Array(xs)`, `Float32Array.from(xs)`). */
	typedArrayOf(this: Translator, t: string, a: ts.Expression): string {
		const at = this.typeOf(a).replace(/!$/, '');
		const value = t.startsWith('JSBig') ? 'JSBigInt' : 'Double';
		if (isTypedArrayType(at)) return `${t}(${this.expr(a)})`;
		if (at === `JSArray<${value}>`) return `${t}(${this.expr(a)}.storage)`;
		if (/^JSArray<.*>$/.test(at)) return `${t}(${this.coerce(a, 'JSArray<Any?>')}.storage)`;
		if (!isOptional(at) && !isUntyped(spelledType(at)) && this.elementTypeOf(a) === value) return `${t}(Array(${this.iterable(a)}))`;
		return `${t}.from(${this.coerce(a, 'Any?')})`;
	},

	/** `new Array(n)`'s length as a Swift count: a RangeError where n is no array length. */
	arrayLength(this: Translator, n: ts.Expression): string {
		return isArrayLengthLiteral(n) ? String(Number((n as ts.NumericLiteral).text)) : `${RT.jsArrayLength}(${this.toNumber(n)})`;
	},

	/** `new Array(…)`, or `Array(…)` called, which JavaScript treats the same. */
	isArrayConstruction(this: Translator, e: ts.Expression): e is ts.NewExpression | ts.CallExpression {
		if (!(ts.isNewExpression(e) || ts.isCallExpression(e)) || !ts.isIdentifier(e.expression) || e.expression.text !== 'Array') return false;
		return ts.isNewExpression(e) || isLibGlobal(this, e.expression);
	},

	/** An array constructed by the global `Array`, with or without `new`; null when `Array` is the program's own. */
	newArray(this: Translator, e: ts.NewExpression | ts.CallExpression, t: string, args: readonly ts.Expression[]): string | null {
		// `new Array(n)` of a type holding undefined: n holes, each read as undefined.
		if (args.length === 1 && this.typeOf(args[0]) === 'Double' && /^JSArray<(Any\?|.*\?)>$/.test(t)) return `${t}(Array(repeating: nil, count: ${this.arrayLength(args[0])}))`;
		if (!isLibGlobal(this, e.expression as ts.Identifier)) return null;
		const el = t.replace(/^JSArray<(.*)>$/, '$1');
		if (args.length !== 1) return `${t}([${args.map((a) => this.coerce(a, el)).join(', ')}])`;
		if (this.typeOf(args[0]) !== 'Double') {
			// One untyped value: a length or the one element, as it turns out at run time.
			if (this.isAny(args[0])) return t === 'JSArray<Any?>' ? `${RT.jsNewArray}(${this.expr(args[0])})` : this.arrayOf(`${RT.jsNewArray}(${this.expr(args[0])})`, el);
			return `${t}([${this.coerce(args[0], el)}])`;
		}
		if (el === 'Double' || el === 'String') return `${t}.holes(Double(${this.arrayLength(args[0])}))`;
		// n empty slots: a boolean cannot hold undefined, so false stands in until written.
		if (el === 'Bool') return `${t}(Array(repeating: false, count: ${this.arrayLength(args[0])}))`;
		throw this.error(e, `new Array of a length, of ${el} (empty slots need an optional element type)`);
	},

	newExpr(this: Translator, e: ts.NewExpression): string {
		if (ts.isParenthesizedExpression(e.expression)) {
			// `new (Cls as any)(…)`: the class itself constructed; a cast left in would be parenthesized again.
			let inner: ts.Expression = e.expression;
			while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
			// A call (`new (NSObject.extend({…}))()`) stays parenthesized: `new` would take the call's callee for its own.
			if (!ts.isParenthesizedExpression(inner) && !ts.isCallExpression(inner)) {
				const cls = this.resolve(inner);
				const made = ts.factory.updateNewExpression(e, inner as ts.LeftHandSideExpression, e.typeArguments, e.arguments);
				if (cls && cls.flags & ts.SymbolFlags.Class) this.constructedTypes.set(made, this.type(this.checker.getDeclaredTypeOfSymbol(cls), e));
				return this.newExpr(made);
			}
		}
		const t = this.constructedTypes.get(e) ?? this.typeOf(e);
		const callee = e.expression;
		const ce = constClassExpr(callee, this.checker);
		if (ce) return `${this.emitClassExpr(ce)}(${this.args(e).join(', ')})`;
		const name = ts.isIdentifier(callee) ? callee.text : '';
		const args = e.arguments ?? ts.factory.createNodeArray();
		// A program's class extending Set or Map without its own constructor: made from an iterable as the collection is.
		const own = ts.isIdentifier(callee) ? this.resolve(callee)?.valueDeclaration : undefined;
		const collection = own && ts.isClassLike(own) && !own.getSourceFile().isDeclarationFile && !constructorOf(own, this.checker) ? this.instantiatedCollection(e) : null;
		if (/^JS(Map|Set)</.test(t) || (collection && /^JS(Map|Set)</.test(collection))) {
			if (!args.length) return `${t}()`;
			const src = args[0];
			// A Set of typed values from an untyped iterable (`new GPUSupportedFeatures(native.features)`): each value converted.
			const element = /^JSSet<(.*)>$/.exec(collection ?? t)?.[1];
			if (element && this.isAny(src)) return `${t}(try ${RT.jsCollectionSource}(${this.expr(src)})${isUntyped(spelledType(element)) ? '' : `.map { ${this.fromAnyCode('$0', element, true)} }`})`;
			// Entries written in place take the map's own types (a function value, which lenient code would hold optional).
			const entry = /^JSMap<(.*)>$/.exec(collection ?? t)?.[1];
			if (entry && this.isAny(src)) {
				const [k, v] = splitTopLevel(entry);
				return `${t}(try ${RT.jsMapEntries}(${this.expr(src)})${isUntyped(spelledType(k)) && isUntyped(spelledType(v)) ? '' : `.map { (${this.fromAnyCode('$0.0', k, true)}, ${this.fromAnyCode('$0.1', v, true)}) }`})`;
			}
			if (entry && ts.isArrayLiteralExpression(src) && splitTopLevel(entry).length === 2) return `${t}(${this.coerce(src, `JSArray<(${splitTopLevel(entry).join(', ')})>`)})`;
			return `${t}(${this.iterable(src)})`;
		}
		if (isKit(spelledType(t), 'JSPromise')) {
			const v = t.replace(/^JSPromise<(.*)>$/, '$1');
			const ex = args[0];
			if (!ex || !(ts.isArrowFunction(ex) || ts.isFunctionExpression(ex))) throw this.error(e, 'a Promise executor that is not a function literal');
			const r = this.fresh('__resolvers');
			const [res, rej] = ex.parameters.map((p) => p.name as ts.Identifier);
			const binds: string[] = [];
			if (res) this.resolvers.set(this.resolve(res)!, { name: r, type: v });
			// An async executor's own promise is dropped, as the Promise constructor ignores what the executor returns.
			const lowered = this.functionBody(ex, 'Void', this.indent);
			// Bindings only for the names the body still reads (calls of resolve are the resolvers'; a catch that cannot run reads nothing).
			const reads = (name: ts.Identifier) => new RegExp(`(?<![\\w.])${ident(name.text).replace(/`/g, '')}\\b`).test(lowered);
			if (res && reads(res)) binds.push(v === 'Void' ? `let ${ident(res.text)}: () -> Void = { ${r}.resolve() }` : `let ${ident(res.text)}: (${v}) -> Void = { ${r}.resolve($0) }`);
			if (rej && reads(rej)) binds.push(`let ${ident(rej.text)}: (Any?) -> Void = { ${r}.reject($0) }`);
			const body = isAsync(ex) ? lowered.replace(/^(\s*)return (__async\d+\.promise)\s*$(?![\s\S]*^\s*return __async\d+\.promise\s*$)/m, '$1_ = $2') : lowered;
			const inner = this.indent + '    ';
			return `${t} { (${r}: JSResolvers<${v}>) throws -> Void in\n${binds.map((b) => inner + b).join('\n')}${body.slice(1)}`;
		}
		if (ERRORS[name] && isLibGlobal(this, callee as ts.Identifier) === false && ERRORS[name] === t) {
			const { message } = errorArguments(name, args);
			return this.errorCall(t, name, args, message ? this.coerce(message, 'String') : undefined);
		}
		if (ERRORS[name]) return this.errorValue(name, args);
		// A program's error class declaring no constructor (`class GPUValidationError extends GPUError {}`): Error's, taking the message as a string.
		const errorClass = ts.isIdentifier(callee) ? this.resolve(callee)?.valueDeclaration : undefined;
		const libError = errorClass && ts.isClassDeclaration(errorClass) && !errorClass.getSourceFile().isDeclarationFile ? this.libErrorConstructed(errorClass) : null;
		if (libError) {
			// An undefined message is none, as Error's constructor reads it.
			const given = errorArguments(libError, args).message;
			const message = !given ? '""' : this.typeOf(given) === 'String' ? this.expr(given) : `${RT.jsStringOrEmpty}(${this.coerce(given, 'Any?')})`;
			return this.errorCall(t, libError, args, message);
		}
		if (name === 'Date' && isLibGlobal(this, callee as ts.Identifier)) {
			if (args.length === 1 && this.typeOf(args[0]) !== 'Double' && !this.isString(args[0])) return `${RT.jsNewDate}(${this.coerce(args[0], 'Any?')})`;
			if (args.length === 1) return `JSDate(${this.isString(args[0]) ? this.expr(args[0]) : this.toNumber(args[0])})`;
			return `JSDate(${args.map((a) => this.toNumber(a)).join(', ')})`;
		}
		// A pattern that may be a RegExp itself (`new RegExp(/…/g)`) gives its source and flags, not its string form.
		if (name === 'RegExp' && args[0] && !this.isString(args[0])) return `JSRegExp.construct(${this.coerce(args[0], 'Any?')}${args[1] ? `, ${this.coerce(args[1], 'Any?')}` : ''})`;
		if (name === 'RegExp') return `JSRegExp(${this.str(args[0])}${args[1] ? `, ${this.str(args[1])}` : ''})`;
		const intl = intlConstructor(callee, this.checker);
		if (intl) return `JS${intl}(${args.map((a) => this.coerce(a, 'Any?')).join(', ')})`;
		this.refuseIntl(callee);
		// `new Object()`: an empty object.
		if (name === 'Object' && isLibGlobal(this, callee as ts.Identifier) && !args.length) return 'JSObject()';
		// `new Object(v)`: v itself, a new object for undefined and null (a primitive stays one, as `new String(x)` does).
		if (name === 'Object' && isLibGlobal(this, callee as ts.Identifier)) {
			const made = `{ (__v: Any?) -> Any? in ${RT.jsIsNullish}(__v) ? JSObject() : __v }(${this.coerce(args[0], 'Any?')})`;
			return isUntyped(spelledType(t)) ? made : this.fromAny(made, t);
		}
		this.refuseWrapper(e);
		// `new Number(x)`, `new Boolean(x)`, `new String(x)` in library mode: the primitive.
		if (['Number', 'Boolean', 'String'].includes(name) && isLibGlobal(this, callee as ts.Identifier)) {
			const value = args[0] ? this.coerce(args[0], 'Any?') : 'nil';
			const primitive = name === 'Number' ? `${RT.jsToNumber}(${value})` : name === 'Boolean' ? `${RT.jsTruthy}(${value})` : args[0] ? `${RT.jsToString}(${value})` : '""';
			return isUntyped(spelledType(t)) ? `(${primitive} as Any?)` : primitive;
		}
		const hooked = this.framework.hooks.newCall?.(this, name, e);
		if (hooked !== undefined) return hooked;
		if (name === 'WeakRef' && isLibGlobal(this, callee as ts.Identifier)) {
			// Where a weak reference to any object is declared (`instance: WeakRef<any>`), made as one.
			const context = this.checker.getContextualType(e);
			const wanted = context ? this.type(context, e).replace(/[?!]$/, '') : '';
			// A reference to a subclass's object where one to the base class's is wanted, made as that.
			const ref = wanted === 'JSWeakRef<AnyObject>' || (/^JSWeakRef<\w+>$/.test(wanted) && this.isSubclassOf(t.slice(10, -1), wanted.slice(10, -1))) ? wanted : t;
			if (ref !== 'JSWeakRef<AnyObject>') return `${ref}(${this.expr(args[0])})`;
			return `${ref}(${this.isAny(args[0]) ? `${this.library ? RT.jsCoreWeakTarget : RT.jsWeakTarget}(${this.expr(args[0])})` : `(${this.coerce(args[0], 'Any?')} as AnyObject)`})`;
		}
		if ((name === 'WeakMap' || name === 'WeakSet') && isLibGlobal(this, callee as ts.Identifier)) return args.length ? `${t}(${this.iterable(args[0])})` : `${t}()`;
		// `new interop.Reference(type, value)`: the type is only the runtime's; a sole argument of `interop.types` is a type too.
		// `new interop.Pointer()`: the null pointer; one at an address is a value no compiled code has.
		if (t === 'InteropPointer') {
			if (args.length) throw this.error(e, 'interop.Pointer at an address');
			return 'InteropPointer()';
		}
		if (t === 'InteropReference') {
			const isType = (x: ts.Expression) => ts.isPropertyAccessExpression(x) && x.expression.getText() === 'interop.types';
			const value = args.length > 1 ? args[1] : args[0] && !isType(args[0]) ? args[0] : undefined;
			return `InteropReference(${value ? this.coerce(value, 'Any?') : ''})`;
		}
		if (name === 'ArrayBuffer' && isLibGlobal(this, callee as ts.Identifier)) return `JSArrayBuffer(${args[0] ? this.toNumber(args[0]) : ''})`;
		if (TYPED_ARRAYS.includes(name) && isLibGlobal(this, callee as ts.Identifier)) return this.newTypedArray(`JS${name}`, args);
		if (name === 'DataView' && isLibGlobal(this, callee as ts.Identifier)) {
			const rest = args.slice(1).map((x) => this.toNumber(x));
			if (args[0] && this.typeOf(args[0]).replace(/!$/, '') === 'JSArrayBuffer') return `JSDataView(buffer: ${[this.expr(args[0]), ...rest].join(', ')})`;
			return `JSDataView.from(${[args[0] ? this.coerce(args[0], 'Any?') : 'nil', ...rest].join(', ')})`;
		}
		if (name === 'Array') {
			const made = this.newArray(e, t, args);
			if (made) return made;
		}
		const core = this.core.construct(e) ?? this.native.construct(e);
		if (core) return core;
		// `new UIEdgeInsets({ top, left, bottom, right })`: the struct from its fields.
		if (this.native.isStructType(t) && args.length === 1 && ts.isObjectLiteralExpression(args[0])) return this.coerce(args[0], t);
		// `new CATransform3D(CATransform3DIdentity)`: a copy of the struct, which a Swift value is.
		if (this.native.isStructType(t) && args.length === 1 && this.typeOf(args[0]) === t) return this.expr(args[0]);
		if (this.native.isStructType(t) && !args.length) return `${t}()`;
		// A web class the runtime has (`new TextEncoder()`), declared by the DOM's library for core's own code: the runtime's class.
		if (ts.isIdentifier(callee) && isWebClass(this.ledger, name) && t === `JS${name}` && !!this.resolve(callee)?.declarations?.[0]?.getSourceFile().isDeclarationFile) return `${t}(${this.args(e).join(', ')})`;
		this.refuseFunctionNew(e);
		// An untyped constructor (a moot module's class): constructed as script would, which a moot value refuses.
		if (this.isAny(callee)) return isUntyped(spelledType(t)) ? `NativeScriptKit.jsConstruct(${this.expr(callee)}${this.untypedArgs(e)})` : this.fromAny(`NativeScriptKit.jsConstruct(${this.expr(callee)}${this.untypedArgs(e)})`, t);
		// `new Trace.Writer()`: a namespace's class.
		if (ts.isPropertyAccessExpression(callee) && this.namespaceMember(callee)) return `${t}(${this.args(e).join(', ')})`;
		// A class held in a variable, field or parameter as a metatype (`new this.schedulerActionCtor(...)`): constructed dynamically.
		if (this.constructsHeldClass(e) || (/\.Type[?!]?$/.test(this.typeOf(callee)) && (!ts.isIdentifier(callee) || !((this.resolve(callee)?.flags ?? 0) & ts.SymbolFlags.Class)))) {
			return isUntyped(spelledType(t)) ? `NativeScriptKit.jsConstruct(${this.expr(callee)}${this.untypedArgs(e)})` : this.fromAny(`NativeScriptKit.jsConstruct(${this.expr(callee)}${this.untypedArgs(e)})`, t);
		}
		if (ts.isIdentifier(callee)) {
			const decl = this.checker.getTypeAtLocation(callee).getSymbol()?.valueDeclaration;
			if (decl && ts.isClassLike(decl) && !decl.getSourceFile().isDeclarationFile) return `${t}(${this.args(e).join(', ')})`;
			if (!args.length) return `${t}()`;
			return `${t}(${this.args(e).join(', ')})`;
		}
		throw this.error(e, 'new');
	},

	/** One of the library's error classes, constructed. */
	errorValue(this: Translator, name: string, args: readonly ts.Expression[]): string {
		return this.errorCall(ERRORS[name], name, args);
	},

	/**
	 * `initializer(…)` given a library error class's arguments (`new Error(…)`, `super(…)`) as the runtime error class's
	 * initializer takes them; `spelled` the message's.
	 */
	errorCall(this: Translator, initializer: string, name: string, args: readonly ts.Expression[], spelled?: string): string {
		const { errors: list, message, options } = errorArguments(name, args);
		const errors = name === 'AggregateError' ? [`errors: ${list ? this.coerce(list, 'JSArray<Any?>') : 'JSArray<Any?>()'}`] : [];
		const cause = options ? [`cause: ${RT.jsField}(${this.coerce(options, 'Any?')}, "cause")`] : [];
		const text = spelled ?? (message ? this.str(message) : undefined);
		return `${initializer}(${[...errors, ...(text ? [text] : cause.length ? ['""'] : []), ...cause].join(', ')})`;
	},
};
