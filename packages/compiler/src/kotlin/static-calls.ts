// Calls of statics as Kotlin: staticCall, the promise combinators and showModal.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { TYPED_ARRAYS } from '../semantics/globals.ts';
import { ident, isThisParameter, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { undefinedLiteral } from '../semantics/lang.ts';
import { assignsArrayIntoObject } from '../semantics/shapes.ts';
import { CONSOLE } from '../semantics/apis/console.ts';
import { staticFunction } from '../semantics/apis/statics.ts';
import { runtimeCall } from '../semantics/apis/api.ts';
import { isPromiseType } from '../semantics/spelled.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { programClassName } from '../semantics/top-names.ts';

export const staticCallsMethods = {
	staticCall(this: Translator, owner: string, member: string, e: ts.CallExpression): string {
		const s = staticFunction(owner, member);
		if (!s) throw this.error(e, `${owner}.${member}`, 'library-member');
		const method = s.name;
		const a = () => this.args(e);
		const arg = (k: number) => e.arguments[k];
		const T = () => this.typeOf(e);
		if (owner === 'ArrayBuffer' && method === 'from') return `JSArrayBuffer.from(${this.expr(arg(0))})`;
		if (owner === 'ArrayBuffer' && method === 'isView') return `JSArrayBuffer.isView(${arg(0) ? this.coerce(arg(0), 'Any?') : 'null'})`;
		if (TYPED_ARRAYS.includes(owner)) {
			const t = `JS${owner}`;
			const value = owner.startsWith('Big') ? 'JSBigInt' : 'Double';
			if (method === 'of') {
				if (!e.arguments.some(ts.isSpreadElement)) return `${t}.of(${e.arguments.map((x) => this.restArgument(e, x, value)).join(', ')})`;
				const list = `${this.packed(e.arguments, `JSArray<${value}>`, this.restSlot(e, value))}.storage`;
				return `${t}.of(*${value === 'Double' ? `${list}.toDoubleArray()` : `${list}.toTypedArray()`})`;
			}
			if (method === 'from' && e.arguments.length === 1) return `${t}.from(${this.coerce(arg(0), 'Any?')})`;
			if (method === 'from') return this.ignoringThisArg(e, arg(0), () => `${t}.from(JSArray(${this.iterable(arg(0))}.toList()).map(${this.fn(arg(1))}))`);
		}
		switch (owner) {
			case 'Math':
				return this.math(method, e);
			case 'console': {
				const fn = RT[CONSOLE[method].op];
				if (e.arguments.some(ts.isSpreadElement)) return `${fn}(*${this.packed(e.arguments, 'JSArray<Any?>', this.restSlot(e, 'Any?'))}.storage.toTypedArray())`;
				return `${fn}(${e.arguments.map((x) => this.restArgument(e, x, 'Any?')).join(', ')})`;
			}
			case 'JSON':
				if (method === 'parse') return `${RT.jsJSONParse}(${this.str(arg(0))}${arg(1) ? `, ${this.restArgument(e, arg(1), 'Any?')}` : ''})`;
				// Undefined, a function or a symbol stringifies to undefined.
				if (method === 'stringify') {
					const replacer = arg(1) && arg(1).kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(arg(1)) && arg(1).getText() === 'undefined') ? `, replacer = ${this.restArgument(e, arg(1), 'Any?')}` : '';
					return this.undefinedAs(`${RT.jsJSONStringifyChecked}(${this.restArgument(e, arg(0), 'Any?')}${arg(2) ? `, ${this.restArgument(e, arg(2), 'Any?')}` : ''}${replacer})`, T());
				}
				break;
			case 'Object': {
				// A literal there is built untyped (the parameter is `{}`): its keys read by name.
				const record = isKit(spelledType(this.typeOf(arg(0))), 'JSRecord') && !ts.isObjectLiteralExpression(ts.skipOuterExpressions(arg(0)));
				if (record && ['keys', 'values', 'entries'].includes(method)) return `${this.expr(arg(0))}.${method}`;
				if (method === 'keys') return `${RT.jsObjectKeys}(${this.expr(arg(0))})`;
				if (method === 'values' || method === 'entries') {
					// Untyped (`(<any>Object).entries(o)`): an array of untyped values, or of key and value pairs.
					const array = isUntyped(spelledType(T())) ? (method === 'values' ? 'JSArray<Any?>' : 'JSArray<Pair<String, Any?>>') : T();
					const el = array.replace(/^JSArray<(.*)>$/, '$1');
					const declared = method === 'values' ? el : el.replace(/^Pair<String, (.*)>$/, '$1');
					const value = this.states.optionalElementsOf(arg(0)) ? optionalType(declared) : declared;
					const read = this.fromAnyCode(`${RT.jsField}(__o, it)`, value);
					return `run { val __o: Any? = ${this.expr(arg(0))}; JSArray<${method === 'values' ? value : `Pair<String, ${value}>`}>(${RT.jsKeysOf}(__o).map { ${method === 'values' ? read : `Pair(it, ${read})`} }) }`;
				}
				if (method === 'seal' || method === 'preventExtensions') return `${RT.jsRestrict}(${this.expr(arg(0))}, ${method === 'seal'})`;
				// A declared function by its reference, which every read of it gives (its properties are keyed by it).
				const definedOn = (x: ts.Expression) => (ts.isIdentifier(x) && this.resolve(x)?.valueDeclaration && ts.isFunctionDeclaration(this.resolve(x)!.valueDeclaration!) ? this.functionValue(x) : this.coerce(x, 'Any?'));
				if (method === 'getOwnPropertyDescriptor') return `${RT.jsOwnPropertyDescriptor}(${definedOn(arg(0))}, ${this.propertyKey(arg(1))})`;
				if (method === 'groupBy') return `${RT.jsObjectGroupBy}<${this.elementTypeOf(arg(0))}, ${T().replace(/^JSRecord<(.*)>\??$/, '$1')}>(${this.iterable(arg(0))}, ${this.fn(arg(1), this.groupKeySlot(arg(0), arg(1), 'Any?'))})`;
				if (method === 'create' && e.arguments.length === 1) return `${RT.jsObjectCreate}(${this.restArgument(e, arg(0), 'Any?')})`;
				if (method === 'defineProperty' || method === 'defineProperties') this.refuseRunTimeDefine(e);
				if (method === 'defineProperty') {
					const d = arg(2);
					this.checkFieldDefinition(arg(0), arg(1), d);
					const code = `${RT.jsDefineProperty}(${definedOn(arg(0))}, ${this.propertyKey(arg(1))}, ${ts.isObjectLiteralExpression(d) ? this.dynamicObject(d) : this.coerce(d, 'Any?')})`;
					return isUntyped(spelledType(T())) || ts.isExpressionStatement(e.parent) ? code : this.fromAnyCode(code, T(), true);
				}
				if (method === 'assign') {
					// The target is an open JavaScript object: a literal there is untyped, so the sources' keys all land.
					const target = ts.isObjectLiteralExpression(arg(0)) ? this.dynamicObject(arg(0) as ts.ObjectLiteralExpression) : this.restArgument(e, arg(0), 'Any?');
					const sources = e.arguments.slice(1);
					const code = sources.some(ts.isSpreadElement) ? `${RT.jsObjectAssign}(${target}, *${this.packed(sources, 'JSArray<Any?>')}.storage.toTypedArray())` : `${RT.jsObjectAssign}(${[target, ...sources.map((x) => this.coerce(x, 'Any?'))].join(', ')})`;
					if (assignsArrayIntoObject(e, this.checker) && !ts.isExpressionStatement(e.parent)) {
						if (isUntyped(spelledType(T())) || (this.checker.getContextualType(e)?.flags ?? 0) & ts.TypeFlags.Any) return code;
						throw this.error(e, 'Object.assign of an array into an object, typed as the array, read as anything but an untyped value');
					}
					return isUntyped(spelledType(T())) || ts.isExpressionStatement(e.parent) ? code : this.fromAnyCode(code, T(), true);
				}
				if (method === 'defineProperties') {
					const d = arg(1);
					if (!ts.isObjectLiteralExpression(d)) this.checkFieldDefinition(arg(0), undefined, d);
					else for (const p of d.properties) this.checkFieldDefinition(arg(0), ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) ? p.name : undefined, ts.isPropertyAssignment(p) ? p.initializer : p);
					const code = `${RT.jsDefineProperties}(${definedOn(arg(0))}, ${ts.isObjectLiteralExpression(d) ? this.dynamicObject(d) : this.coerce(d, 'Any?')})`;
					return isUntyped(spelledType(T())) || ts.isExpressionStatement(e.parent) ? code : this.fromAnyCode(code, T(), true);
				}
				break;
			}
			case 'Array':
				if (method === 'create') {
					const native = this.native?.call(e);
					if (native) return native;
				}
				if (method === 'isArray') return `JSArray.isArray(${this.restArgument(e, arg(0), 'Any?')})`;
				if (method === 'from' && e.arguments.length === 1) return `JSArray(${this.iterable(arg(0))}.toList())`;
				if (method === 'from' && (e.arguments.length === 2 || e.arguments.length === 3) && ts.isObjectLiteralExpression(arg(0))) {
					const length = (arg(0) as ts.ObjectLiteralExpression).properties.find((p) => p.name?.getText() === 'length');
					const fn = arg(1);
					if (!length || !ts.isPropertyAssignment(length) || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) throw this.error(e, 'Array.from of this object');
					const el = T().replace(/^JSArray<(.*)>$/, '$1');
					const params = fn.parameters.filter((p) => !isThisParameter(p));
					const index = params[1] ? ident((params[1].name as ts.Identifier).text) : '__i';
					const value = params[0] && ts.isIdentifier(params[0].name) && params[0].name.text !== '_' ? `val ${ident(params[0].name.text)}: Any? = null; ` : '';
					return this.ignoringThisArg(e, arg(0), () => {
						const body = ts.isBlock(fn.body) ? this.functionBody(fn, el, this.indent) : `{ return ${this.coerce(fn.body, el)} }`;
						return `JSArray.fromLength<${el}>(${this.toNumber(length.initializer)}, fun(${index}: Double): ${el} { ${value}${body.slice(1, -1)} })`;
					});
				}
				if (method === 'from' && (e.arguments.length === 2 || e.arguments.length === 3)) return this.ignoringThisArg(e, arg(0), () => `JSArray(${this.iterable(arg(0))}.toList()).map(${this.fn(arg(1))})`);
				if (method === 'of') return `${RT.jsArrayOf}<${T().replace(/^JSArray<(.*)>$/, '$1')}>(${a().join(', ')})`;
				// `Array.apply(thisArg, list)`: `Array(...list)`, a length when the list is one number.
				if (method === 'apply' && e.arguments.length === 2) {
					const made = `${RT.jsArrayConstruct}(${this.restArgument(e, arg(1), 'JSArray<Any?>')}.storage)`;
					return T() === 'JSArray<Any?>' ? made : this.fromAny(made, T());
				}
				break;
			case 'Number':
				// Anything but a number is none of these: they do not convert their argument.
				if (['isInteger', 'isSafeInteger', 'isFinite', 'isNaN'].includes(method) && this.typeOf(arg(0)) !== 'Double') {
					const test = method === 'isInteger' ? `${RT.jsIsInteger}(it)` : method === 'isSafeInteger' ? `${RT.jsIsSafeInteger}(it)` : method === 'isFinite' ? `${RT.jsIsFinite}(it)` : 'it.isNaN()';
					return `((${this.coerce(arg(0), 'Any?')} as? Double)?.let { ${test} } ?: false)`;
				}
				if (method === 'isInteger') return `${RT.jsIsInteger}(${this.toNumber(arg(0))})`;
				if (method === 'isSafeInteger') return `${RT.jsIsSafeInteger}(${this.toNumber(arg(0))})`;
				if (method === 'isFinite') return `${RT.jsIsFinite}(${this.toNumber(arg(0))})`;
				if (method === 'isNaN') return this.nanTest(arg(0));
				if (method === 'parseInt') return `${RT.jsParseInt}(${this.expr(arg(0))}${arg(1) ? `, ${this.toNumber(arg(1))}` : ''})`;
				break;
			case 'String':
				if (method === 'fromCharCode' && e.arguments.some(ts.isSpreadElement)) return `${RT.jsFromCharCodeList}(${this.packed(e.arguments, 'JSArray<Double>')})`;
				if (method === 'fromCharCode') return `${RT.jsFromCharCode}(${a().join(', ')})`;
				break;
			case 'BigInt':
				if (method === 'asIntN' || method === 'asUintN') return `JSBigInt.${method}(${this.toNumber(arg(0))}, ${this.expr(arg(1))})`;
				break;
			case 'Symbol':
				if (method === 'for') return `JSSymbol.\`for\`(${this.str(arg(0))})`;
				if (method === 'keyFor') return `JSSymbol.keyFor(${this.expr(arg(0))})`;
				break;
			case 'Date':
				if (method === 'now') return 'JSDate.now()';
				if (method === 'parse') return `JSDate.parse(${this.str(arg(0))})`;
				if (method === 'UTC') return `JSDate.UTC(${e.arguments.map((x) => this.toNumber(x)).join(', ')})`;
				break;
			case 'Map':
				if (method === 'groupBy') return `${RT.jsMapGroupBy}(${this.iterable(arg(0))}, ${this.fn(arg(1), this.groupKeySlot(arg(0), arg(1), T().replace(/^JSMap<(.*), JSArray<.*>>\??$/, '$1')))})`;
				break;
			case 'Promise': {
				const t = T();
				if (method === 'withResolvers') return `${t}()`;
				const v = t.replace(/^JSPromise<(.*)>$/, '$1');
				if (method === 'resolve' && v === 'Unit' && arg(0) && undefinedLiteral(arg(0))) return 'JSPromise.resolve<Unit>(Unit)';
				if (method === 'resolve') return arg(0) ? (isPromiseType(this.nativeOf(arg(0))) ? this.expr(arg(0)) : `JSPromise.resolve<${v}>(${this.restArgument(e, arg(0), v)})`) : `JSPromise.resolve<Unit>(Unit)`;
				if (method === 'reject') return `JSPromise.reject<${v}>(${arg(0) ? this.restArgument(e, arg(0), 'Any?') : 'null'})`;
				if (['all', 'allSettled', 'race', 'any'].includes(method)) {
					const src = arg(0);
					if (ts.isArrayLiteralExpression(src)) return this.promiseCombinator(method, src, t);
					const inner = this.typeOf(src).replace(/^JSArray<JSPromise<(.*)>>$/, '$1');
					if (inner === this.typeOf(src)) return `JSPromise.${method}Any(${this.expr(src)})`;
					return `JSPromise.${method}<${inner}>(${this.expr(src)})`;
				}
				break;
			}
		}
		// After the owner's cases: a type they read first makes the shape it names, which the output keeps.
		if (s.args) return runtimeCall(this, s, e);
		throw this.error(e, `${owner}.${method}`, 'library-member');
	},

	promiseCombinator(this: Translator, method: string, list: ts.ArrayLiteralExpression, result: string): string {
		if (list.elements.some(ts.isSpreadElement)) throw this.error(list, `Promise.${method} over a spread`);
		const values = list.elements.map((x) => this.typeOf(x).replace(/^JSPromise<(.*)>$/, '$1'));
		const promise = (x: ts.Expression, k: number) => (isPromiseType(this.nativeOf(x)) ? this.expr(x) : `JSPromise.resolve<${values[k]}>(${this.coerce(x, values[k])})`);
		const same = values.every((v) => v === values[0]);
		const n = values.length;
		if (method === 'all') {
			if (n === 2 || n === 3) return `${RT.jsPromiseAll}(${list.elements.map(promise).join(', ')})`;
			// One value of another type than the array's element TypeScript gives (an untyped thenable's): the dynamic combinator.
			if (n === 1 && !isUntyped(spelledType(values[0])) && /^JSPromise<JSArray<Any\?>\??>\??$/.test(result)) return `JSPromise.allAny(listOf<Any?>(${this.expr(list.elements[0])}))`;
			if (n === 1) return `JSPromise.all<${values[0]}>(listOf(${promise(list.elements[0], 0)}))`;
			if (same) return `JSPromise.all<${values[0]}>(listOf(${list.elements.map(promise).join(', ')}))`;
			return `JSPromise.allAny(listOf<Any?>(${list.elements.map((x) => this.expr(x)).join(', ')}))`;
		}
		if (method === 'allSettled') {
			if (n === 2 || n === 3) return `${RT.jsPromiseAllSettled}(${list.elements.map((x) => this.expr(x)).join(', ')})`;
			return `JSPromise.allSettledAny(listOf<Any?>(${list.elements.map((x) => this.expr(x)).join(', ')}))`;
		}
		if (!same) return `JSPromise.${method}Any(listOf<Any?>(${list.elements.map((x) => this.expr(x)).join(', ')}))`;
		return `JSPromise.${method}<${values[0]}>(listOf(${list.elements.map(promise).join(', ')}))`;
	},

	showModal(this: Translator, e: ts.CallExpression, then?: ts.Expression): string {
		const component = (e.arguments[0] as ts.Identifier).text;
		const info = this.components.get(component);
		if (!info) throw this.error(e, `a modal of ${component}: not a component`);
		const options = e.arguments[1];
		const given = new Map<string, string>();
		const settings: string[] = [];
		let callback = then;
		if (options && ts.isObjectLiteralExpression(options)) {
			for (const p of options.properties) {
				if (!ts.isPropertyAssignment(p)) continue;
				const key = (p.name as ts.Identifier).text;
				if (key === 'props' && ts.isObjectLiteralExpression(p.initializer)) {
					for (const q of p.initializer.properties) {
						if (ts.isShorthandPropertyAssignment(q)) given.set(q.name.text, this.shorthandValue(q.name));
						else if (ts.isPropertyAssignment(q)) given.set((q.name as ts.Identifier).text, this.expr(q.initializer));
					}
				} else if (key === 'fullscreen' || key === 'animated' || key === 'cancelable') {
					settings.push(`${key} = ${this.expr(p.initializer)}`);
				} else if (key === 'closeCallback') {
					callback = p.initializer;
				}
			}
		}
		if (callback) {
			if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) throw this.error(callback, 'a modal close callback that is not a function literal');
			const closure = this.closure(callback);
			const first = callback.parameters[0];
			const t = first ? this.typeOf(first.name) : '';
			const undefinedValue: Record<string, string> = { String: '"undefined"', Double: 'Double.NaN', Boolean: 'false' };
			const read = t in undefinedValue ? (heldLoss('modalResult', undefinedValue[t], { node: first }), `((value as? ${t}) ?: ${undefinedValue[t]})`) : `(value as ${t})`;
			const call = !first ? `{ _ -> (${closure})() }` : isUntyped(spelledType(t)) ? closure : t.endsWith('?') ? `{ value -> (${closure})(value as? ${t.slice(0, -1)}) }` : `{ value -> (${closure})(${read}) }`;
			settings.push(`closeCallback = ${call}`);
		}
		const args = info.props.map((p) => `${ident(p)} = ${given.get(p) ?? 'null'}`).join(', ');
		return `Modal.show(${settings.join(', ')}) { ${programClassName(this, component)}(${args}).${info.members.render}() }`;
	},
};
