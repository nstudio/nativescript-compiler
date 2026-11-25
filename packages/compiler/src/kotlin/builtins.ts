// JavaScript's built-in library calls (Array, String, RegExp, Number, Promise, Map and Set, Math) as Kotlin.
import ts from 'typescript';
import { MATH, MATH_OF_SPREAD } from './library.ts';
import { mathFunction } from '../semantics/apis/math.ts';
import type { Translator } from './translator.ts';
import { arrayMember } from '../semantics/apis/array.ts';
import { collectionMember } from '../semantics/apis/mapset.ts';
import { argumentRunsConversion, numberMember } from '../semantics/apis/number.ts';
import { promiseMember } from '../semantics/apis/promise.ts';
import { regexpStringMember } from '../semantics/apis/regexp.ts';
import { stringMember } from '../semantics/apis/string.ts';
import { cast, functionTypeParts, ident, isFunctionType, isNullable, isThisParameter, optionalType, splitTopLevel, undefinedAbsent, RT, adaptOf } from './syntax.ts';
import { assertedPattern, boxedReplacement, nullishAssignTarget, spreadsArrays } from '../semantics/lang.ts';
import { callbackArity } from '../semantics/ast.ts';
import { literalPattern, patternGroups } from '../semantics/regexp.ts';
import { elementStoreOf } from '../semantics/placement.ts';
import { isPromiseType, returnsPromise } from '../semantics/spelled.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { literalCallback } from '../semantics/conversion.ts';

export const builtinMethods = {
	math(this: Translator, name: string, e: ts.CallExpression): string {
		const m = mathFunction(name);
		if (!m) throw this.error(e, `Math.${name}`);
		const ofSpread = MATH_OF_SPREAD[m.op];
		if (ofSpread && e.arguments.some(ts.isSpreadElement)) return `${ofSpread}(${this.packed(e.arguments, 'JSArray<Double>')})`;
		const a = e.arguments.map((x) => (this.isAny(x) ? this.toNumber(x) : this.coerce(x, 'Double')));
		if (!m.arity && !m.rest) return MATH[m.op];
		return `${MATH[m.op]}(${(m.rest ? a : Array.from({ length: m.arity }, (_, k) => a[k] ?? 'Double.NaN')).join(', ')})`;
	},

	/**
	 * A function value (not a literal) given the optional elements of a container `optionalElements` holds, its own type
	 * taking them present: a lambda of the slot's parameters calling it, each element as its parameter reads undefined.
	 * `slot` lists the callback's parameters as the method passes them, the elements at `at`; null when the value takes
	 * them as they are.
	 */
	optionalElementCallback(this: Translator, f: ts.Expression, target: ts.Expression, el: string, slot: string[], at: number[], arity = 0): string | null {
		if (this.library || ts.isArrowFunction(f) || ts.isFunctionExpression(f) || !isNullable(el) || !this.states.optionalElements(target)) return null;
		const parts = functionTypeParts(this.typeOf(f).replace(/^\((.*)\)\?$/, '$1'));
		if (!parts || !parts.params.length) return null;
		const params = parts.params.slice(0, slot.length);
		if (!arity && params.every((p, k) => p === slot[k])) return null;
		const names = slot.map((_, k) => `__p${k}`);
		const args = params.map((p, k) => {
			if (p === slot[k]) return names[k];
			if (at.includes(k)) return this.undefinedAs(names[k], p);
			const array = /^JSArray<(.*)>[?!]?$/.exec(p)?.[1];
			if (array && slot[k] === `JSArray<${el}>`) return `${names[k]}.map { __x: ${el} -> ${this.undefinedAs('__x', array)} }`;
			return this.unchecked(p, names[k]);
		});
		const taken = Math.max(params.length, Math.min(arity, slot.length));
		return `{ ${slot
			.slice(0, taken)
			.map((t, k) => `${k < params.length ? names[k] : '_'}: ${t}`)
			.join(', ')} -> (${this.functionValue(f)})(${args.join(', ')}) }`;
	},

	/**
	 * A choice of callbacks (`flag ? show : (v) => …`) given the optional elements of a container `optionalElements`
	 * holds: chosen once, each branch a lambda of the slot's parameters, a literal taking the elements as they are and a
	 * function value through `optionalElementCallback`. Null for any other callback.
	 */
	optionalElementChoice(this: Translator, f: ts.Expression, target: ts.Expression, el: string, slot: string[], at: number[], ret: string): string | null {
		const choice = ts.skipParentheses(f);
		if (this.library || !ts.isConditionalExpression(choice) || !isNullable(el) || !this.states.optionalElements(target)) return null;
		const leaves = (x: ts.Expression): ts.Expression[] => {
			const b = ts.skipParentheses(x);
			return ts.isConditionalExpression(b) ? [...leaves(b.whenTrue), ...leaves(b.whenFalse)] : [b];
		};
		const arityOf = (x: ts.Expression) => (ts.isArrowFunction(x) || ts.isFunctionExpression(x) ? x.parameters.length : (functionTypeParts(this.typeOf(x).replace(/^\((.*)\)\?$/, '$1'))?.params.length ?? 1));
		const arity = Math.min(slot.length, Math.max(1, ...leaves(choice).map(arityOf)));
		const type = `(${slot.slice(0, arity).join(', ')}) -> ${ret}`;
		const branch = (x: ts.Expression): string => {
			const b = ts.skipParentheses(x);
			if (ts.isConditionalExpression(b)) return `(if (${this.cond(b.condition)}) ${branch(b.whenTrue)} else ${branch(b.whenFalse)})`;
			if (ts.isArrowFunction(b) || ts.isFunctionExpression(b)) return this.closure(b, type);
			return this.optionalElementCallback(b, target, el, slot, at, arity) ?? this.fn(b, type);
		};
		// The branches' lambdas take the slot's type from where the choice goes.
		return `run<${type}> { ${branch(choice)} }`;
	},

	arrayMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression, q: string): string {
		this.refuseTypedUnsetCallback(e);
		const t = `${this.expr(target)}${q}`;
		const el = this.typeOf(target)
			.replace(/\?$/, '')
			.replace(/^JSArray<(.*)>$/, '$1')
			.replace(/^(Pair|Triple)<.*>$/, 'Any?');
		const elOf = () => (this.subst.has(target) ? (/^JSArray<(.*)>\(/.exec(this.subst.get(target)!)?.[1] ?? el) : el);
		const element = elOf();
		// Elements held untyped (not a tuple's, which Kotlin holds as its Pair): a literal declaring their type is adapted.
		const untypedElements = isUntyped(
			spelledType(
				this.typeOf(target)
					.replace(/\?$/, '')
					.replace(/^JSArray<(.*)>$/, '$1'),
			),
		);
		switch (arrayMember(name)?.op) {
			case 'push':
			case 'unshift':
				if (e.arguments.some(ts.isSpreadElement)) return `${t}.${name}All(${this.packed(e.arguments, `JSArray<${element}>`, this.elementSlot(e, element))})`;
				return `${t}.${name}(${e.arguments.map((x) => this.elementArgument(e, x, element)).join(', ')})`;
			case 'pop':
			case 'shift':
			case 'reverse':
			case 'keys':
			case 'entries':
			case 'values':
				return `${t}.${name}()`;
			case 'toLocaleString':
				if (!e.arguments.length) return `${t}.toLocaleString()`;
				break;
			case 'toString':
				return `${t}.join()`;
			case 'flat':
				return e.arguments.length || !/^JSArray<JSArray</.test(this.typeOf(target)) ? `${t}.flatAny(${e.arguments[0] ? this.toNumber(e.arguments[0]) : ''})` : `${t}.flat()`;
			case 'splice': {
				if (e.arguments.slice(2).some(ts.isSpreadElement))
					return `${t}.spliceAll(${e.arguments
						.slice(0, 2)
						.map((x) => this.toNumber(x))
						.join(', ')}, ${this.packed(e.arguments.slice(2), `JSArray<${element}>`, this.elementSlot(e, element))}.storage)`;
				const parts = [...e.arguments.slice(0, 2).map((x) => this.toNumber(x)), ...e.arguments.slice(2).map((x) => this.elementArgument(e, x, element))];
				return `${t}.splice(${parts.join(', ')})`;
			}
			case 'fill':
				return `${t}.fill(${[this.elementArgument(e, e.arguments[0], element), ...e.arguments.slice(1).map((x) => this.toNumber(x))].join(', ')})`;
			case 'slice':
			case 'at':
				return `${t}.${name}(${e.arguments.map((x) => this.toNumber(x)).join(', ')})`;
			case 'indexOf':
			case 'lastIndexOf':
			case 'includes':
				return `${t}.${name}(${[this.restArgument(e, e.arguments[0], isKit(spelledType(element), 'JSNullish') ? element : optionalType(element)), ...e.arguments.slice(1).map((x) => this.toNumber(x))].join(', ')})`;
			case 'join':
				return `${t}.join(${e.arguments[0] ? this.joinSeparator(e.arguments[0]) : ''})`;
			case 'concat':
				// Arrays spread as arguments are concatenated, which the runtime tells apart from elements as script does.
				if (e.arguments.some((x) => ts.isSpreadElement(x) && spreadsArrays(x.expression, this.checker))) return `${t}.concatSpread(${this.unchecked(`List<${element}>`, `${this.packed(e.arguments, 'JSArray<Any?>', this.restSlot(e, 'Any?'))}.storage`)})`;
				if (e.arguments.some(ts.isSpreadElement)) return `${t}.concatSpread(${this.packed(e.arguments, `JSArray<${element}>`, this.restSlot(e, element))}.storage)`;
				return `${t}.concat(${e.arguments.map((x) => (this.isArray(x) ? this.restArgument(e, x, `JSArray<${element}>`) : `${RT.jsArrayOf}<${element}>(${this.restArgument(e, x, element)})`)).join(', ')})`;
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
				const f = e.arguments[0];
				const arity = ts.isArrowFunction(f) || ts.isFunctionExpression(f) ? Math.max(1, f.parameters.filter((q) => !isThisParameter(q)).length) : this.functionArity(f);
				// Library mode: map's result is the element type the call gives, so a function value can be adapted to it.
				// So is `map<U>(…)`'s, whose U the callback's results are held as, and one of a function held untyped (a union of function types).
				const literal = ts.isArrowFunction(f) || ts.isFunctionExpression(f);
				const mapped =
					name === 'map' && ((!literal && (this.library || this.isAny(f))) || !!e.typeArguments?.length)
						? this.typeOf(e)
								.replace(/\?$/, '')
								.replace(/^JSArray<(.*)>$/, '$1')
						: null;
				// A literal declaring no parameters still takes the element: the runtime's overloads start at one.
				const bare = (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && !f.parameters.length ? this.returnTypeOf(f) : null;
				const ret = name === 'forEach' ? 'Unit' : ['map', 'flatMap'].includes(name) ? (mapped ?? bare) : 'Boolean';
				const out =
					name === 'forEach'
						? 'Unit'
						: name === 'map'
							? this.typeOf(e)
									.replace(/\?$/, '')
									.replace(/^JSArray<(.*)>$/, '$1')
							: name === 'flatMap'
								? undefined
								: 'Boolean';
				const adapted = (out && this.optionalElementChoice(f, target, element, [element, 'Double', `JSArray<${element}>`], [0], out)) || this.optionalElementCallback(f, target, element, [element, 'Double', `JSArray<${element}>`], [0]);
				if (adapted) return this.ignoringThisArg(e, target, () => `${t}.${name}(${adapted})`);
				const params = [element, 'Double', `JSArray<${element}>`].slice(0, Math.min(3, arity));
				// A predicate held untyped may give any value: its truthiness decides.
				if (ret === 'Boolean' && callbackArity(f, this.checker) === Infinity) {
					const names = params.map((_, k) => `__p${k}`);
					const truthy = () => `${this.fn(f, `(${params.join(', ')}) -> Any?`)}.let { __f -> ${adaptOf(params.length)}<${[...params, 'Boolean'].join(', ')}>(__f) { ${names.join(', ')} -> ${RT.jsTruthy}(__f(${names.join(', ')})) } }`;
					return this.ignoringThisArg(e, target, () => `${t}.${name}(${truthy()})`);
				}
				// A literal declaring types for an untyped array's elements is adapted to the slot (`closure`), which needs its result.
				const adapts =
					literal &&
					untypedElements &&
					!ret &&
					!!out &&
					literalCallback(
						params.map((p) => spelledType(p)),
						f.parameters.filter((q) => !isThisParameter(q)).map((p) => spelledType(this.paramType(p))),
					) === 'adapt';
				const slot = ret || adapts ? `(${params.join(', ')}) -> ${ret ?? out}` : undefined;
				const code = this.ignoringThisArg(e, target, () => `${t}.${name}(${this.fn(f, slot)})`);
				// A type-guard filter or find (`(s): s is Circle => …`): its elements as the guard narrows them.
				const own = this.typeOf(e);
				if (name === 'filter' && /^JSArray<\w+>$/.test(own) && own !== `JSArray<${element}>`) return cast(code, own);
				if (name === 'find' && /^\w+\??$/.test(own) && own.replace(/\?$/, '') !== element.replace(/\?$/, '') && !isUntyped(spelledType(own)) && !isKit(spelledType(element), 'JSNullish')) return `(${code} as ${own.endsWith('?') ? own : own + '?'})`;
				return code;
			}
			case 'sort':
				return e.arguments[0] ? `${t}.sort(${this.fn(e.arguments[0], `(${element}, ${element}) -> Double`)})` : `${t}.sort()`;
			case 'toSorted':
				return e.arguments[0] ? `${t}.toSorted(${this.fn(e.arguments[0], `(${element}, ${element}) -> Double`)})` : `${t}.toSorted()`;
			case 'toReversed':
				return `${t}.toReversed()`;
			case 'toSpliced': {
				if (!e.arguments.length) return `${t}.toSpliced(0.0, 0.0)`;
				if (e.arguments.slice(2).some(ts.isSpreadElement))
					return `${t}.toSplicedAll(${e.arguments
						.slice(0, 2)
						.map((x) => this.toNumber(x))
						.join(', ')}, ${this.packed(e.arguments.slice(2), `JSArray<${element}>`, this.restSlot(e, element))}.storage)`;
				return `${t}.toSpliced(${[...e.arguments.slice(0, 2).map((x) => this.toNumber(x)), ...e.arguments.slice(2).map((x) => this.restArgument(e, x, element))].join(', ')})`;
			}
			case 'with':
				return `${t}.with(${this.toNumber(e.arguments[0])}, ${this.restArgument(e, e.arguments[1], element)})`;
			case 'reduce':
			case 'reduceRight': {
				const init = e.arguments[1];
				const f = e.arguments[0];
				const literal = ts.isArrowFunction(f) || ts.isFunctionExpression(f);
				const arity = literal ? f.parameters.length : this.library ? (functionTypeParts(this.typeOf(f).replace(/^\((.*)\)\?$/, '$1'))?.params.length ?? 2) : 2;
				const types = (acc: string) => [acc, element, 'Double', `JSArray<${element}>`].slice(0, Math.max(2, Math.min(literal ? 3 : 4, arity)));
				if (init) {
					const acc = this.typeOf(e);
					const slot = [acc, element, 'Double', `JSArray<${element}>`];
					const adapted = this.optionalElementChoice(f, target, element, slot, [1], acc) || this.optionalElementCallback(f, target, element, slot, [1]);
					// An adapted literal (`closure`) is no lambda the generic overloads infer their accumulator from: named.
					const named =
						!adapted &&
						literal &&
						untypedElements &&
						literalCallback(
							types(acc).map((p) => spelledType(p)),
							f.parameters.map((p) => spelledType(this.paramType(p))),
						) === 'adapt'
							? `<${acc}>`
							: '';
					return `${t}.${name}${named}(${adapted ?? this.fn(f, `(${types(acc).join(', ')}) -> ${acc}`)}, ${this.coerce(init, acc)})`;
				}
				return `${t}.${name}(${this.fn(f, `(${this.library ? types(element).join(', ') : `${element}, ${element}`}) -> ${element}`)})`;
			}
		}
		throw this.error(e, `Array.${name}`);
	},

	/** A built-in's call taking a callback and a thisArg, made as `thisArgUse` has it; `make` translates it without the thisArg. */
	ignoringThisArg(this: Translator, e: ts.CallExpression, target: ts.Expression | undefined, make: () => string): string {
		const use = this.thisArgUse(e, target);
		if (use.kind === 'plain') return make();
		if (use.kind === 'unbound') return this.withThis(use.bound, 'null', true, make);
		if (use.kind === 'evaluated') return `run { ${this.exprStatement(use.thisArg)}; ${make()} }`;
		const declared = use.self ? this.type(this.checker.getTypeAtLocation(use.self.name), use.self) : 'Any?';
		const type = !isUntyped(spelledType(declared)) ? declared : 'Any?';
		const held = this.fresh('__thisArg');
		const code = this.withThis(use.bound, held, isUntyped(spelledType(type)), make);
		// The thisArg slot is untyped, where an object literal is made untyped: read as the declared `this`.
		const value = !isUntyped(spelledType(type)) && ts.isObjectLiteralExpression(ts.skipParentheses(use.thisArg)) ? this.fromAnyCode(this.coerce(use.thisArg, 'Any?'), type, true) : this.coerce(use.thisArg, type);
		return `run { val ${held}: ${type} = ${value}; ${code} }`;
	},

	/** A pattern an assertion from untyped gives (`assertedPattern`), as its untyped value. */
	assertedPatternValue(this: Translator, x: ts.Expression): string {
		x = ts.skipParentheses(x);
		if (ts.isConditionalExpression(x)) return `(if (${this.cond(x.condition)}) ${this.assertedPatternValue(x.whenTrue)} else ${this.assertedPatternValue(x.whenFalse)})`;
		if ((ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)) && this.checker.getTypeAtLocation(x.expression).flags & ts.TypeFlags.Any) return this.expr(x.expression);
		return this.coerce(x, 'Any?');
	},

	/** `s.replace(p, r)` as `boxedReplacement` has it: the pattern and the replacement untyped. */
	boxedReplace(this: Translator, name: string, s: string, e: ts.CallExpression): string {
		const [p, r] = e.arguments;
		const pattern = assertedPattern(p, this.checker) ? this.assertedPatternValue(p) : this.coerce(p, 'Any?');
		return `${name === 'replace' ? RT.jsReplaceBoxed : RT.jsReplaceAllBoxed}(${s}, ${pattern}, ${this.coerce(r, 'Any?')})`;
	},

	stringMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression, receiver?: string): string {
		const t = receiver ?? this.expr(target);
		const first = e.arguments[0];
		if (boxedReplacement(name, e, this.checker)) return this.boxedReplace(name, t, e);
		const asserted = !!first && name !== 'matchAll' && assertedPattern(first, this.checker);
		if (first && this.typeOf(first) === 'JSRegExp' && !asserted) return this.regexpStringMethod(name, t, e);
		const s = (k: number) => this.str(e.arguments[k]);
		const untyped = !first ? undefined : asserted ? this.assertedPatternValue(first) : this.isAny(first) ? this.expr(first) : undefined;
		const n = (k: number) => this.toNumber(e.arguments[k]);
		const opt = (k: number) => (e.arguments[k] ? `, ${n(k)}` : '');
		switch (stringMember(name)?.op) {
			case 'toLowerCase':
			case 'toLocaleLowerCase':
				return `${RT.jsLowerCase}(${t})`;
			case 'toUpperCase':
			case 'toLocaleUpperCase':
				return `${RT.jsUpperCase}(${t})`;
			case 'includes':
				return `${RT.jsIncludes}(${t}, ${s(0)}${opt(1)})`;
			case 'startsWith':
				return `${RT.jsStartsWith}(${t}, ${s(0)}${opt(1)})`;
			case 'endsWith':
				return `${RT.jsEndsWith}(${t}, ${s(0)}${opt(1)})`;
			case 'trim':
				return `${RT.jsTrim}(${t})`;
			case 'trimStart':
				return `${RT.jsTrimStart}(${t})`;
			case 'trimEnd':
				return `${RT.jsTrimEnd}(${t})`;
			case 'split': {
				const call = untyped ? `${RT.jsSplitUntyped}(${t}, ${untyped}${opt(1)})` : `${RT.jsSplit}(${t}, ${first ? s(0) : 'null'}${opt(1)})`;
				return this.unsetGroups(e) ? this.unchecked('JSArray<String?>', call) : call;
			}
			case 'indexOf':
				return `${RT.jsIndexOf}(${t}, ${s(0)}${opt(1)})`;
			case 'lastIndexOf':
				return `${RT.jsLastIndexOf}(${t}, ${s(0)}${opt(1)})`;
			case 'slice':
				return `${RT.jsSlice}(${t}${e.arguments.map((_, k) => `, ${n(k)}`).join('')})`;
			case 'substring':
				return `${RT.jsSubstring}(${t}, ${first ? n(0) : '0.0'}${opt(1)})`;
			case 'substr':
				return `${RT.jsSubstr}(${t}, ${first ? n(0) : '0.0'}${opt(1)})`;
			case 'match':
				return `${RT.jsMatch}(${t}, ${RT.jsRegExpFrom}(${untyped ?? (first ? this.coerce(first, 'Any?') : 'null')}))`;
			case 'replace':
				return untyped ? `${RT.jsReplaceUntyped}(${t}, ${untyped}, ${s(1)})` : `${RT.jsReplace}(${t}, ${s(0)}, ${s(1)})`;
			case 'replaceAll':
				return untyped ? `${RT.jsReplaceAllUntyped}(${t}, ${untyped}, ${s(1)})` : `${RT.jsReplaceAll}(${t}, ${s(0)}, ${s(1)})`;
			case 'charAt':
				return `${RT.jsCharAt}(${t}, ${first ? n(0) : '0.0'})`;
			case 'charCodeAt':
				return `${RT.jsCharCodeAt}(${t}, ${first ? n(0) : '0.0'})`;
			case 'codePointAt':
				return `${RT.jsCodePointAt}(${t}, ${first ? n(0) : '0.0'})`;
			case 'at':
				return `${RT.jsStringAt}(${t}, ${n(0)})`;
			case 'repeat':
				return `${RT.jsRepeat}(${t}, ${n(0)})`;
			case 'padStart':
				return `${RT.jsPadStart}(${t}, ${n(0)}${e.arguments[1] ? `, ${s(1)}` : ''})`;
			case 'padEnd':
				return `${RT.jsPadEnd}(${t}, ${n(0)}${e.arguments[1] ? `, ${s(1)}` : ''})`;
			case 'concat':
				return `(${[t, ...e.arguments.map((x) => this.str(x))].join(' + ')})`;
			case 'localeCompare':
				return e.arguments.length > 1 ? `${RT.jsLocaleCompare}(${[t, s(0), ...e.arguments.slice(1).map((x) => this.coerce(x, 'Any?'))].join(', ')})` : `${RT.jsLocaleCompare}(${t}, ${s(0)})`;
			// A string searches as `new RegExp(x)` does.
			case 'search':
				return untyped ? `${RT.jsSearch}(${t}, ${RT.jsRegExpFrom}(${untyped}))` : `${RT.jsSearch}(${t}, JSRegExp(${e.arguments[0] ? s(0) : '"(?:)"'}))`;
			case 'toString':
			case 'valueOf':
				return t;
		}
		throw this.error(e, `String.${name}`, 'library-member');
	},

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
				const call = `${RT.jsSplit}(${s}, ${r}${second ? `, ${this.toNumber(second)}` : ''})`;
				return this.unsetGroups(e) ? this.unchecked('JSArray<String?>', call) : call;
			}
			case 'replace':
			case 'replaceAll': {
				const fn = name === 'replace' ? RT.jsReplace : RT.jsReplaceAll;
				// A function value: called with the match, each group (undefined where it took no part), the match's index and the string.
				if (!(ts.isArrowFunction(second) || ts.isFunctionExpression(second)) && this.checker.getTypeAtLocation(second).getCallSignatures().length) {
					if (name === 'replaceAll') throw this.error(e, 'replaceAll with a function');
					// A rest parameter takes the arguments from its position on, which a call by script cannot give it.
					const decl = this.checker.getTypeAtLocation(second).getCallSignatures()[0]?.getDeclaration();
					const restAt = decl && !ts.isJSDocSignature(decl) ? decl.parameters.findIndex((p) => p.dotDotDotToken) : -1;
					const branched = ts.isConditionalExpression(ts.skipOuterExpressions(second));
					if (decl && !ts.isJSDocSignature(decl) && !branched && restAt >= 0 && restAt === decl.parameters.length - 1) {
						const args = decl.parameters.map((p, k) => {
							if (k < restAt) return this.fromAnyCode(this.marks.pureCode(`__m.replacerArguments.getOrNull(${k})`), this.paramType(p), true);
							const rest = `JSArray<Any?>(ArrayList(__m.replacerArguments.drop(${k})))`,
								t = this.typeOf(p.name);
							return t === 'JSArray<Any?>' ? rest : this.fromAnyCode(rest, t, true);
						});
						return `${fn}(${s}, ${r}, fun(__m: JSMatch): String = ${RT.jsToString}((${this.functionValue(second)})(${args.join(', ')})))`;
					}
					const callee = !this.library && branched ? this.coerce(second, 'Any?') : this.functionValue(second);
					return `${fn}(${s}, ${r}, fun(__m: JSMatch): String = ${RT.jsToString}(${RT.jsCall}(${callee}, *__m.replacerArguments.toTypedArray())))`;
				}
				if (!(ts.isArrowFunction(second) || ts.isFunctionExpression(second))) return `${fn}(${s}, ${r}, ${this.str(second)})`;
				if (name === 'replaceAll') throw this.error(e, 'replaceAll with a function');
				// The replacer gets the match, then each group, then the offset.
				const m = this.fresh('__match');
				// The match, each group (undefined where it took no part), the index, the input, then the groups object.
				const source = literalPattern(re, this.checker);
				const groups = source === null ? null : patternGroups(source);
				const binds = second.parameters.map((p, k) => {
					const name = ident((p.name as ts.Identifier).text),
						t = this.typeOf(p.name);
					const bind = (code: string) => `val ${name}: ${t} = ${code}`;
					if (p.dotDotDotToken) {
						const rest = `JSArray<Any?>(ArrayList(${m}.replacerArguments.drop(${k})))`;
						return bind(t === 'JSArray<Any?>' ? rest : this.fromAnyCode(rest, t, true));
					}
					const group = (code: string) => (t.endsWith('?') ? code : `(${code} ?: "undefined")`);
					// A group that took no part gives undefined, which the binding holds as it is.
					if (k > 0 && groups && k <= groups.count && t === 'String' && !this.library && ts.isIdentifier(p.name)) {
						const sym = this.resolve(p.name);
						if (sym) this.undefinedVars.set(sym, 'String?');
						return `val ${name}: String? = ${m}[${k}]`;
					}
					if (k === 0 || (groups && k <= groups.count)) return bind(group(`${m}[${k}]`));
					if (groups && k === groups.count + 1) return bind(isNamed(spelledType(t), 'Double', false) ? `${m}.index` : this.fromAnyCode(`${m}.index`, t, true));
					if (groups && k === groups.count + 2) return bind(isNamed(spelledType(t), 'String', false) ? `${m}.input` : this.fromAnyCode(`${m}.input`, t, true));
					return bind(this.fromAnyCode(this.marks.pureCode(`${m}.replacerArguments.getOrNull(${k})`), t, true));
				});
				const body = this.inFunction('String', () => this.functionBody(second, 'String', this.indent));
				const inner = this.indent + '    ';
				return `${fn}(${s}, ${r}, fun(${m}: JSMatch): String {\n${binds.map((b) => inner + b).join('\n')}${body.slice(1)})`;
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
		return absent.some((b, k) => b !== placed[k]) ? `(if (${this.cond(bare.condition)}) ${absent[0]} else ${absent[1]})` : code;
	},

	numberMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression): string {
		const t = this.expr(target);
		// An argument of another type (untyped code's `toPrecision(true)`) converts as ToNumber would, undefined still absent.
		const a = this.args(e).map((code, k) => {
			const x = e.arguments[k],
				at = this.typeOf(x);
			if (at === 'Double' || at === 'Double?' || this.checker.getTypeAtLocation(x).flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return this.optionalNumberArgument(x, code);
			const convert = argumentRunsConversion(this, x) ? RT.jsToNumberThrowing : RT.jsToNumber;
			return isUntyped(spelledType(at)) ? `${this.expr(x)}?.let { ${convert}(it) }` : convert === RT.jsToNumber ? this.toNumber(x) : `${convert}(${this.coerce(x, 'Any?')})`;
		});
		switch (numberMember(name)?.op) {
			case 'toFixed':
				return `${RT.jsToFixed}(${t}${a[0] ? `, ${a[0]}` : ''})`;
			case 'toLocaleString':
				return `${RT.jsNumberToLocaleString}(${[t, ...e.arguments.map((x) => this.restArgument(e, x, 'Any?'))].join(', ')})`;
			case 'toPrecision':
				return a[0] ? `${RT.jsToPrecision}(${t}, ${a[0]})` : `${RT.js}(${t})`;
			case 'toExponential':
				return `${RT.jsToExponential}(${t}${a[0] ? `, ${a[0]}` : ''})`;
			case 'toString':
				return a[0] ? `${RT.jsNumberToString}(${t}, ${a[0]})` : `${RT.js}(${t})`;
			case 'valueOf':
				return t;
		}
		throw this.error(e, `Number.${name}`);
	},

	/** A handler's promise result: nullable where the handler may give undefined instead (`n > 0 ? promise : undefined`). */
	adoptedResult(this: Translator, handlers: (ts.Expression | undefined)[], result: string): string {
		const maybeUndefined = handlers.some((h) => {
			const sig = h && this.checker.getTypeAtLocation(h).getCallSignatures()[0];
			return !!sig && isPromiseType(this.nativeOfType(sig.getReturnType(), h)) && isNullable(this.type(sig.getReturnType(), h));
		});
		return `JSPromise<${result}>${maybeUndefined ? '?' : ''}`;
	},

	/** A rejection handler: it takes the reason untyped, whatever its parameter declares. */
	rejectionHandler(this: Translator, e: ts.Expression, ret?: string): string {
		if (!(ts.isArrowFunction(e) || ts.isFunctionExpression(e))) return this.isAny(e) ? this.fn(e, `(Any?) -> ${ret ?? 'Any?'}`) : this.fn(e);
		if (!e.parameters.length) return this.closure(e, `(Any?) -> ${ret ?? this.returnTypeOf(e)}`);
		const p = e.parameters[0];
		const r = ret ?? this.returnTypeOf(e);
		if (this.isAny(p.name) && ts.isIdentifier(p.name)) return this.closure(e, `(Any?) -> ${r}`);
		const reason = this.fresh('__reason');
		const body = this.functionBody(e, r, this.indent);
		const bind = this.nested(() => this.bindTo(p.name, ts.isIdentifier(p.name) ? this.fromAny(reason, this.typeOf(p.name)) : reason, '', false));
		return `fun(${reason}: Any?)${r === 'Unit' ? '' : `: ${r}`} {\n${bind}${body.slice(1)}`;
	},

	promiseMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression): string {
		// A promise of an optional chain (`this.hud?.animate(…).catch(…)`): the chain's undefined passes through.
		const t = `${this.expr(target)}${this.typeOf(target).endsWith('?') ? '?' : ''}`;
		const [f, g] = e.arguments;
		const value = this.typeOf(target).replace(/^JSPromise<(.*)>\??$/, '$1');
		const result = this.typeOf(e).replace(/^JSPromise<(.*)>\??$/, '$1');
		switch (promiseMember(name)?.op) {
			case 'then': {
				const adopt = (f && returnsPromise(this, f)) || (g && returnsPromise(this, g));
				const ret = adopt ? this.adoptedResult([f, g], result) : result;
				const onF = f && this.fn(f, `(${value}) -> ${ret}`);
				return `${t}.${adopt ? 'thenAdopt' : 'then'}<${result}>(${[onF, g && this.rejectionHandler(g, ret)].filter(Boolean).join(', ')})`;
			}
			case 'catch': {
				const adopt = returnsPromise(this, f);
				if (result === value) return `${t}.${adopt ? 'catchAdopt' : 'catch'}(${this.rejectionHandler(f, adopt ? this.adoptedResult([f], result) : result)})`;
				if (isUntyped(spelledType(result)) && !adopt) return `${t}.catchAny(${this.rejectionHandler(f, 'Any?')})`;
				// A promise of undefined passes undefined (`Promise<void>`'s catch giving `number | void`).
				const passed = value === 'Unit' && isNullable(result) ? 'null' : '__value';
				const pass = `{ __value: ${value} -> ${adopt ? `JSPromise.resolve<${result}>(${passed})` : passed} }`;
				return `${t}.${adopt ? 'thenAdopt' : 'then'}<${result}>(${pass}, ${this.rejectionHandler(f, adopt ? this.adoptedResult([f], result) : result)})`;
			}
			case 'finally':
				return returnsPromise(this, f) ? `${t}.finallyAdopt(${this.fn(f)})` : `${t}.finally(${this.fn(f, '() -> Unit')})`;
			case 'cancel':
				return `${t}.cancel()`;
		}
		throw this.error(e, `Promise.${name}`);
	},

	collectionMethod(this: Translator, name: string, target: ts.Expression, e: ts.CallExpression, q: string): string {
		const t = `${this.expr(target)}${q}`;
		const left = nullishAssignTarget(target);
		const type = ((left && (this.declaredTypeOf(left) ?? this.typeOf(left))) || this.typeOf(target)).replace(/\?$/, '');
		const [k, v] = (() => {
			const m = /^JSMap<(.*)>$/.exec(type);
			if (m) return splitTopLevel(m[1]);
			return [/^JSSet<(.*)>$/.exec(type)?.[1] ?? 'Any?', ''];
		})();
		// Library mode: a value or key that may be null where the collection's type says not (`cache.set(key, null)`), stored as script stores it.
		const given = (n: number, as: string) => (elementStoreOf(this.checker, e.arguments[n]) ? this.elementArgument(e, e.arguments[n], as) : this.restArgument(e, e.arguments[n], as));
		const arg = (n: number, as: string) => (this.library && this.isObjectType(as) && !isNullable(as) && !['String', 'Double', 'Boolean'].includes(as) && !isFunctionType(as) && (isNullable(this.declaredTypeOf(e.arguments[n]) ?? this.typeOf(e.arguments[n])) || !!this.maybeUndefined(e.arguments[n])) ? this.unchecked(as, given(n, optionalType(as))) : given(n, as));
		switch (collectionMember(name)?.op) {
			case 'get': {
				const key = arg(0, k);
				const read = this.marks.marked(`${t}.get(${key})`, { op: 'entry', of: this.marks.valueOf(t), key: this.marks.valueOf(key) });
				const rt = this.typeOf(e);
				return rt.endsWith('?') || isUntyped(spelledType(rt)) || this.optionalReads.has(e) ? read : this.undefinedAs(read, rt);
			}
			case 'has':
			case 'delete':
				return `${t}.${name}(${arg(0, k)})`;
			case 'set':
				return `${t}.set(${arg(0, k)}, ${arg(1, v)})`;
			case 'add':
				return `${t}.add(${arg(0, k)})`;
			case 'clear':
			case 'keys':
			case 'values':
			case 'entries':
				return `${t}.${name}()`;
			case 'forEach': {
				const f = e.arguments[0];
				const types = v ? [v, k] : [k, k];
				// The collection itself, third, where the callback names it.
				if ((ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && f.parameters.filter((q) => !isThisParameter(q)).length > 2) types.push(type);
				const adapted = this.optionalElementCallback(f, target, v || k, types, v ? [0] : [0, 1]);
				return this.ignoringThisArg(e, target, () => `${t}.forEach(${adapted ?? this.fn(f, `(${types.join(', ')}) -> Unit`)})`);
			}
		}
		throw this.error(e, `${type.startsWith('JSMap') ? 'Map' : 'Set'}.${name}`);
	},
};
