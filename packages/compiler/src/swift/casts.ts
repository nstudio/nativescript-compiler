// Casts as Swift: library and core classes, forced casts and the casts that may throw.
import ts from 'typescript';
import { isFunctionType, isNullish, isOptional, sameClass, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { argumentEntry, argumentOf, elementStoreOf, storeEntry, storeOf } from '../semantics/placement.ts';
import type { Value } from '../semantics/conversion.ts';
import { isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import { inAssignmentPattern, isWriteTarget } from '../semantics/ast.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';

export const castsMethods = {
	/**
	 * Core's own code: an untyped value cast to one of core's classes, where a `try` may stand (`checked`, or the value's
	 * own read throws), is `jsCast`: an instance of another class is JavaScript's TypeError there, as Kotlin's
	 * `jsCastCarried`; null, undefined and an empty marker stay nil. Null for native classes and a shape's stores
	 * (`shapeStore`), which stay conditional casts.
	 */
	libraryClassCast(this: Translator, input: Value, type: string, implicit: boolean, checked: boolean, placed: 'covered' | 'own' | 'operand'): Value | null {
		if (!this.library || this.shapeStore || !(checked || input.throws) || !this.coreClass(type)) return null;
		const call = `${RT.jsCast}(${input.code}, ${type}.self)`;
		const mark = { op: 'cast', to: parseNativeType(type), optional: true, implicit, of: input, spelled: type } as const;
		const cast: Value = placed === 'operand' ? this.marks.valueOf(this.marks.marked(`(try ${call})`, { op: 'try', of: this.marks.valueOf(call) })) : placed === 'own' ? this.marks.tried(call) : this.marks.valueOf(this.marks.marked(call, { ...mark, checked: call }));
		if (placed === 'covered') cast.throws = true;
		if (!implicit) return cast;
		const v = this.marks.valueOf(this.marks.marked(`${RT.jsImplicit}(${cast.code})`, { ...mark, checked: cast.code }));
		v.throws = cast.throws;
		return v;
	},

	/** The checked cast `jsImplicit` holds where `v` is one (`libraryClassCast`), else `v`: what decides how its `try` is placed. */
	checkedCastIn(this: Translator, v: Value): Value {
		return v.mark?.op === 'cast' && v.mark.implicit && v.mark.checked ? this.marks.valueOf(v.mark.checked) : v;
	},

	/** A class core declares, by its Swift name: not generic, and with no native base. */
	coreClass(this: Translator, type: string): boolean {
		const cls = this.classNamed(type.replace(/^NativeScriptKit\./, ''));
		return !!cls?.name && ts.isClassDeclaration(cls) && !cls.typeParameters?.length && !this.native.extendsNative(this.checker.getTypeAtLocation(cls.name));
	},

	/**
	 * `code` cast to `type` where nothing tests it first. Lenient code's read that throws itself (`jsGet(property,
	 * "setNative")`) is inside a `try` already, so its cast throws JavaScript's TypeError there too.
	 */
	forcedCast(this: Translator, given: string | Value, type: string): string {
		const input = this.marks.valued(given),
			code = input.code;
		// Cast already, held optional as lenient code holds it (see `narrowCast`).
		if (this.lenient && this.marks.castTo(code, type, true)) return code;
		// A value that leads with its own `try`, or a dynamic read (under the statement's), is cast where it throws.
		if (this.lenient && input.throws) return this.marks.ownTried(`${RT.jsCastPresent}(${code}) as ${type}`);
		if (this.lenient && input.mark?.op === 'member' && input.mark.dynamic) return `(${RT.jsCastPresent}(${code}) as ${type})`;
		return this.marks.castCode(code, type, 'as!');
	},

	/**
	 * Whether an untyped value (`n`, held as `Any?`) is converted to a type it may not be, where app code
	 * declares one (`const p: Point = JSON.parse(s)`, `b.n = v`, `raw as T`): a TypeError then, as
	 * `fromAny` writes the cast checked. An over-approximation of what the conversion writes is safe,
	 * as is writing an unchecked one where this holds; never the other way round.
	 */
	castThrows(this: Translator, n: ts.Node): boolean {
		if (this.lenient || this.library || !ts.isExpression(n) || ts.isOmittedExpression(n)) return false;
		// Decided once per node: the analysis and the code written agree, and the analysis's passes stay cheap.
		let known = this.castDecisions.get(n);
		if (known === undefined) this.castDecisions.set(n, (known = this.decideCast(n)));
		return known;
	},

	/**
	 * Core's own code: whether the library cell's checked convert may throw at `n`, where the function around it throws
	 * already. The throws analysis is not asked to count these, so no kit signature changes; a conversion where nothing
	 * may throw (a default argument, a stored initializer, a function that doesn't throw, an object literal's closure,
	 * whose `throws` the analysis decides) stays lenient.
	 */
	libraryThrowsHere(this: Translator, n: ts.Node): boolean {
		if (!this.library) return false;
		for (let x: ts.Node = n.parent; x; x = x.parent) {
			if (ts.isParameter(x) || ts.isPropertyDeclaration(x) || ts.isDecorator(x) || ts.isClassLike(x) || ts.isSourceFile(x) || ts.isObjectLiteralExpression(x)) return false;
			if (ts.isFunctionLike(x)) return 'body' in x && !!x.body && this.throwsInfo.fn(x);
		}
		return false;
	},

	decideCast(this: Translator, n: ts.Expression): boolean {
		// A destructuring assignment's write into a `JSNullish<T>` converts what it reads untyped (`nullishWrite`).
		if (ts.isIdentifier(n) && inAssignmentPattern(n)) {
			const d = this.resolve(n)?.valueDeclaration;
			if (d && this.states.nullishHeld(d)) return true;
		}
		// A signal's `JSNullish<T>` read where a `JSNullish<T>` is held: passed on as it is.
		if (ts.isCallExpression(ts.skipOuterExpressions(n, ts.OuterExpressionKinds.Parentheses)) && this.states.nullishPlaced(n) && this.signalNullishRead(n)) return false;
		// Into a `JSNullish<T>`: an untyped value, or a typed entry read untyped to keep its null (`nullableEntry`), is converted checked.
		if (this.states.nullishPlaced(n) && !isNullish(n)) {
			const bare = ts.skipOuterExpressions(n, ts.OuterExpressionKinds.Parentheses);
			if (ts.isElementAccessExpression(bare) || ts.isPropertyAccessExpression(bare) || (ts.isCallExpression(bare) && ts.isPropertyAccessExpression(bare.expression) && bare.expression.name.text === 'get')) return true;
			try {
				if (this.isAny(n)) return true;
			} catch (e) {
				rethrowUnlessRefused(e);
				return false;
			}
		}
		if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && (this.downcasts(n) || this.checkedAssertion(n))) return true;
		const element = elementStoreOf(this.checker, n),
			argument = element ? null : argumentOf(n),
			store = argument ? null : (element ?? storeOf(n));
		const entry = argument ? argumentEntry(this.placement, argument.call, argument.k, n).checked : store ? storeEntry(this.placement, store, n).checked : undefined;
		if ((argument || store ? this.checkedEntry(n, entry) : this.checkedPlacementEntry(n)) || this.narrowedHeld(n)) return true;
		if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && this.checkedClassAssertion(n)) {
			try {
				const to = this.typeOf(n);
				if (this.isAny(n.expression) && !isUntyped(spelledType(to)) && (this.assertedUntyped(n) || /^\w+\?$/.test(to))) return true;
			} catch (e) {
				rethrowUnlessRefused(e);
				return false;
			}
		}
		if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !n.questionDotToken && this.definiteReceiver(ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses))) return true;
		if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !n.questionDotToken && this.lenientAwait(n.expression)) return true;
		if ((ts.isPropertyAccessExpression(n) || (ts.isElementAccessExpression(n) && !isWriteTarget(n))) && !n.questionDotToken && this.widenedParameterRead(ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses))) return true;
		// `obj.field = untyped` on an object of the program or core: written by name, as its setter takes any value.
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && (this.untypedWrite(n.left, n.right) || (ts.isPropertyAccessExpression(n.left) && !this.lenient && !this.library && this.states.nullishMember(n.left, true)))) return true;
		if (ts.isCallExpression(n)) {
			try {
				const erased = this.erasedGeneric(n);
				if (erased && isUntyped(spelledType(erased.declared)) && this.castChecks(erased.actual)) return true;
			} catch (e) {
				rethrowUnlessRefused(e);
				return false;
			}
		}
		if (!(this.checker.getTypeAtLocation(n).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return false;
		let typeOfN: string;
		try {
			typeOfN = this.typeOf(n);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
		if (!isUntyped(spelledType(typeOfN))) return false;
		let outer: ts.Node = n;
		while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
		if (this.states.takesUndefined(outer as ts.Expression)) return false;
		const p = outer.parent;
		let target: string | null = null;
		try {
			if ((ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p)) && p.expression === outer) {
				target = this.typeOf(p);
				if (['String', 'Double', 'Bool'].includes(target)) return false;
			} else {
				const context = this.checker.getContextualType(outer as ts.Expression);
				target = context ? this.type(context, outer) : null;
			}
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
		return !!target && this.castChecks(target);
	},

	/**
	 * A field declared definitely assigned (`item!: Item`, app code), read for a member: Swift holds it
	 * implicitly unwrapped, and until it is assigned the read is JavaScript's TypeError rather than a trap.
	 */
	definiteReceiver(this: Translator, x: ts.Expression): boolean {
		if (this.lenient || this.library || !ts.isPropertyAccessExpression(x) || x.questionDotToken) return false;
		const decl = this.resolve(x.name)?.valueDeclaration;
		if (!decl || !ts.isPropertyDeclaration(decl) || !decl.exclamationToken) return false;
		try {
			const t = this.typeOf(x);
			return !isUntyped(spelledType(t)) && !isOptional(t) && !['String', 'Double', 'Bool'].includes(t) && !isFunctionType(t);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** `x as Sub` of an object of another class: the assertion `castThrows` checks. */
	downcasts(this: Translator, e: ts.AsExpression | ts.TypeAssertion): boolean {
		try {
			const from = this.typeOf(e.expression),
				to = this.typeOf(e);
			if (isUntyped(spelledType(from)) || isUntyped(spelledType(to)) || from.replace(/[?!]$/, '') === to.replace(/[?!]$/, '')) return false;
			const made = this.madeClass(e.expression);
			if (made && sameClass(made, to)) return false;
			return this.isObjectRef(e) && this.isObjectRef(e.expression);
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},
};
