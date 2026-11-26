// Calls of statics as Swift: staticCall, Object.defineProperties and the promise combinators.
import ts from 'typescript';
import { TYPED_ARRAYS } from '../semantics/globals.ts';
import { ident, isFunctionType, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { literalKey, statementLevel, undefinedLiteral } from '../semantics/lang.ts';
import { arrayFromLengthInit } from '../semantics/ast.ts';
import { assignsArrayIntoObject, definesDuringConstruction, restrictsField, definedField, shapeArrayGuardAccess } from '../semantics/shapes.ts';
import { CONSOLE } from '../semantics/apis/console.ts';
import { staticFunction } from '../semantics/apis/statics.ts';
import { runtimeCall } from '../semantics/apis/api.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const staticCallsMethods = {
	/** `Math.max`, `JSON.parse`, `Object.keys`, `Promise.all`, `console.log`… */
	staticCall(this: Translator, owner: string, member: string, e: ts.CallExpression): string {
		const s = staticFunction(owner, member);
		if (!s) throw this.error(e, `${owner}.${member}`, 'library-member');
		const method = s.name;
		const a = () => this.args(e);
		const arg = (k: number) => e.arguments[k];
		const T = () => this.typeOf(e);
		if (TYPED_ARRAYS.includes(owner) && (method === 'of' || method === 'from')) {
			const t = `JS${owner}`;
			const value = owner.startsWith('Big') ? 'JSBigInt' : 'Double';
			if (method === 'of') return e.arguments.some(ts.isSpreadElement) ? `${t}(${this.packed(e.arguments, `JSArray<${value}>`, this.restSlot(e, value))}.storage)` : `${t}.of(${e.arguments.map((x) => this.restArgument(e, x, value)).join(', ')})`;
			if (e.arguments.length === 1) return this.typedArrayOf(t, arg(0));
			return this.ignoringThisArg(e, arg(0), () => `${t}(JSArray<${this.elementTypeOf(arg(0))}>.from(${this.iterable(arg(0))}).map(${this.fn(arg(1))}).storage)`);
		}
		switch (owner) {
			case 'Math':
				return this.math(method, e);
			case 'ArrayBuffer':
				if (method === 'isView') return `JSArrayBuffer.isView(${arg(0) ? this.restArgument(e, arg(0), 'Any?') : 'nil'})`;
				break;
			case 'console': {
				const fn = RT[CONSOLE[method].op];
				if (e.arguments.some(ts.isSpreadElement)) return `${fn}(spread: ${this.packed(e.arguments, 'JSArray<Any?>', this.restSlot(e, 'Any?'))}.storage)`;
				return `${fn}(${e.arguments.map((x) => this.restArgument(e, x, 'Any?')).join(', ')})`;
			}
			case 'JSON':
				if (method === 'parse') return `${RT.jsJSONParse}(${this.str(arg(0))}${arg(1) ? `, reviver: ${this.restArgument(e, arg(1), 'Any?')}` : ''})`;
				// Undefined, a function or a symbol stringifies to undefined.
				if (method === 'stringify') {
					const replacer = arg(1) && arg(1).kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(arg(1)) && arg(1).getText() === 'undefined') ? `, replacer: ${this.restArgument(e, arg(1), 'Any?')}` : '';
					return this.undefinedAs(`${RT.jsJSONStringifyChecked}(${this.restArgument(e, arg(0), 'Any?')}${arg(2) ? `, ${this.restArgument(e, arg(2), 'Any?')}` : replacer ? ', nil' : ''}${replacer})`, T());
				}
				break;
			case 'Object': {
				// A literal (with spreads) is built as an untyped object whatever record type it has.
				const record = ['keys', 'values', 'entries'].includes(method) && isKit(spelledType(this.typeOf(arg(0))), 'JSRecord') && !ts.isObjectLiteralExpression(arg(0));
				if (record) return `${this.expr(arg(0))}.${method}`;
				// A function's keys are its function object's.
				const keyed = (x: ts.Expression) => (isFunctionType(this.typeOf(x)) ? this.coerce(x, 'Any?') : this.expr(x));
				if (method === 'keys') return `JSArray(${RT.jsKeysOf}(${keyed(arg(0))}))`;
				if (method === 'values' || method === 'entries') {
					const el = T().replace(/^JSArray<(.*)>$/, '$1');
					const declared = method === 'values' ? el : el.replace(/^\(String, (.*)\)$/, '$1');
					const value = this.states.optionalElementsOf(arg(0)) ? optionalType(declared) : declared;
					const read = this.fromAnyCode(`${RT.jsField}(__o, $0)`, value);
					return `{ (__o: Any?) -> JSArray<${method === 'values' ? value : `(String, ${value})`}> in JSArray(${RT.jsKeysOf}(__o).map { ${method === 'values' ? read : `($0, ${read})`} }) }(${keyed(arg(0))})`;
				}
				if (method === 'seal' || method === 'preventExtensions') return `${RT.jsRestrict}(${this.expr(arg(0))}, sealed: ${method === 'seal'})`;
				if (method === 'getOwnPropertyDescriptor') return `${RT.jsOwnPropertyDescriptor}(${this.restArgument(e, arg(0), 'Any?')}, ${this.propertyKey(arg(1))})`;
				if (method === 'defineProperty' || method === 'defineProperties') this.refuseRunTimeDefine(e);
				if (method === 'defineProperties') {
					const d = arg(1);
					if (!ts.isObjectLiteralExpression(d)) this.checkFieldDefinition(arg(0), undefined, d);
					else for (const p of d.properties) this.checkFieldDefinition(arg(0), ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) ? p.name : undefined, ts.isPropertyAssignment(p) ? p.initializer : p);
				}
				if (method === 'defineProperties' && ts.isObjectLiteralExpression(arg(1))) return this.defineProperties(arg(0), arg(1) as ts.ObjectLiteralExpression);
				// The overload by result: `Partial<Record<K, T[]>>` holds optional groups.
				if (method === 'groupBy') return /^JSRecord<.*>$/.test(T()) ? `(${RT.jsObjectGroupBy}(${this.iterable(arg(0))}, ${this.fn(arg(1))}) as ${T()})` : this.fromAnyCode(`${RT.jsObjectGroupBy}(${this.iterable(arg(0))}, ${this.fn(arg(1))}) as JSRecord<Any?>`, T(), true);
				if (method === 'create' && e.arguments.length === 1) return `${RT.jsObjectCreate}(${this.restArgument(e, e.arguments[0], 'Any?')})`;
				if (method === 'defineProperty') {
					const d = arg(2);
					this.checkFieldDefinition(arg(0), arg(1), d);
					const code = `${RT.jsDefineProperty}(${this.restArgument(e, arg(0), 'Any?')}, ${this.propertyKey(arg(1))}, ${ts.isObjectLiteralExpression(d) ? this.dynamicObject(d) : this.coerce(d, 'Any?')})`;
					return isUntyped(spelledType(T())) || statementLevel(e) ? code : this.fromAnyCode(code, T(), true);
				}
				if (method === 'assign') {
					// The target is an open JavaScript object: a literal there is untyped, so the sources' keys all land.
					const target = ts.isObjectLiteralExpression(arg(0)) ? this.dynamicObject(arg(0) as ts.ObjectLiteralExpression) : this.restArgument(e, arg(0), 'Any?');
					// Sources spread from an array (`Object.assign({}, ...parts)`): each of its elements, in order.
					const code = e.arguments.slice(1).some(ts.isSpreadElement) ? `${RT.jsObjectAssign}(${target}, spread: ${this.packed(e.arguments.slice(1), 'JSArray<Any?>')}.storage)` : `${RT.jsObjectAssign}(${[target, ...e.arguments.slice(1).map((x) => this.restArgument(e, x, 'Any?'))].join(', ')})`;
					const t = T();
					if (assignsArrayIntoObject(e, this.checker) && !statementLevel(e)) {
						if (isUntyped(spelledType(t)) || (this.checker.getContextualType(e)?.flags ?? 0) & ts.TypeFlags.Any) return code;
						throw this.error(e, 'Object.assign of an array into an object, typed as the array, read as anything but an untyped value');
					}
					// Properties assigned onto a function (`Object.assign(memoized, { release })`) leave a function, which no class holds.
					const callable = this.checker.getTypeAtLocation(arg(0)).getCallSignatures().length > 0;
					return isUntyped(spelledType(t)) || callable || statementLevel(e) ? code : this.fromAnyCode(code, t, true);
				}
				break;
			}
			case 'Array':
				if (method === 'isArray') {
					const g = !this.library ? shapeArrayGuardAccess(arg(0), (t) => this.isObjectShape(t), (x) => this.typeOf(x)) : null;
					return `JSArray<Any?>.isArray(${g ? `${this.expr(g.prop.expression)}${g.optional ? '?' : ''}[jsKey: ${swiftString(g.prop.name.text)}]` : this.restArgument(e, arg(0), 'Any?')})`;
				}
				if (method === 'from' && e.arguments.length === 1) return `${T()}.from(${this.iterable(arg(0))})`;
				if (method === 'from' && (e.arguments.length === 2 || e.arguments.length === 3) && ts.isObjectLiteralExpression(arg(0))) {
					const lenInit = arrayFromLengthInit(arg(0) as ts.ObjectLiteralExpression);
					const fn = arg(1);
					if (!lenInit || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) throw this.error(e, 'Array.from of this object');
					const el = T().replace(/^JSArray<(.*)>$/, '$1');
					const params = fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
					const index = params[1] ? ident((params[1].name as ts.Identifier).text) : '_';
					const value = params[0] && ts.isIdentifier(params[0].name) && params[0].name.text !== '_' ? `let ${ident(params[0].name.text)}: Any? = nil; ` : '';
					return this.ignoringThisArg(e, arg(0), () => {
						const body = ts.isBlock(fn.body) ? this.functionBody(fn, el, this.indent).slice(1, -1) : ` return ${this.marks.tryBefore(this.tryPrefix(fn.body), this.coerce(fn.body, el))} `;
						return `${T()}.from(length: ${this.expr(lenInit)}) { (${index}: Double) ${this.throwsInfo.fn(fn) ? 'throws ' : ''}-> ${el} in ${value}${body}}`;
					});
				}
				if (method === 'from' && (e.arguments.length === 2 || e.arguments.length === 3)) return this.ignoringThisArg(e, arg(0), () => `JSArray<${this.elementTypeOf(arg(0))}>.from(${this.iterable(arg(0))}).map(${this.expr(arg(1))})`);
				if (method === 'of') return `${T()}([${a().join(', ')}])`;
				// `Array.apply(thisArg, list)`: `Array(...list)`, a length when the list is one number.
				if (method === 'apply' && e.arguments.length === 2) {
					const made = `${RT.jsArrayConstruct}(${this.restArgument(e, arg(1), 'JSArray<Any?>')}.storage)`;
					return T() === 'JSArray<Any?>' ? made : this.fromAny(this.marks.castCode(made, 'Any', 'as'), T());
				}
				break;
			case 'Number':
				// A number that may be undefined (one an untrusted value was placed in) is none of these.
				// Anything but a number is none of these: they do not convert their argument.
				if (['isInteger', 'isSafeInteger', 'isFinite', 'isNaN'].includes(method) && !['Double', 'Double?'].includes(this.typeOf(arg(0)))) {
					const test = method === 'isInteger' ? `${RT.jsIsInteger}($0)` : method === 'isSafeInteger' ? `${RT.jsIsSafeInteger}($0)` : `$0.${method}`;
					return `((${this.coerce(arg(0), 'Any?')} as? Double).map { ${test} } ?? false)`;
				}
				if (['isInteger', 'isSafeInteger', 'isFinite', 'isNaN'].includes(method) && this.typeOf(arg(0)) === 'Double?') {
					const test = method === 'isInteger' ? `${RT.jsIsInteger}($0)` : method === 'isSafeInteger' ? `${RT.jsIsSafeInteger}($0)` : `$0.${method}`;
					return `(${this.expr(arg(0))}.map { ${test} } ?? false)`;
				}
				if (method === 'isInteger') return `${RT.jsIsInteger}(${this.expr(arg(0))})`;
				if (method === 'isSafeInteger') return `${RT.jsIsSafeInteger}(${this.expr(arg(0))})`;
				if (method === 'isFinite') return `${this.expr(arg(0))}.isFinite`;
				if (method === 'isNaN') return `(${this.expr(arg(0))}).isNaN`;
				if (method === 'parseInt') return `${RT.jsParseInt}(${this.str(arg(0))}${arg(1) ? `, ${this.expr(arg(1))}` : ', nil'})`;
				break;
			case 'String':
				if (method === 'fromCharCode' && e.arguments.some(ts.isSpreadElement)) return `${RT.jsFromCharCode}(codes: ${this.packed(e.arguments, 'JSArray<Double>')}.storage)`;
				if (method === 'fromCharCode') return `${RT.jsFromCharCode}(${a().join(', ')})`;
				if (method === 'fromCodePoint' && e.arguments.some(ts.isSpreadElement)) return `${RT.jsFromCodePoint}(codes: ${this.packed(e.arguments, 'JSArray<Double>')}.storage)`;
				if (method === 'fromCodePoint') return `${RT.jsFromCodePoint}(${e.arguments.map((x) => this.restArgument(e, x, 'Double')).join(', ')})`;
				break;
			case 'BigInt':
				if (method === 'asIntN' || method === 'asUintN') return `JSBigInt.${method}(${this.toNumber(arg(0))}, ${this.expr(arg(1))})`;
				break;
			case 'Symbol':
				if (method === 'for') return `JSSymbol.for(${this.str(arg(0))})`;
				if (method === 'keyFor') return `JSSymbol.keyFor(${this.expr(arg(0))})`;
				break;
			case 'Date':
				if (method === 'now') return 'JSDate.now()';
				if (method === 'parse') return `JSDate.parse(${this.str(arg(0))})`;
				if (method === 'UTC') return `JSDate.UTC(${e.arguments.map((x) => this.toNumber(x)).join(', ')})`;
				break;
			case 'Map':
				if (method === 'groupBy') return `${RT.jsMapGroupBy}(${this.iterable(arg(0))}, ${this.fn(arg(1))})`;
				break;
			case 'Promise': {
				if (method === 'withResolvers') return `${T()}()`;
				// `return Promise.resolve(x)` where the function declares the promise's type: that type, the value converted to it.
				const wanted = method === 'resolve' && this.checker.getContextualType(e) ? this.type(this.checker.getContextualType(e)!, e) : null;
				const t = wanted && /^JSPromise<.*>$/.test(wanted) && this.lenient ? wanted : T();
				if (method === 'resolve' && t === 'JSPromise<Void>' && arg(0) && undefinedLiteral(arg(0))) return `${t}.resolve(())`;
				if (method === 'resolve') return arg(0) ? (isKit(spelledType(this.typeOf(arg(0))), 'JSPromise') ? `${t}.resolve(${this.expr(arg(0))})` : `${t}.resolve(${this.restArgument(e, arg(0), t.replace(/^JSPromise<(.*)>$/, '$1'))})`) : `${t}.resolve(())`;
				// `return Promise.reject(err)` from a function giving a promise of a value: rejected, it is that promise as well as any.
				const returned = t === 'JSPromise<Never>' && ts.isReturnStatement(e.parent) && /^JSPromise<.*>$/.test(this.returnType) ? this.returnType : t;
				if (method === 'reject') return `${returned}.reject(${arg(0) ? this.restArgument(e, arg(0), 'Any?') : 'nil'})`;
				if (['all', 'allSettled', 'race', 'any'].includes(method)) {
					const src = arg(0);
					if (ts.isArrayLiteralExpression(src)) return this.promiseCombinator(method, src, t);
					// A variable as Swift holds it, which may be untyped where TypeScript narrowed what it was filled with.
					const typed = /^JSArray<JSPromise<(.*)>>$/.exec((ts.isIdentifier(src) ? this.declaredTypeOf(src) : null) ?? this.typeOf(src));
					if (typed) return `JSPromise<${typed[1]}>.${method}(${this.expr(src)})`;
					// An array of untyped values (`const toClose = []`): the dynamic combinator, its result read as TypeScript types it.
					const code = `JSPromise<Any?>.${method}(${this.coerce(src, 'JSArray<Any?>')})`;
					const made = method === 'all' ? 'JSPromise<JSArray<Any?>>' : method === 'allSettled' ? 'JSPromise<JSArray<JSObject>>' : 'JSPromise<Any?>';
					return t === made ? code : method === 'all' ? this.untypedAll(src, t) : this.convert(code, made, t);
				}
				break;
			}
		}
		// After the owner's cases: a type they read first makes the shape it names, which the output keeps.
		if (s.args) return runtimeCall(this, s, e);
		throw this.error(e, `${owner}.${method}`, 'library-member');
	},

	/**
	 * `Object.defineProperty` on an app class's instance that makes one of its declared fields an accessor, read-only,
	 * hidden or fixed: the class's Swift field keeps none of these.
	 */
	checkFieldDefinition(this: Translator, target: ts.Expression, key: ts.Node | undefined, descriptor: ts.Node): void {
		if (this.library) return;
		const cls = this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)).getSymbol()?.valueDeclaration;
		if (!cls || !ts.isClassLike(cls) || cls.getSourceFile().isDeclarationFile || this.pluginFiles.has(cls.getSourceFile().fileName)) return;
		if (!restrictsField(descriptor)) return;
		const keyText = key && (ts.isStringLiteralLike(key) || ts.isIdentifier(key) || ts.isNumericLiteral(key)) ? key.text : undefined;
		const field = keyText !== undefined ? this.checker.getTypeAtLocation(target).getProperty(keyText)?.valueDeclaration : undefined;
		const declared = !!field && (ts.isPropertyDeclaration(field) || ts.isParameter(field)) && !field.getSourceFile().isDeclarationFile;
		if (keyText !== undefined && !declared) return;
		const during = keyText !== undefined && definesDuringConstruction(target);
		if (keyText !== undefined && !during && definedField(this.states, () => this.shapeFacts(), target, keyText)) return;
		throw this.error(
			key ?? target,
			keyText === undefined ? 'Object.defineProperty with a key known only at run time on a class instance, with a descriptor that may restrict a declared field' : during ? `Object.defineProperty on \`this\` while its class constructs it, making a declared field (${keyText}) an accessor, read-only, hidden or fixed: the constructor and field initializers read the Swift field directly; define it after \`new\` returns` : `Object.defineProperty making a declared field (${keyText}) of a class whose objects keep no descriptor for it (an Error subclass's) an accessor, read-only, hidden or fixed`,
		);
	},

	/**
	 * `Object.defineProperties(object, { key: descriptor, … })`, key by key. A field the object's
	 * class declares takes the descriptor's value; its attributes (writable, enumerable) are not kept.
	 */
	defineProperties(this: Translator, target: ts.Expression, map: ts.ObjectLiteralExpression): string {
		// An object with effects (`this.parent`) is evaluated once.
		if (!this.pure(target) && target.kind !== ts.SyntaxKind.ThisKeyword && !this.subst.has(target)) {
			const tmp = this.fresh('__target');
			const value = `${this.marks.tryBefore(this.tryPrefix(target), this.expr(target))}`;
			this.subst.set(target, tmp);
			// Checked once where it is read into the temporary.
			this.checkedNodes.add(target);
			try {
				return `({ () throws -> Any? in let ${tmp} = ${value}; return try ${this.defineProperties(target, map)} }())`;
			} finally {
				this.subst.delete(target);
				this.checkedNodes.delete(target);
			}
		}
		const type = this.checker.getNonNullableType(this.checker.getTypeAtLocation(target));
		const steps = map.properties
			.map((p) => {
				if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer) || ts.isComputedPropertyName(p.name)) throw this.error(p, 'a property of Object.defineProperties other than a literal descriptor');
				const key = literalKey(p.name, this.checker) ?? p.name.getText();
				const field = type.getProperty(key)?.valueDeclaration;
				if (field && ts.isPropertyDeclaration(field) && !field.getSourceFile().isDeclarationFile && !this.isAny(target) && !definedField(this.states, () => this.shapeFacts(), target, key)) {
					const value = p.initializer.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText() === 'value');
					return value ? `${this.marks.tryBefore(this.tryPrefix(value.initializer), this.expr(target))}.${ident(key)} = ${this.coerce(value.initializer, this.typeOf(field.name))}` : '';
				}
				return this.marks.tryCode(`${RT.jsDefineProperty}(${this.coerce(target, 'Any?')}, ${swiftString(key)}, ${this.dynamicObject(p.initializer)})`);
			})
			.filter(Boolean);
		return `({ () throws -> Any? in ${steps.join('; ')}; return ${this.coerce(target, 'Any?')} }())`;
	},

	/** `Promise.all(values)` of untyped values whose result is typed (`Promise<void[]>`): read as that type when it settles, with no further step. */
	untypedAll(this: Translator, src: ts.Expression, result: string): string {
		const to = result.replace(/[?!]$/, '').slice(10, -1);
		const value = to === 'JSArray<Any?>' ? 'JSArray<Any?>(__v)' : this.fromAny('(JSArray<Any?>(__v) as Any?)', to);
		return `JSPromise<Any?>.all(${this.coerce(src, 'JSArray<Any?>')}, as: { (__v: [Any?]) -> ${to} in ${value} })`;
	},

	/** `Promise.all([a, b])` and friends over a literal list, which TypeScript types as a tuple. */
	promiseCombinator(this: Translator, method: string, list: ts.ArrayLiteralExpression, result: string): string {
		if (list.elements.some(ts.isSpreadElement)) throw this.error(list, `Promise.${method} over a spread`);
		const values = list.elements.map((x) => this.typeOf(x).replace(/^JSPromise<(.*)>$/, '$1'));
		const promise = (x: ts.Expression, k: number) => (isKit(spelledType(this.typeOf(x)), 'JSPromise') ? this.expr(x) : `JSPromise<${values[k]}>.resolve(${this.expr(x)})`);
		const same = values.every((v) => v === values[0]);
		const tuple = result.replace(/^JSPromise<(.*)>$/, '$1');
		const toTuple = (element: string) => `.then { (__a: JSArray<${element}>) -> ${tuple} in (${values.map((_, k) => `__a[${k}]`).join(', ')}) }`;
		if (method === 'all') {
			if (values.length >= 2 && values.length <= 4) return `${RT.jsPromiseAll}(${list.elements.map(promise).join(', ')})`;
			if (values.length === 1) {
				const el = /^JSArray<(.*)>$/.exec(tuple)?.[1];
				if (!el) return `${promise(list.elements[0], 0)}`;
				if (values[0] === el && !isUntyped(spelledType(el))) return `JSPromise<${el}>.all(JSArray<JSPromise<${el}>>([${promise(list.elements[0], 0)}]))`;
				return result === 'JSPromise<JSArray<Any?>>' ? `JSPromise<Any?>.all(JSArray<Any?>([${this.expr(list.elements[0])}]))` : this.untypedAll(list, result);
			}
			if (same) return `JSPromise<${values[0]}>.all(JSArray<JSPromise<${values[0]}>>([${list.elements.map(promise).join(', ')}]))${toTuple(values[0])}`;
			throw this.error(list, 'Promise.all over more than four values of different types');
		}
		if (method === 'allSettled') return `JSPromise<Any?>.allSettled(JSArray<Any?>([${list.elements.map((x) => this.expr(x)).join(', ')}]))${toTuple('JSObject')}`;
		if (!same) return `JSPromise<Any?>.${method}(JSArray<Any?>([${list.elements.map((x) => this.expr(x)).join(', ')}]))`;
		return `JSPromise<${values[0]}>.${method}(JSArray<JSPromise<${values[0]}>>([${list.elements.map(promise).join(', ')}]))`;
	},
};
