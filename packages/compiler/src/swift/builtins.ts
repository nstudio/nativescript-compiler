// JavaScript's built-in library calls (Array, String, RegExp, Number, Promise, Map and Set, Math) as Swift.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { MATH, MATH_OF_SPREAD, isTypedArrayType } from './library.ts';
import { mathFunction } from '../semantics/apis/math.ts';
import type { Translator } from './translator.ts';
import { arrayMember, typedFlatPlan } from '../semantics/apis/array.ts';
import { collectionMember } from '../semantics/apis/mapset.ts';
import { argumentRunsConversion, numberMember } from '../semantics/apis/number.ts';
import { promiseMember } from '../semantics/apis/promise.ts';
import { regexpStringMember } from '../semantics/apis/regexp.ts';
import { stringMember } from '../semantics/apis/string.ts';
import { functionParts, heldType, ident, isNullish, isOptional, nullishType, optionalType, splitTopLevel, undefinedAbsent, RT } from './syntax.ts';
import { assertedPattern, boxedReplacement, nullishAssignTarget, spreadsArrays } from '../semantics/lang.ts';
import { literalPattern, patternGroups } from '../semantics/regexp.ts';
import { ELEMENT_CALLBACKS } from '../semantics/forms/flow.ts';
import { digitsLiteral } from '../semantics/throws.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { returnsPromise } from '../semantics/spelled.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { literalCallback } from '../semantics/conversion.ts';

export const builtinMethods = {
	math(this: Translator, name: string, e: ts.CallExpression): string {
		const m = mathFunction(name);
		if (!m) throw this.error(e, `Math.${name}`);
		const ofSpread = MATH_OF_SPREAD[m.op];
		if (ofSpread && e.arguments.some(ts.isSpreadElement)) return `${ofSpread}(values: ${this.packed(e.arguments, 'JSArray<Double>')}.storage)`;
		const a = e.arguments.map((x) => this.coerce(x, 'Double'));
		if (!m.arity && !m.rest) return MATH[m.op];
		return `${MATH[m.op]}(${(m.rest ? a : Array.from({ length: m.arity }, (_, k) => a[k] ?? '.nan')).join(', ')})`;
	},

	/** A function argument for an array method: a closure literal with its declared parameters, or a function value. */
	fn(this: Translator, e: ts.Expression): string {
		return ts.isArrowFunction(e) || ts.isFunctionExpression(e) ? this.closure(e) : this.expr(e);
	},

	/**
	 * A function value (not a literal) given the optional elements of a container `optionalElements` holds, its own type
	 * taking them present: its Swift parameters, which the call adapts (`optionalElementCallback`); null when it takes them
	 * as they are. `slot` lists the callback's parameters as the method passes them.
	 */
	optionalElementParams(this: Translator, f: ts.Expression | undefined, target: ts.Expression, el: string, slot: string[]): string[] | null {
		if (!f || this.library || ts.isArrowFunction(f) || ts.isFunctionExpression(f) || !isOptional(el) || !this.states.optionalElements(target)) return null;
		if (ts.isIdentifier(f) && this.builtinConstructorValue(f, this.resolve(f)?.declarations?.[0])) return null;
		const parts = functionParts(this.functionValueOf(f).replace(/^\((.*)\)[?!]$/, '$1'));
		if (!parts || parts.rest >= 0 || !parts.params.length) return null;
		const params = parts.params.slice(0, slot.length).map((p) => p.replace(/^@escaping /, ''));
		return params.every((p, k) => p === slot[k]) ? null : params;
	},

	/** The callback slot of an array's, Set's or Map's method call `optionalElementParams` adapts, as `optionalElementCallback` takes it. */
	optionalElementSlot(this: Translator, e: ts.CallExpression): { target: ts.Expression; el: string; slot: string[]; at: number[] } | null {
		if (this.library || !ts.isPropertyAccessExpression(e.expression)) return null;
		const name = e.expression.name.text,
			target = e.expression.expression;
		if (!ELEMENT_CALLBACKS.has(name) && !name.startsWith('reduce')) return null;
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(target));
		const kind = this.checker.isArrayType(t) ? 'Array' : t.getSymbol()?.name;
		const type = this.typeOf(target).replace(/[?!]$/, '');
		if (kind === 'Array' && (ELEMENT_CALLBACKS.has(name) || ((name === 'reduce' || name === 'reduceRight') && e.arguments.length > 1))) {
			const el = /^JSArray<(.*)>$/.exec(type)?.[1];
			if (!el) return null;
			const items = [el, 'Double', `JSArray<${el}>`];
			return name.startsWith('reduce') ? { target, el, slot: [this.typeOf(e), ...items], at: [1] } : { target, el, slot: items, at: [0] };
		}
		if ((kind === 'Set' || kind === 'Map') && name === 'forEach') {
			const [k, v] = /^JSMap<(.*)>$/.test(type) ? splitTopLevel(type.slice(6, -1)) : [/^JSSet<(.*)>$/.exec(type)?.[1] ?? 'Any?', ''];
			return { target, el: v || k, slot: v ? [v, k] : [k, k], at: v ? [0] : [0, 1] };
		}
		return null;
	},

	/** A call whose callback `optionalElementCallback` adapts: the closure throws as it unwraps an object element, so the call does. */
	adaptsElementCallback(this: Translator, n: ts.Node): boolean {
		if (!ts.isCallExpression(n) || !n.arguments.length) return false;
		const s = this.optionalElementSlot(n);
		if (!s) return false;
		const f = ts.skipOuterExpressions(n.arguments[0], ts.OuterExpressionKinds.Parentheses);
		return ts.isConditionalExpression(f) ? isOptional(s.el) && this.states.optionalElements(s.target) : !!this.optionalElementParams(f, s.target, s.el, s.slot);
	},

	/** A call on an untyped array whose literal callback takes a non-optional typed parameter converted via `presentFromAny`, which throws. */
	adaptsLiteralCallback(this: Translator, n: ts.Node): boolean {
		if (!ts.isCallExpression(n) || !n.arguments.length || !ts.isPropertyAccessExpression(n.expression)) return false;
		const name = n.expression.name.text;
		if (!ELEMENT_CALLBACKS.has(name) && name !== 'sort' && name !== 'toSorted') return false;
		const cb = n.arguments[0];
		if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) return false;
		const target = n.expression.expression;
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(target));
		if (!this.checker.isArrayType(t)) return false;
		const el = /^JSArray<(.*)>$/.exec(this.typeOf(target).replace(/[?!]$/, ''))?.[1];
		if (!el || !isUntyped(spelledType(el))) return false;
		const slot = name === 'sort' || name === 'toSorted' ? [el, el] : [el, 'Double', `JSArray<${el}>`];
		if (cb.parameters.length > slot.length || cb.parameters.some((p) => p.dotDotDotToken || !ts.isIdentifier(p.name))) return false;
		const held = functionParts(this.closureType(cb));
		if (!held || held.rest >= 0) return false;
		return held.params.some((raw, k) => {
			const to = raw.replace(/^@escaping /, '');
			return to !== slot[k] && isUntyped(spelledType(slot[k])) && isUntyped(spelledType(heldType(to))) && !isOptional(to);
		});
	},

	/**
	 * `optionalElementParams`' function value as a closure of the slot's parameters calling it, each element (at `at`) as
	 * its parameter reads undefined: NaN, "undefined" or false, an object's TypeError.
	 */
	optionalElementCallback(this: Translator, f: ts.Expression, target: ts.Expression, el: string, slot: string[], at: number[], arity = 0): string | null {
		const own = this.optionalElementParams(f, target, el, slot);
		const parts = functionParts(this.functionValueOf(f).replace(/^\((.*)\)[?!]$/, '$1'));
		const params = own ?? (arity && parts && parts.rest < 0 ? parts.params.slice(0, slot.length).map((p) => p.replace(/^@escaping /, '')) : null);
		if (!params) return null;
		const present = el.replace(/\?$/, '');
		const element = (code: string, to: string): string => {
			if (isOptional(to) || isUntyped(spelledType(to))) return this.convert(code, el, to);
			if (['Double', 'String', 'Bool'].includes(to)) return this.undefinedAs(code, to, el);
			return to === present ? `try ${RT.jsObjectRequired}(${code})` : this.convert(`try ${RT.jsObjectRequired}(${code})`, present, to);
		};
		const names = slot.map((_, k) => `__p${k}`);
		const args = params.map((p, k) => {
			if (p === slot[k]) return names[k];
			if (at.includes(k)) return element(names[k], p);
			const array = /^JSArray<(.*)>[?!]?$/.exec(p)?.[1];
			if (array && slot[k] === `JSArray<${el}>`) return `try ${names[k]}.map({ (__x: ${el}) throws -> ${array} in ${element('__x', array)} })`;
			return this.convert(names[k], slot[k], p);
		});
		const ret = parts!.result;
		const taken = Math.max(params.length, Math.min(arity, slot.length));
		return `{ (${slot
			.slice(0, taken)
			.map((t, k) => `${k < params.length ? '' : '_ '}${names[k]}: ${t}`)
			.join(', ')}) throws -> ${ret} in ${ret === 'Void' ? '' : 'return '}try (${this.fn(f)})(${args.join(', ')}) }`;
	},

	/**
	 * A function literal given where the callback's parameters (`slot`, named `names`) are untyped and it declares types
	 * for them (`literalCallback`): a closure of the slot's parameters calling it, each argument read as its parameter
	 * is declared, its result as `result` (the literal's own when not given). Null where the literal is the callback as it is.
	 */
	literalCallbackAdapter(this: Translator, callback: ts.ArrowFunction | ts.FunctionExpression, slot: string[], names: string[], result?: string, opts?: { minArity?: number; wrapResult?: (call: string) => string }): string | null {
		if (callback.parameters.length > slot.length || callback.parameters.some((p) => p.dotDotDotToken || !ts.isIdentifier(p.name))) return null;
		const held = functionParts(this.closureType(callback));
		if (!held || held.rest >= 0) return null;
		const own = held.params.map((p) => p.replace(/^@escaping /, ''));
		const adaptParams =
			literalCallback(
				slot.map((p) => spelledType(p)),
				own.map((p) => spelledType(p)),
			) !== 'as-is';
		const minArity = opts?.minArity ?? 0;
		if (!adaptParams && own.length >= minArity && !opts?.wrapResult) return null;
		const read = (name: string, from: string, to: string) => (to === from ? name : isUntyped(spelledType(from)) && isUntyped(spelledType(heldType(to))) && !isOptional(to) ? this.presentFromAny(name, to) : this.convert(name, from, to));
		const args = own.map((p, k) => read(names[k], slot[k], p));
		const fnThrows = this.throwsInfo.fn(callback);
		const argsThrow = args.some((a) => /\btry\b/.test(a));
		const throwing = fnThrows || argsThrow;
		const want = result ?? held.result;
		const arity = Math.max(own.length, minArity);
		const paramList = Array.from({ length: arity }, (_, k) => `${names[k]}: ${slot[k]}`).join(', ');
		const call = this.marks.tryIf(fnThrows, `(${this.fn(callback)})(${args.join(', ')})`);
		const body = opts?.wrapResult ? opts.wrapResult(call) : this.convert(call, held.result, want);
		return `{ (${paramList}) ${throwing ? 'throws ' : ''}-> ${want} in ${held.result === 'Void' && !opts?.wrapResult ? '' : 'return '}${body} }`;
	},

	/**
	 * A choice of callbacks (`flag ? show : (v) => …`) given the optional elements of a container `optionalElements`
	 * holds: chosen once, each branch a closure of the slot's parameters, a literal taking the elements as they are and a
	 * function value through `optionalElementCallback`. Null for any other callback.
	 */
	optionalElementChoice(this: Translator, f: ts.Expression, target: ts.Expression, el: string, slot: string[], at: number[], ret: string): string | null {
		const choice = ts.skipOuterExpressions(f, ts.OuterExpressionKinds.Parentheses);
		if (this.library || !ts.isConditionalExpression(choice) || !isOptional(el) || !this.states.optionalElements(target)) return null;
		const leaves = (x: ts.Expression): ts.Expression[] => {
			const b = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
			return ts.isConditionalExpression(b) ? [...leaves(b.whenTrue), ...leaves(b.whenFalse)] : [b];
		};
		const arityOf = (x: ts.Expression) => (ts.isArrowFunction(x) || ts.isFunctionExpression(x) ? x.parameters.length : (functionParts(this.functionValueOf(x).replace(/^\((.*)\)[?!]$/, '$1'))?.params.length ?? 1));
		const arity = Math.min(slot.length, Math.max(1, ...leaves(choice).map(arityOf)));
		const type = `(${slot.slice(0, arity).join(', ')}) throws -> ${ret}`;
		const branch = (x: ts.Expression): string => {
			const b = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
			if (ts.isConditionalExpression(b)) return this.ternary(b, type, branch);
			if (ts.isArrowFunction(b) || ts.isFunctionExpression(b)) {
				if (b.parameters.length < arity) this.closureSlots.set(b, slot.slice(0, arity));
				return this.closure(b);
			}
			return this.optionalElementCallback(b, target, el, slot, at, arity) ?? this.fn(b);
		};
		return this.ternary(choice, type, branch);
	},

	arrayMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression, q: string, receiver?: string): string {
		const recv = { code: '' };
		return this.marks.leading(this.arrayMethodOf(name, target, e, q, receiver, recv), recv.code);
	},

	/** `recv`: given the receiver's own code, which the method's code may begin with. */
	arrayMethodOf(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression, q: string, receiver: string | undefined, recv: { code: string }): string {
		this.refuseTypedUnsetCallback(e);
		const held = this.typeOf(target);
		// Lenient code holds arrays implicitly unwrapped, where `map` and `flatMap` would be Optional's.
		const x = (recv.code = receiver ?? this.expr(target));
		const t = receiver ?? (!q && this.lenient && ['map', 'flatMap'].includes(name) && /^JSArray<.*>$/.test(held) ? `(${x} as ${held})` : `${x}${q}`);
		const a = () => this.args(e);
		const el = isNamed(spelledType(held), 'JSMatch') ? this.matchElement(target, name) : held.replace(/\?$/, '').replace(/^JSArray<(.*)>$/, '$1');
		switch (arrayMember(name)?.op) {
			case 'push':
			case 'unshift':
				if (e.arguments.some(ts.isSpreadElement)) return `${t}.${name}(contentsOf: ${this.packed(e.arguments, `JSArray<${el}>`, this.elementSlot(e, el))})`;
				return `${t}.${name}(${e.arguments.map((x) => this.elementArgument(e, x, el)).join(', ')})`;
			// An untyped array's element taken out is one undefined, not an optional of one.
			case 'pop':
			case 'shift':
				return isUntyped(spelledType(el)) && !q ? this.marks.orNil(`${t}.${name}()`) : !isUntyped(spelledType(el)) && this.states.elementNilIsUndefined(target) ? `(${t}.${name}() ?? nil)` : `${t}.${name}()`;
			case 'reverse':
			case 'toString':
			case 'keys':
			case 'entries':
			case 'values':
				return `${t}.${name}()`;
			case 'flat': {
				const plan = typedFlatPlan(e, el, isUntyped(spelledType(el)));
				if (plan.kind === 'default') return `${t}.flat()`;
				if (plan.kind === 'chain') return t + plan.suffix;
				if (plan.untyped) return `${t}.flat(${this.coerce(plan.arg, 'Double')})`;
				if (q) throw this.error(e, 'flat with a depth on an optional array');
				return this.convert(`JSArray<Any?>(${t}.jsAnyElements).flat(${this.coerce(plan.arg, 'Double')})`, 'JSArray<Any?>', this.typeOf(e));
			}
			case 'toLocaleString':
				if (!e.arguments.length) return `${t}.toLocaleString()`;
				break;
			case 'splice':
				if (e.arguments.slice(2).some(ts.isSpreadElement))
					return `${t}.splice(${e.arguments
						.slice(0, 2)
						.map((x) => this.restArgument(e, x, 'Double'))
						.join(', ')}, contentsOf: ${this.packed(e.arguments.slice(2), `JSArray<${el}>`, this.elementSlot(e, el))}.storage)`;
				return `${t}.splice(${[...a().slice(0, 2), ...e.arguments.slice(2).map((x) => this.elementArgument(e, x, el))].join(', ')})`;
			case 'fill':
				return `${t}.fill(${[this.elementArgument(e, e.arguments[0], el), ...a().slice(1)].join(', ')})`;
			// An array holding functions as function objects (`heldType`) is searched for the one the function is.
			case 'indexOf':
			case 'lastIndexOf':
			case 'includes':
				if ((isOptional(el) || isKit(spelledType(el), 'JSNullish')) && e.arguments[0] && !ts.isSpreadElement(e.arguments[0])) return `${t}.${name}(${[this.restArgument(e, e.arguments[0], el), ...a().slice(1)].join(', ')})`;
			// falls through
			case 'slice':
			case 'at':
				return name === 'at' && !isUntyped(spelledType(el)) && this.states.elementNilIsUndefined(target) ? `(${t}.at(${a().join(', ')}) ?? nil)` : `${t}.${name}(${a().join(', ')})`;
			case 'join':
				return `${t}.join(${e.arguments[0] ? this.joinSeparator(e.arguments[0]) : ''})`;
			case 'concat':
				// Arrays spread as arguments are concatenated; the runtime tells them apart from elements only in an array of anything.
				if (!isUntyped(spelledType(el)) && e.arguments.some((x) => ts.isSpreadElement(x) && spreadsArrays(x.expression, this.checker))) {
					const parts = e.arguments.map((x) => {
						if (!ts.isSpreadElement(x)) return this.isArray(x) ? `${this.coerce(x, `JSArray<${el}>`)}.storage` : `[${this.coerce(x, el)}]`;
						if (!spreadsArrays(x.expression, this.checker)) return `Array(${this.iterable(x.expression)})`;
						if (ts.isArrayLiteralExpression(x.expression) && !x.expression.elements.some(ts.isSpreadElement)) return x.expression.elements.map((y) => `${this.coerce(y, `JSArray<${el}>`)}.storage`).join(' + ');
						if (this.typeOf(x.expression).replace(/[?!]$/, '') === `JSArray<JSArray<${el}>>`) return `Array(${this.iterable(x.expression)}).flatMap { $0.storage }`;
						throw this.error(x, 'a spread of arrays of another element type into concat');
					});
					return `${t}.concat(spread: ${parts.join(' + ')})`;
				}
				if (e.arguments.some(ts.isSpreadElement)) return `${t}.concat(spread: ${this.packed(e.arguments, `JSArray<${el}>`, this.restSlot(e, el))}.storage)`;
				return `${t}.concat(${e.arguments.map((x) => (!this.isArray(x) ? `[${this.restArgument(e, x, el)}]` : this.typeOf(x).replace(/[?!]$/, '') === `JSArray<${el}>` ? this.expr(x) : this.restArgument(e, x, `JSArray<${el}>`))).join(', ')})`;
			case 'map':
			case 'filter':
			case 'find':
			case 'findIndex':
			case 'findLast':
			case 'findLastIndex':
			case 'some':
			case 'every':
			case 'forEach':
			case 'flatMap': {
				const callback = e.arguments[0];
				const call = () => {
					if (ts.isIdentifier(callback) && callback.text === 'Boolean' && isLibGlobal(this, callback)) return `${t}.${name}({ (__e: ${el}) -> Bool in ${RT.jsTruthy}(__e) })`;
					if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback) && this.isAny(callback)) {
						const callCode = this.marks.tryCode(`${RT.jsCall}(${this.expr(callback)}, __e, __i, __a)`);
						if (['filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every'].includes(name)) return `${t}.${name}({ (__e: ${el}, __i: Double, __a: JSArray<${el}>) throws -> Bool in ${RT.jsTruthy}(${callCode}) })`;
						if (name === 'forEach') return `${t}.${name}({ (__e: ${el}, __i: Double, __a: JSArray<${el}>) throws -> Void in _ = ${callCode} })`;
						if (name === 'map') {
							const out = this.typeOf(e).replace(/^JSArray<(.*)>[?!]?$/, '$1');
							return `${t}.${name}({ (__e: ${el}, __i: Double, __a: JSArray<${el}>) throws -> ${out} in ${isUntyped(spelledType(out)) ? callCode : this.fromAnyCode(callCode, out, true)} })`;
						}
					}
					const result = this.checker.getTypeAtLocation(callback).getCallSignatures()[0]?.getReturnType();
					// A predicate returning any value (`labels.find((l) => GROUPS[l])`) decides by its truthiness.
					if (['filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every'].includes(name) && result && !(result.flags & ts.TypeFlags.BooleanLike)) {
						if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && isUntyped(spelledType(el))) {
							const adapted = this.literalCallbackAdapter(callback, [el, 'Double', `JSArray<${el}>`], ['__e', '__i', '__a'], 'Bool', { minArity: 1, wrapResult: (c) => `${RT.jsTruthy}(${c})` });
							if (adapted) return `${t}.${name}(${adapted})`;
						}
						const arity = ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) ? Math.min(3, callback.parameters.length) : 1;
						const params = ['__e', '__i', '__a'].slice(0, Math.max(1, arity));
						const types = [el, 'Double', `JSArray<${el}>`];
						const throwing = ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) ? this.throwsInfo.fn(callback) : this.valueThrows(callback);
						return `${t}.${name}({ (${params.map((p, k) => `${p}: ${types[k]}`).join(', ')}) ${throwing ? 'throws ' : ''}-> Bool in ${RT.jsTruthy}(${throwing ? 'try ' : ''}(${this.fn(callback)})(${params.join(', ')})) })`;
					}
					const out = name === 'forEach' ? 'Void' : name === 'map' ? /^JSArray<(.*)>$/.exec(this.typeOf(e))?.[1] : name === 'flatMap' ? undefined : 'Bool';
					const adapted = (out && this.optionalElementChoice(callback, target, el, [el, 'Double', `JSArray<${el}>`], [0], out)) || this.optionalElementCallback(callback, target, el, [el, 'Double', `JSArray<${el}>`], [0]);
					if (adapted) return `${t}.${name}(${adapted})`;
					// A function value taking elements of another Swift type (an untyped array's): each element converted.
					// A built-in conversion (`map(Number)`) is written as a closure of the element already.
					const isLiteral = ts.isArrowFunction(callback) || ts.isFunctionExpression(callback);
					const literal = isLiteral && isUntyped(spelledType(el)) ? this.literalCallbackAdapter(callback, [el, 'Double', `JSArray<${el}>`], ['__e', '__i', '__a']) : null;
					if (literal) return `${t}.${name}(${literal})`;
					const held = isLiteral ? null : !(ts.isIdentifier(callback) && this.builtinConstructorValue(callback, this.resolve(callback)?.declarations?.[0])) ? functionParts(this.functionValueOf(callback)) : null;
					const want = held && !isLiteral && name === 'map' ? this.typeOf(e).replace(/^JSArray<(.*)>$/, '$1') : held?.result;
					if (held?.params.length === 1 && (held.params[0] !== el || held.result !== want)) {
						// Throwing only as the function it calls does: a call given a throwing closure throws, and is tried.
						const throwing = isLiteral ? this.throwsInfo.fn(callback) : this.valueThrows(callback);
						return `${t}.${name}({ (__e: ${el}) ${throwing ? 'throws ' : ''}-> ${want} in ${held.result === 'Void' ? '' : 'return '}${this.convert(this.marks.tryIf(throwing, `(${this.fn(callback)})(${isUntyped(spelledType(el)) && isUntyped(spelledType(heldType(held.params[0].replace(/^@escaping /, '')))) && !isOptional(held.params[0]) ? this.presentFromAny('__e', held.params[0].replace(/^@escaping /, '')) : this.convert('__e', el, held.params[0])})`), held.result, want!)} })`;
					}
					return `${t}.${name}(${this.fn(callback)})`;
				};
				// A type-guard filter (`(s): s is UIWindowScene => …`): its elements as the guard narrows them.
				const narrowed = name === 'filter' ? /^JSArray<(\w+)>$/.exec(this.typeOf(e))?.[1] : undefined;
				// The guard passed each element, so each is of its class.
				if (narrowed && narrowed !== el && (/^\w+$/.test(el) || (!this.library && isUntyped(spelledType(el)) && ['Double', 'String', 'Bool'].includes(narrowed)))) return `JSArray<${narrowed}>(${this.ignoringThisArg(e, target, call)}.storage.compactMap { $0 as? ${narrowed} })`;
				if (name === 'find' && /^\w+$/.test(el)) {
					const found = this.typeOf(e).replace(/[?!]$/, '');
					if (/^\w+$/.test(found) && found !== el && found !== 'Any') return `(${this.ignoringThisArg(e, target, call)}.flatMap { $0 as? ${found} })`;
				}
				if ((name === 'find' || name === 'findLast') && isUntyped(spelledType(el)) && !q) return this.marks.orNil(this.ignoringThisArg(e, target, call));
				if ((name === 'find' || name === 'findLast') && !isUntyped(spelledType(el)) && this.states.elementNilIsUndefined(target)) return `(${this.ignoringThisArg(e, target, call)} ?? nil)`;
				return this.ignoringThisArg(e, target, call);
			}
			case 'sort':
			case 'toSorted': {
				const cmp = e.arguments[0];
				if (!cmp) return `${t}.${name}()`;
				if (!ts.isArrowFunction(cmp) && !ts.isFunctionExpression(cmp) && this.isAny(cmp)) {
					return `${t}.${name}({ (__a: ${el}, __b: ${el}) throws -> Double in ${RT.jsToNumber}(try ${RT.jsCall}(${this.expr(cmp)}, __a, __b)) })`;
				}
				const literal = (ts.isArrowFunction(cmp) || ts.isFunctionExpression(cmp)) && isUntyped(spelledType(el)) ? this.literalCallbackAdapter(cmp, [el, el], ['__a', '__b'], 'Double', { minArity: 2 }) : null;
				if (literal) return `${t}.${name}(${literal})`;
				// Swift's closure must take both arguments sort passes.
				if ((ts.isArrowFunction(cmp) || ts.isFunctionExpression(cmp)) && cmp.parameters.length < 2 && !cmp.parameters.some((p) => p.dotDotDotToken)) {
					const throws = this.throwsInfo.fn(cmp);
					return `${t}.${name}({ (__a: ${el}, __b: ${el}) ${throws ? 'throws ' : ''}-> Double in ${throws ? 'try ' : ''}(${this.fn(cmp)})(${['__a', '__b'].slice(0, cmp.parameters.length).join(', ')}) })`;
				}
				return `${t}.${name}(${this.fn(cmp)})`;
			}
			case 'toReversed':
				return `${t}.toReversed()`;
			case 'toSpliced':
				if (!e.arguments.length) return `${t}.toSpliced(0, 0)`;
				if (e.arguments.slice(2).some(ts.isSpreadElement))
					return `${t}.toSpliced(${e.arguments
						.slice(0, 2)
						.map((x) => this.restArgument(e, x, 'Double'))
						.join(', ')}, contentsOf: ${this.packed(e.arguments.slice(2), `JSArray<${el}>`, this.restSlot(e, el))}.storage)`;
				return `${t}.toSpliced(${[...a().slice(0, 2), ...e.arguments.slice(2).map((x) => this.restArgument(e, x, el))].join(', ')})`;
			case 'with':
				return `${t}.with(${this.restArgument(e, e.arguments[0], 'Double')}, ${this.restArgument(e, e.arguments[1], el)})`;
			case 'reduce':
			case 'reduceRight': {
				const init = e.arguments[1];
				const callback = e.arguments[0];
				let f = this.fn(callback);
				// A function value typed otherwise than the accumulator and elements: each converted.
				const held = !ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback) ? functionParts(this.functionValueOf(callback)) : null;
				const acc = init ? this.typeOf(e) : el;
				const slot = [acc, el, 'Double', `JSArray<${el}>`];
				const adapted = init ? this.optionalElementChoice(callback, target, el, slot, [1], acc) || this.optionalElementCallback(callback, target, el, slot, [1]) : null;
				const literal = (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && isUntyped(spelledType(el)) ? this.literalCallbackAdapter(callback, slot, ['__a', '__e', '__i', '__r'], acc) : null;
				if (adapted) f = adapted;
				else if (literal) f = literal;
				else if (held?.params.length === 2 && (held.params[0] !== acc || held.params[1] !== el || held.result !== acc)) {
					const throwing = this.valueThrows(callback);
					f = `{ (__a: ${acc}, __e: ${el}) ${throwing ? 'throws ' : ''}-> ${acc} in ${this.convert(this.marks.tryIf(throwing, `(${this.expr(callback)})(${this.convert('__a', acc, held.params[0])}, ${this.convert('__e', el, held.params[1])})`), held.result, acc)} }`;
				}
				return init ? `${t}.${name}(${f}, ${this.coerce(init, this.typeOf(e))})` : `${t}.${name}(${f})`;
			}
		}
		throw this.error(e, `Array.${name}`);
	},

	/** A built-in's call taking a callback and a thisArg, made as `thisArgUse` has it; `make` translates it without the thisArg. */
	ignoringThisArg(this: Translator, e: ts.CallExpression, target: ts.Expression | undefined, make: () => string): string {
		const use = this.thisArgUse(e, target);
		if (use.kind === 'plain') return make();
		if (use.kind === 'unbound') return this.withThis(use.bound, 'nil', true, make);
		// A closure of one expression, typed with the expression around it (an overloaded method's result is not inferred alone).
		const held = (name: string, type: string, code: string) => `({ (${name}: ${type}) in ${this.marks.tryBefore(this.tryPrefix(e), code)} }(${this.tryPrefix(use.thisArg)}${this.coerce(use.thisArg, type)}))`;
		if (use.kind === 'held') {
			const declared = use.self ? this.paramType(use.self).replace(/!$/, '') : 'Any?';
			const type = !isUntyped(spelledType(declared)) ? declared : 'Any?';
			const name = this.fresh('__thisArg');
			return held(name, type, this.withThis(use.bound, name, isUntyped(spelledType(type)), make));
		}
		if (target && isTypedArrayType(this.typeOf(target).replace(/[?!]$/, ''))) return held('_', 'Any?', make());
		return `({ ${this.tryPrefix(use.thisArg)}${this.exprStatement(use.thisArg)}; return ${this.marks.tryBefore(this.tryPrefix(e), make())} }())`;
	},

	/** A pattern an assertion from untyped gives (`assertedPattern`), as its untyped value. */
	assertedPatternValue(this: Translator, x: ts.Expression): string {
		x = ts.skipParentheses(x);
		if (ts.isConditionalExpression(x)) return this.ternary(x, 'Any?', (b) => this.assertedPatternValue(b));
		if ((ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)) && this.checker.getTypeAtLocation(x.expression).flags & ts.TypeFlags.Any) return this.expr(x.expression);
		return this.marks.castCode(this.coerce(x, 'Any?'), 'Any', 'as');
	},

	/** `s.replace(p, r)` as `boxedReplacement` has it: the pattern and the replacement untyped. */
	boxedReplace(this: Translator, name: string, s: string, e: ts.CallExpression): string {
		const [p, r] = e.arguments;
		const pattern = assertedPattern(p, this.checker) ? this.assertedPatternValue(p) : this.coerce(p, 'Any?');
		// A conditional's branches are each held untyped: adapted to one function type, a rest would not take the arguments.
		const bare = ts.skipOuterExpressions(r);
		const replacement = ts.isConditionalExpression(bare) ? `(${this.cond(bare.condition)} ? ${this.coerce(bare.whenTrue, 'Any?')} : ${this.coerce(bare.whenFalse, 'Any?')})` : this.coerce(r, 'Any?');
		return `${name === 'replace' ? RT.jsReplace : RT.jsReplaceAll}(${s}, untyped: ${pattern}, replacing: ${replacement})`;
	},

	stringMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression): string {
		const t = this.expr(target);
		return this.marks.leading(this.stringMethodOf(name, e, t), t);
	},

	stringMethodOf(this: Translator, name: string, e: ts.CallExpression, t: string): string {
		const first = e.arguments[0];
		if (boxedReplacement(name, e, this.checker)) return this.boxedReplace(name, t, e);
		const asserted = !!first && name !== 'matchAll' && assertedPattern(first, this.checker);
		if (first && this.typeOf(first) === 'JSRegExp' && !asserted) return this.regexpStringMethod(name, t, e);
		const untyped = !first ? undefined : asserted ? this.assertedPatternValue(first) : this.isAny(first) ? this.expr(first) : undefined;
		const a = this.args(e);
		const opt = (k: number) => (a[k] !== undefined ? a[k] : 'nil');
		switch (stringMember(name)?.op) {
			case 'toLowerCase':
			case 'toLocaleLowerCase':
				return `${t}.lowercased()`;
			case 'toUpperCase':
			case 'toLocaleUpperCase':
				return `${t}.uppercased()`;
			case 'includes':
				return `${RT.jsIncludes}(${t}, ${a[0]})`;
			case 'startsWith':
				return `${RT.jsStartsWith}(${t}, ${a[0]}, ${opt(1)})`;
			case 'endsWith':
				return `${RT.jsEndsWith}(${t}, ${a[0]}, ${opt(1)})`;
			case 'trim':
				return `${RT.jsTrim}(${t})`;
			case 'trimStart':
				return `${RT.jsTrimStart}(${t})`;
			case 'trimEnd':
				return `${RT.jsTrimEnd}(${t})`;
			case 'split': {
				if (untyped) return `${RT.jsSplit}(${t}, ${this.unsetGroups(e) ? 'untypedKeepingUnset' : 'untyped'}: ${untyped}, ${opt(1)})`;
				const call = `${RT.jsSplit}(${t}, ${a[0] ?? 'nil'}, ${opt(1)})`;
				return this.unsetGroups(e) ? this.convert(call, 'JSArray<String>', 'JSArray<String?>') : call;
			}
			case 'indexOf':
				return `${RT.jsIndexOf}(${t}, ${a[0]}, ${opt(1)})`;
			case 'lastIndexOf':
				return `${RT.jsLastIndexOf}(${t}, ${a[0]}${a[1] !== undefined ? `, ${a[1]}` : ''})`;
			case 'slice':
				return `${RT.jsSlice}(${t}, ${a.join(', ')})`;
			case 'substring':
				return `${RT.jsSubstring}(${t}, ${a[0] ?? '0'}, ${opt(1)})`;
			case 'substr':
				return `${RT.jsSubstr}(${t}, ${a[0] ?? '0'}, ${opt(1)})`;
			case 'match':
				return `${RT.jsMatch}(${t}, ${RT.jsRegExpFrom}(${untyped ?? (first ? this.coerce(first, 'Any?') : 'nil')}))`;
			case 'search':
				return `${RT.jsSearch}(${t}, ${RT.jsRegExpFrom}(${untyped ?? (first ? this.coerce(first, 'Any?') : 'nil')}))`;
			case 'replace':
				return untyped && e.arguments[1] && this.isString(e.arguments[1]) ? `${RT.jsReplace}(${t}, untyped: ${untyped}, ${a[1]})` : `${RT.jsReplace}(${t}, ${first && this.isString(first) ? this.str(first) : a[0]}, ${a[1]})`;
			case 'replaceAll':
				return untyped && e.arguments[1] && this.isString(e.arguments[1]) ? `${RT.jsReplaceAll}(${t}, untyped: ${untyped}, ${a[1]})` : `${RT.jsReplaceAll}(${t}, ${a[0]}, ${a[1]})`;
			case 'charAt':
				return `${RT.jsCharAt}(${t}, ${a[0] ?? '0'})`;
			case 'charCodeAt':
				return `${RT.jsCharCodeAt}(${t}, ${a[0] ?? '0'})`;
			case 'codePointAt':
				return `${RT.jsCodePointAt}(${t}, ${a[0] ?? '0'})`;
			case 'at':
				return `${RT.jsStringAt}(${t}, ${a[0]})`;
			case 'repeat':
				return `${RT.jsRepeat}(${t}, ${a[0]})`;
			case 'padStart':
				return `${RT.jsPadStart}(${t}, ${a[0]}, ${a[1] ?? '" "'})`;
			case 'padEnd':
				return `${RT.jsPadEnd}(${t}, ${a[0]}, ${a[1] ?? '" "'})`;
			case 'concat':
				return `(${[t, ...e.arguments.map((x) => this.str(x))].join(' + ')})`;
			case 'localeCompare':
				return e.arguments.length > 1 ? `${RT.jsLocaleCompare}(${[t, a[0], ...e.arguments.slice(1).map((x) => this.coerce(x, 'Any?'))].join(', ')})` : `${RT.jsLocaleCompare}(${t}, ${a[0]})`;
			case 'toString':
			case 'valueOf':
				return t;
		}
		throw this.error(e, `String.${name}`, 'library-member');
	},

	/** `s.replace(/x/g, …)`, `s.match(re)`, `s.split(re)`… */
	regexpStringMethod(this: Translator, name: string, s: string, e: ts.CallExpression): string {
		const [re, second] = e.arguments;
		const r = this.expr(re);
		switch (regexpStringMember(name)?.op) {
			case 'match':
				return `${RT.jsMatch}(${s}, ${r})`;
			case 'matchAll':
				return `${RT.jsMatchAll}(${s}, ${r})`;
			case 'search':
				return `${RT.jsSearch}(${s}, ${r})`;
			case 'split': {
				const call = `${RT.jsSplit}(${s}, ${r}${second ? `, ${this.expr(second)}` : ''})`;
				// A group that took no part splices in undefined, which only an untyped destination can hold.
				const untyped = (this.checker.getContextualType(e)?.flags ?? 0) & (ts.TypeFlags.Any | ts.TypeFlags.Unknown);
				if (this.typeOf(e) === 'JSArray<String>' && !untyped) heldLoss('splitElements', '""');
				return this.typeOf(e) === 'JSArray<String>' && !untyped ? `${call}.map { $0 ?? "" }` : call;
			}
			case 'replace':
			case 'replaceAll': {
				const fn = name === 'replace' ? RT.jsReplace : RT.jsReplaceAll;
				// A function value: called with the match, each group (undefined where it took no part), the match's index and the string.
				if (!(ts.isArrowFunction(second) || ts.isFunctionExpression(second)) && this.checker.getTypeAtLocation(second).getCallSignatures().length) {
					// A conditional's branches are each held untyped: adapted to one function type, a rest would not take the arguments.
					const bare = ts.skipOuterExpressions(second);
					const f = ts.isConditionalExpression(bare) ? `(${this.cond(bare.condition)} ? ${this.coerce(bare.whenTrue, 'Any?')} : ${this.coerce(bare.whenFalse, 'Any?')})` : this.isAny(second) ? this.expr(second) : this.convert(this.expr(second), this.typeOf(second), 'Any?');
					return `${fn}(${s}, ${r}) { (__m: JSMatch) throws -> String in ${RT.jsToString}(try ${RT.jsCall}(${f}, spread: __m.replacerArguments)) }`;
				}
				if (!(ts.isArrowFunction(second) || ts.isFunctionExpression(second))) return `${fn}(${s}, ${r}, ${this.str(second)})`;
				// The replacer gets the match, then each group.
				const m = this.fresh('__match');
				// The match, each group (undefined where it took no part), the index, the input, then the groups object.
				const source = literalPattern(re, this.checker);
				const groups = source === null ? null : patternGroups(source);
				const binds = second.parameters.map((p, k) => {
					const name = ident((p.name as ts.Identifier).text),
						t = this.typeOf(p.name);
					if (p.dotDotDotToken) return `let ${name}: ${t} = ${this.convert(`JSArray<Any?>(Array(${m}.replacerArguments.dropFirst(${k})))`, 'JSArray<Any?>', t)}`;
					if (k === 0) return `let ${name}: ${t} = ${this.convert(`${m}[0]`, 'String', t)}`;
					const scalar = ['String', 'Double', 'Bool'].includes(t);
					if (groups && k <= groups.count) {
						const value = this.marks.orNil(this.marks.elementOf(m, k, '.values'));
						if (t === 'String' && !groups.unset.has(k)) return `let ${name}: String = ${m}[${k}]`;
						return scalar ? `let ${name}: ${this.bindsOptional(p.name, t)} = ${this.fromAny(value, optionalType(t))}` : `let ${name}: ${t} = ${this.undefinedAs(value, t)}`;
					}
					const value = groups && k === groups.count + 1 ? `${m}.index` : groups && k === groups.count + 2 ? `${m}.input` : this.marks.orNil(`${m}.replacerArguments.dropFirst(${k}).first`);
					if (groups && k <= groups.count + 2) return `let ${name}: ${t} = ${this.convert(value, k === groups.count + 1 ? 'Double' : 'String', t)}`;
					return scalar ? `let ${name}: ${this.bindsOptional(p.name, t)} = ${this.fromAny(value, optionalType(t))}` : `let ${name}: ${t} = ${this.fromAny(value, t)}`;
				});
				const body = this.functionBody(second, 'String', this.indent);
				const inner = this.indent + '    ';
				return `${fn}(${s}, ${r}) { (${m}: JSMatch) ${this.throwsInfo.fn(second) ? 'throws ' : ''}-> String in\n${binds.map((b) => inner + b).join('\n')}${body.slice(1)}`;
			}
		}
		throw this.error(e, `String.${name} with a RegExp`, 'library-member');
	},

	/** `code`, argument `e` placed in a built-in's optional number parameter, absent only where it is undefined (`undefinedAbsent`), a conditional's branches each. */
	optionalNumberArgument(this: Translator, e: ts.Expression | undefined, code: string): string {
		const bare = e && ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (!bare || !ts.isConditionalExpression(bare)) return undefinedAbsent(code);
		const placed = [bare.whenTrue, bare.whenFalse].map((b) => this.coerce(b, 'Double?'));
		const absent = placed.map((b, k) => this.optionalNumberArgument(k ? bare.whenFalse : bare.whenTrue, b));
		return absent.some((b, k) => b !== placed[k]) ? `(${this.cond(bare.condition)} ? ${absent[0]} : ${absent[1]})` : code;
	},

	numberMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression): string {
		const t = this.expr(target);
		return this.marks.leading(this.numberMethodOf(name, e, t), t);
	},

	numberMethodOf(this: Translator, name: string, e: ts.CallExpression, t: string): string {
		// An argument of another type (untyped code's `toPrecision(true)`) converts as ToNumber would, undefined still absent.
		const a = this.args(e).map((code, k) => {
			const x = e.arguments[k],
				at = this.typeOf(x);
			if (at === 'Double' || at === 'Double?' || this.checker.getTypeAtLocation(x).flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return this.optionalNumberArgument(x, code);
			if (argumentRunsConversion(this, x)) return isUntyped(spelledType(at)) ? `${RT.jsToNumberOrUndefinedThrowing}(${this.expr(x)})` : `${RT.jsToNumberThrowing}(${this.coerce(x, 'Any?')})`;
			return isUntyped(spelledType(at)) ? `${RT.jsLenientNumberOrUndefined}(${this.expr(x)})` : this.toNumber(x);
		});
		switch (numberMember(name)?.op) {
			case 'toFixed': {
				const n = digitsLiteral(e.arguments[0], 0, 100, 0);
				return n !== null ? `${RT.jsToFixed}(${t}, digits: ${n})` : `${RT.jsToFixed}(${t}, ${a[0]})`;
			}
			case 'toLocaleString':
				return `${RT.jsNumberToLocaleString}(${[t, ...e.arguments.map((x) => this.restArgument(e, x, 'Any?'))].join(', ')})`;
			case 'toExponential':
				return `${RT.jsToExponential}(${t}${a[0] !== undefined ? `, ${a[0]}` : ''})`;
			case 'toPrecision': {
				const n = digitsLiteral(e.arguments[0], 1, 100, null);
				return !a[0] ? `${RT.js}(${t})` : n !== null ? `${RT.jsToPrecision}(${t}, digits: ${n})` : `${RT.jsToPrecision}(${t}, ${a[0]})`;
			}
			case 'toString': {
				const n = digitsLiteral(e.arguments[0], 2, 36, null);
				return !a[0] ? `${RT.js}(${t})` : n !== null ? `${RT.jsNumberToString}(${t}, base: ${n})` : `${RT.jsNumberToString}(${t}, radix: ${a[0]})`;
			}
			case 'valueOf':
				return t;
		}
		throw this.error(e, `Number.${name}`);
	},

	/** A rejection handler: it takes the reason untyped, whatever its parameter declares. */
	rejectionHandler(this: Translator, e: ts.Expression, result?: string, settles?: string): string {
		if (!(ts.isArrowFunction(e) || ts.isFunctionExpression(e))) {
			// An untyped function (`.catch(done)`): called as script calls it, with the reason.
			if (result && this.isAny(e)) {
				const call = this.marks.tryCode(`${RT.jsCall}(${this.expr(e)}, __reason)`);
				return `{ (__reason: Any?) throws -> ${result} in ${result === 'Void' ? `_ = ${call}` : `return ${this.fromAnyCode(call, result, true)}`} }`;
			}
			// A 0-arg function value (`run: () => Promise<T>`): wrap to ignore the rejection reason.
			const parts = functionParts(this.typeOf(e).replace(/^\((.*)\)!$/, '$1'));
			if (parts && !parts.params.length) {
				const call = this.marks.tryCode(`(${this.fn(e)})()`);
				return `{ (_: Any?) throws -> ${parts.result} in ${parts.result === 'Void' ? call : `return ${call}`} }`;
			}
			return this.fn(e);
		}
		// A handler that only rethrows (`(error) => { …; throw error; }`) is typed as the promise's other handler.
		const own = this.returnTypeOf(e);
		// One that gives only a rejected promise (`return Promise.reject(err)`) gives the promise the other handler's does.
		const typed = own === 'Never' && result ? result : own === 'JSPromise<Never>' && settles ? `JSPromise<${settles}>` : own;
		if (!e.parameters.length) {
			// A handler that ignores the reason still takes it.
			const ret = typed;
			return `{ (_: Any?) ${this.throwsInfo.fn(e) ? 'throws ' : ''}-> ${ret} in\n${this.functionBody(e, ret, this.indent).slice(1)}`;
		}
		const p = e.parameters[0];
		if (this.isAny(p.name) && ts.isIdentifier(p.name) && typed === own) return this.closure(e);
		const ret = typed;
		const reason = this.fresh('__reason');
		const body = this.functionBody(e, ret, this.indent);
		const bind = this.nested(() => this.bindTo(p.name, ts.isIdentifier(p.name) ? this.fromAny(reason, this.typeOf(p.name)) : reason, '', false));
		return `{ (${reason}: Any?) ${this.throwsInfo.fn(e) ? 'throws ' : ''}-> ${ret} in\n${bind}${body.slice(1)}`;
	},

	promiseMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression): string {
		// A promise an optional chain may not make (`this.hud?.animate(…).catch(…)`): nothing chained runs without it.
		const t = `${this.expr(target)}${ts.isOptionalChain(target) && this.typeOf(target).endsWith('?') ? '?' : ''}`;
		const [f, g] = e.arguments;
		const value = this.typeOf(target).replace(/^JSPromise<(.*)>\??$/, '$1');
		switch (promiseMember(name)?.op) {
			case 'then': {
				const adopt = (f && returnsPromise(this, f)) || (g && returnsPromise(this, g));
				const nullFulfilled = f && isNullish(f);
				const hasRejected = g && !isNullish(g);
				// A handler that ignores the value still takes it.
				const ignores = f && !nullFulfilled && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && !f.parameters.length && value !== 'Void';
				let onFulfilled = nullFulfilled ? `{ (__v: ${value}) -> ${value} in ${value === 'Never' ? 'switch __v {}' : '__v'} }` : ignores ? this.closure(f as ts.ArrowFunction, [`_ __unused: ${value}`]) : f && this.fn(f);
				// A function value taking its arguments as a rest (`then(log)` of a `log(...values)`), or any value where the promise's is
				// undefined (`then($DONE)`, which Swift would pass `()`): called with the one value, as it holds it.
				const own = f && !nullFulfilled && !ts.isArrowFunction(f) && !ts.isFunctionExpression(f) ? functionParts(this.typeOf(f).replace(/^\((.*)\)!$/, '$1')) : null;
				if (own && !own.params.length && value !== 'Void') {
					const call = this.marks.tryCode(`(${this.fn(f)})()`);
					onFulfilled = `{ (_: ${value}) throws -> ${own.result} in ${own.result === 'Void' ? call : `return ${call}`} }`;
				} else if (own && !adopt && (own.rest >= 0 || (value === 'Void' && own.params.length && own.params[0] !== 'Void'))) onFulfilled = this.coerce(f, `(${value}) throws -> ${own.result}`);
				// A handler declaring the type of what an untyped promise settles with (`.then((r: Item) => …)` of a `Promise<any>`): it takes the value untyped, read as that type.
				const declared = f && !ignores && isUntyped(spelledType(value)) && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && f.parameters.length ? this.closureParamType(f.parameters[0]) : undefined;
				if (declared && !isUntyped(spelledType(declared)) && !(f as ts.ArrowFunction).parameters[0].dotDotDotToken) {
					const ret = this.closureResult(f as ts.ArrowFunction).target;
					const call = this.marks.tryCode(`(${onFulfilled})(${this.fromAnyCode('__v', declared, true)})`);
					onFulfilled = `{ (__v: Any?) throws -> ${ret} in ${ret === 'Void' ? call : `return ${call}`} }`;
				}
				// A handler giving nothing where the chain is of any value (`const p: Promise<unknown> = q.then(() => {})`): undefined.
				if (f && !adopt && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && this.closureResult(f).target === 'Void' && /^JSPromise<Any\?>[?!]?$/.test(this.typeOf(e))) {
					onFulfilled = `{ (__v: ${value}) throws -> Any? in try (${onFulfilled})(${ignores || f.parameters.length ? '__v' : ''}); return nil }`;
				}
				// A handler giving a promise on one path and nothing on another (`if (video) return load()`): undefined where it gives none.
				const maybe = f && adopt && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) ? /^JSPromise<(.*)>\?$/.exec(this.closureResult(f).target)?.[1] : undefined;
				if (maybe !== undefined) {
					// The promise is then of the value or undefined: one of a value Swift holds optional, unless it is undefined already.
					const held = maybe === 'Void' || isOptional(maybe) ? maybe : optionalType(maybe);
					const call = this.marks.tryCode(`(${onFulfilled})(${ignores || (f as ts.ArrowFunction).parameters.length ? '__v' : ''})`);
					const given = held === maybe ? `${call} ?? JSPromise<${held}>.resolve(${maybe === 'Void' ? '()' : 'nil'})` : `(${call}).map { $0.then { $0 as ${held} } } ?? JSPromise<${held}>.resolve(nil)`;
					onFulfilled = `{ (__v: ${value}) throws -> JSPromise<${held}> in ${given} }`;
				}
				// A handler's promise of a value where the chain is of any value (`promise = promise.then(() => animate())` on a `Promise<any>`): its value untyped.
				const gives = f && adopt && maybe === undefined && !g && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) ? /^JSPromise<(.*)>$/.exec(this.closureResult(f).target)?.[1] : undefined;
				if (gives !== undefined && !isUntyped(spelledType(gives)) && /^JSPromise<Any\?>[?!]?$/.test(this.typeOf(e))) {
					const call = this.marks.tryCode(`(${onFulfilled})(${ignores || (f as ts.ArrowFunction).parameters.length ? '__v' : ''})`);
					onFulfilled = `{ (__v: ${value}) throws -> JSPromise<Any?> in (${call}).then { (__r: ${gives}) -> Any? in ${gives === 'Void' ? 'nil' : this.convert('__r', gives, 'Any?')} } }`;
				}
				// A handler that only throws (`() => { throw new Error(…) }`) beside a rejection handler giving a value: typed as that one.
				const other = g && (ts.isArrowFunction(g) || ts.isFunctionExpression(g)) ? this.returnTypeOf(g) : undefined;
				if (!adopt && f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && this.closureResult(f).target === 'Never' && other && other !== 'Never') {
					onFulfilled = `{ (__v: ${value}) throws -> ${other} in try (${onFulfilled})(${ignores || f.parameters.length ? '__v' : ''}) }`;
				}
				return `${t}.${adopt ? 'thenAdopt' : 'then'}(${[onFulfilled, hasRejected && this.rejectionHandler(g, f && !nullFulfilled && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) ? this.returnTypeOf(f) : nullFulfilled ? value : undefined)].filter(Boolean).join(', ')})`;
			}
			case 'catch': {
				// `promise.catch()` with no handler (or null/undefined) passes the promise through unchanged.
				if (!f || isNullish(f)) return t;
				// An optional chain's promise (`a?.animate().catch(…)`) settles with the same values.
				const result = this.typeOf(e)
					.replace(/[?!]$/, '')
					.replace(/^JSPromise<(.*)>$/, '$1');
				const adopt = returnsPromise(this, f);
				if (result === value) return `${t}.${adopt ? 'catchAdopt' : 'catch'}(${this.rejectionHandler(f, ts.isArrowFunction(f) || ts.isFunctionExpression(f) ? undefined : value, value)})`;
				// The fulfilled value passes through as the wider type the catch handler's result makes.
				// A promise of undefined passes undefined (`Promise<void>`'s catch giving `number | void`).
				const passed = value === 'Void' && (isOptional(result) || isUntyped(spelledType(result))) ? 'nil' : '__value';
				const pass = `{ (__value: ${value}) -> ${adopt ? `JSPromise<${result}>` : result} in ${value === 'Never' ? 'switch __value {}' : adopt ? `JSPromise<${result}>.resolve(${passed})` : `return ${passed}`} }`;
				// A handler returning nothing settles the wider promise with undefined.
				const handlerResult = this.checker.getTypeAtLocation(f).getCallSignatures()[0]?.getReturnType();
				const handler = !adopt && handlerResult && handlerResult.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined) && result.endsWith('?') ? `{ (__reason: Any?) throws -> ${result} in try (${this.rejectionHandler(f)})(__reason); return nil }` : this.rejectionHandler(f);
				return `${t}.${adopt ? 'thenAdopt' : 'then'}(${pass}, ${handler})`;
			}
			case 'finally':
				return `${t}.finally(${this.fn(f)})`;
			case 'cancel':
				return `${t}.cancel()`;
		}
		throw this.error(e, `Promise.${name}`);
	},

	/** Lenient code's `map.get(key)`, `has` or `delete` of a Map or Set keyed by objects, which a missing key is looked up in as itself. */
	missingKeyLookup(this: Translator, e: ts.CallExpression): boolean {
		const callee = e.expression;
		if (!this.lenient || !ts.isPropertyAccessExpression(callee) || !['get', 'has', 'delete'].includes(callee.name.text) || e.arguments.length !== 1) return false;
		const type = this.typeOf(callee.expression).replace(/[?!]$/, '');
		const k = /^JSMap<.*>$/.test(type) ? splitTopLevel(type.slice(6, -1))[0] : /^JSSet<(.*)>$/.exec(type)?.[1];
		return !!k && !isOptional(k) && !isUntyped(spelledType(k)) && this.nullableRef(k) !== k;
	},

	collectionMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression, q: string, receiver?: string): string {
		const t = receiver ?? `${this.expr(target)}${q}`;
		const left = nullishAssignTarget(target);
		const assigned = left ? (this.declaredTypeOf(left) ?? this.typeOf(left)) : null;
		const type = (assigned ?? this.typeOf(target)).replace(/\?$/, '');
		const [k, v] = /^JSMap<(.*), (.*)>$/.exec(type)?.slice(1) ?? [/^JSSet<(.*)>$/.exec(type)?.[1] ?? 'Any?', ''];
		const arg = (n: number, as: string) => this.restArgument(e, e.arguments[n], as);
		// Lenient code: a key that may be missing finds nothing, as undefined finds nothing a program stored by object.
		if (this.missingKeyLookup(e)) {
			const k = /^JSMap<.*>$/.test(type) ? splitTopLevel(type.slice(6, -1))[0] : /^JSSet<(.*)>$/.exec(type)![1];
			const call = this.marks.tryIf(this.receiverThrows(target), `${t}.${name}($0)`);
			const held = `(${arg(0, optionalType(k))} as ${optionalType(k)})`;
			// An untyped value's entry reads back doubly optional, which one optional holds as undefined.
			if (name === 'get') return isUntyped(spelledType(v)) ? this.marks.orNil(`${held}.map { ${call} ?? nil }`) : `${held}.flatMap { ${call} }`;
			return `(${held}.${q ? 'flatMap' : 'map'} { ${call} } ?? false)`;
		}
		switch (collectionMember(name)?.op) {
			case 'get': {
				const key = arg(0, k),
					read = this.marks.marked(`${t}.get(${key})`, { op: 'entry', of: this.marks.valueOf(t), key: this.marks.valueOf(key) });
				// An optional value's entry reads back doubly optional: one nil for a missing key and a stored undefined alike.
				if (!isUntyped(spelledType(v)) && this.states.elementNilIsUndefined(target)) return `(${read} ?? nil)`;
				return isUntyped(spelledType(v)) && !q ? this.marks.orNil(read) : read;
			}
			case 'has':
			case 'delete':
				return `${t}.${name}(${arg(0, k)})`;
			case 'set':
				return `${t}.set(${arg(0, k)}, ${this.elementArgument(e, e.arguments[1], v)})`;
			case 'add':
				return `${t}.add(${this.elementArgument(e, e.arguments[0], k)})`;
			case 'clear':
			case 'keys':
			case 'values':
			case 'entries':
				return `${t}.${name}()`;
			case 'forEach': {
				const f = e.arguments[0];
				const adapted = this.optionalElementCallback(f, target, v || k, v ? [v, k] : [k, k], v ? [0] : [0, 1]);
				if (adapted) return this.ignoringThisArg(e, target, () => `${t}.forEach(${adapted})`);
				if (!(ts.isArrowFunction(f) || ts.isFunctionExpression(f))) return this.ignoringThisArg(e, target, () => `${t}.forEach(${this.expr(f)})`);
				// The map passes (value, key); a callback declaring fewer parameters ignores the rest.
				const params = f.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this')).map((p) => `${ident((p.name as ts.Identifier).text)}: ${this.states.nullishHeld(p) ? nullishType(this.typeOf(p.name)) : this.typeOf(p.name)}`);
				const types = v ? [v, k] : [k, k];
				while (params.length < 2) params.push(`_: ${types[params.length]}`);
				const throws = this.throwsInfo.fn(f) ? 'throws ' : '';
				return this.ignoringThisArg(e, target, () => `${t}.forEach { (${params.join(', ')}) ${throws}-> Void in${this.functionBody(f, 'Void', this.indent).slice(1)}`);
			}
		}
		throw this.error(e, `${type.startsWith('JSMap') ? 'Map' : 'Set'}.${name}`);
	},
};
