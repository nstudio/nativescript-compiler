// The async lowering's state and identical placement/refusal/translator forwarding methods both translators keep alike,
// installed on each prototype as `frontMethods` are. Not traced: they answer nothing.
import ts from 'typescript';
import type { AsyncCtx, AsyncLowering, AsyncSyntax } from './async.ts';
import { thisNodes } from './ast.ts';
import { isConstant } from './lang.ts';
import { argumentSlot, observerSlot, place, resultSlot, storeSlot, type AwaitSlot, type ElementStore, type ParamSlot, type PlacementBackend, type ResultSlot, type Store, type StoreSlot } from './placement.ts';
import { located, type Refusal, type RefusalId } from './refusals.ts';

interface LoweringState {
	asyncCtx: AsyncCtx | null;
	plainBreak: number;
	plainContinue: number;
}

interface PlacementHost {
	readonly placement: PlacementBackend;
	readonly asyncCtx: AsyncCtx | null;
	returnType: string;
	storeSlot(e: ts.Expression, target: string, at: Store, checks?: boolean): StoreSlot;
	elementSlot(at: ElementStore, element: string): (a: ts.Expression) => StoreSlot;
	restSlot(call: ts.CallExpression | ts.NewExpression, element: string, decl?: ts.Declaration): (a: ts.Expression) => ParamSlot;
}

interface SharedTranslatorHost extends PlacementHost {
	readonly checker: ts.TypeChecker;
	readonly library?: unknown;
	readonly awaitSlots: Map<ts.Node, AwaitSlot>;
	readonly nullishCalls: Set<ts.Node>;
	readonly subst: Map<ts.Node, string>;
	readonly untypedThis: Set<ts.Node>;
	readonly patterns: { mixinTarget(d: ts.ClassDeclaration): string | null };
	readonly properties?: { name(sym: ts.Symbol | undefined): string | null } | null;
	readonly framework: { readonly hooks: { wrapRootView?: (t: never, cls: ts.ClassDeclaration, type: string, make: string) => string } };
	readonly optionalDefaults?: Set<ts.ParameterDeclaration>;
	readonly states: { defaultTakesUndefined(p: ts.ParameterDeclaration): boolean };
	indent: string;
	statements(stmts: readonly ts.Statement[]): string[];
	expr(e: ts.Expression): string;
	typeOf(n: ts.Node): string;
	isAny(n: ts.Node): boolean;
	familyDefaultsDiffer(p: ts.ParameterDeclaration): boolean;
	refName(e: ts.Identifier): string;
	resolve(n: ts.Node): ts.Symbol | undefined;
	topNames(): Map<ts.Node, string>;
	undefinedConverted(code: string): string | null;
	coerce(e: ts.Expression, target: string | ResultSlot): string;
	stored(e: ts.Expression, at: Store, target: string, checks?: boolean): string;
}

interface RefusalHost {
	readonly config: {
		readonly refusals: {
			refusal(message: string, id: RefusalId): Refusal;
			refusedAt(file: string, line: number, column: number, what: string, code: string, id: RefusalId): Refusal;
			limitAt(file: string, line: number, column: number, what: string, code: string, id: RefusalId): Refusal;
		};
	};
	error(n: ts.Node | undefined, what: string, id?: RefusalId): Refusal;
}

export const loweringMethods = {
	/** Runs `body` inside a lowered async region: its breaks and continues are the region's, not a native loop's. */
	withAsync<T>(this: LoweringState, ctx: AsyncCtx, body: () => T): T {
		const saved = [this.asyncCtx, this.plainBreak, this.plainContinue] as const;
		this.asyncCtx = ctx;
		this.plainBreak = 0;
		this.plainContinue = 0;
		try {
			return body();
		} finally {
			[this.asyncCtx, this.plainBreak, this.plainContinue] = saved;
		}
	},

	/** Runs `body` inside a lowered loop: no native loop of the enclosing code takes its breaks and continues. */
	withLoweredLoop<T>(this: LoweringState, body: () => T): T {
		const saved = [this.plainBreak, this.plainContinue] as const;
		this.plainBreak = 0;
		this.plainContinue = 0;
		try {
			return body();
		} finally {
			[this.plainBreak, this.plainContinue] = saved;
		}
	},

	/**
	 * Runs `body`, the body of a loop stepping `iterator` (`forOfSteps`): in a lowered function a return there completes
	 * the function from inside the loop, so it closes the iterator first (`AsyncLowering.closingReturns`).
	 */
	withClosingReturns<T>(this: LoweringState & { lowering: AsyncLowering; syntax: AsyncSyntax }, iterator: string, body: () => T): T {
		const saved = this.asyncCtx;
		if (saved) this.asyncCtx = { ...saved, ret: this.lowering.closingReturns(saved, (then) => `${this.syntax.closeIteratorChecked(iterator)}; ${then}`) };
		try {
			return body();
		} finally {
			this.asyncCtx = saved;
		}
	},

	/** An expression placed where the backend needs a value of `target`. */
	coerce(this: PlacementHost, e: ts.Expression, target: string | ResultSlot): string {
		return place(this.placement, e, target);
	},

	/** `e` stored by `at` (a declaration, an object literal's field, an assignment's target) where the backend holds `target`. */
	stored(this: PlacementHost, e: ts.Expression, at: Store, target: string, checks = true): string {
		return place(this.placement, e, this.storeSlot(e, target, at, checks));
	},

	storeSlot(this: PlacementHost, e: ts.Expression, target: string, at: Store, checks = true): StoreSlot {
		return storeSlot(this.placement, target, at, e, checks);
	},

	/** The result slot of the function being translated, where `at` (a `return`, an expression body) gives its value. */
	resultSlot(this: PlacementHost, at: ts.Node): ResultSlot {
		return resultSlot(this.asyncCtx ? this.asyncCtx.result : this.returnType, ts.findAncestor(at.parent, ts.isFunctionLike), !!this.asyncCtx);
	},

	/** An argument of `call` with no declared parameter's cell, as `element`: a built-in's (`Math.max`) or one an untyped callee takes. */
	restArgument(this: PlacementHost, call: ts.CallExpression | ts.NewExpression, a: ts.Expression, element: string): string {
		return place(this.placement, a, this.restSlot(call, element)(a));
	},

	/** The slot of each value `at` stores as a container's element (`elementStoreOf`), held as `element`. */
	elementSlot(this: PlacementHost, at: ElementStore, element: string): (a: ts.Expression) => StoreSlot {
		return (a) => storeSlot(this.placement, element, at, a);
	},

	/** A value `call` stores as an element of its receiver (`push`'s, `add`'s), held as `element`. */
	elementArgument(this: PlacementHost, call: ts.CallExpression, a: ts.Expression, element: string): string {
		return place(this.placement, a, this.elementSlot(call, element)(a));
	},

	/** The slot of each argument `call` gives a rest parameter (`decl`), or an untyped callee: one `element` each, placed with no declared parameter's cell. */
	restSlot(this: PlacementHost, call: ts.CallExpression | ts.NewExpression, element: string, decl?: ts.Declaration): (a: ts.Expression) => ParamSlot {
		return (a) => {
			const k = call.arguments?.indexOf(a) ?? -1;
			return argumentSlot(this.placement, element, decl, { call, k, a: k < 0 ? undefined : a }, { rest: true });
		};
	},

	/** An error the translation of `n` failed with, at `n` unless it says where already (semantics/refusals.ts). */
	located(this: RefusalHost, e: unknown, n: ts.Node): unknown {
		return located(e, n, (at, what, id) => this.error(at, what, id));
	},

	error(this: RefusalHost, n: ts.Node | undefined, what: string, id: RefusalId = 'unhandled'): Refusal {
		if (!n) return this.config.refusals.refusal(`${what} is not supported in a release build yet`, id);
		const sf = n.getSourceFile();
		const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart());
		return this.config.refusals.refusedAt(sf.fileName, line + 1, character + 1, what, n.getText().slice(0, 80), id);
	},

	/** A declared limit of release builds: refused with why and how to write it instead. */
	limit(this: RefusalHost, n: ts.Node, id: RefusalId, what: string): Refusal {
		const sf = n.getSourceFile();
		const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart());
		return this.config.refusals.limitAt(sf.fileName, line + 1, character + 1, what, n.getText().slice(0, 80), id);
	},

	/** Runs `body` indented one level deeper. */
	nested<T>(this: SharedTranslatorHost, body: () => T): T {
		const saved = this.indent;
		this.indent += '    ';
		try {
			return body();
		} finally {
			this.indent = saved;
		}
	},

	/** A statement or block formatted as `{ ... }` indented from `base`. */
	block(this: SharedTranslatorHost, b: ts.Statement, base?: string): string {
		if (base === undefined) base = this.indent;
		const saved = this.indent;
		this.indent = base + '    ';
		try {
			const body = this.statements(ts.isBlock(b) ? [...b.statements] : [b]);
			return `{\n${body.join('\n')}\n${base}}`;
		} finally {
			this.indent = saved;
		}
	},

	/** The slot of the await `e` is, where its continuation holds the value optional. */
	awaited(this: SharedTranslatorHost, e: ts.Expression): AwaitSlot | undefined {
		return this.awaitSlots.get(ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses));
	},

	/** The callee's text for a call expression, else empty. */
	calleeName(this: SharedTranslatorHost, e: ts.Expression): string {
		return ts.isCallExpression(e) ? e.expression.getText() : '';
	},

	/** App/plugin read of a primitive that converted undefined (`(x ?? "undefined")`): the optional it converts, or null. */
	convertedOptional(this: SharedTranslatorHost, e: ts.Expression, t: string): string | null {
		if (this.library) return null;
		const inner = ts.skipOuterExpressions(e);
		const opt = t.endsWith('?') ? t : `${t}?`;
		if (ts.isConditionalExpression(inner) && this.typeOf(inner) === t && [inner.whenTrue, inner.whenFalse].some((x) => this.undefinedConverted(this.coerce(ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses), t)))) return this.coerce(inner, opt);
		return this.undefinedConverted(this.expr(ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses)));
	},

	/** An `optionalVariable`'s initializer stored as the optional `type`: a read converting undefined gives that undefined. */
	heldStore(this: SharedTranslatorHost, d: ts.VariableDeclaration, type: string): string {
		const code = this.stored(d.initializer!, d, type);
		return this.undefinedConverted(code) ?? code;
	},

	/** The kit class a mixin class (`applyMixins(View, [Extended])`) is applied to. */
	mixinOf(this: SharedTranslatorHost, sym: ts.Symbol | undefined): string | null {
		const d = sym?.valueDeclaration;
		return d && ts.isClassDeclaration(d) ? this.patterns.mixinTarget(d) : null;
	},

	/** A `nullishRead` value as its `JSNullish<T>`. */
	nullishCode(this: SharedTranslatorHost, e: ts.Expression): string {
		if (!ts.isCallExpression(e) && !ts.isPropertyAccessExpression(e)) return this.refName(e as ts.Identifier);
		this.nullishCalls.add(e);
		try {
			return this.expr(e);
		} finally {
			this.nullishCalls.delete(e);
		}
	},

	/** `x` read by an equality or `typeof` (`ObserverSlot`). */
	observe(this: PlacementHost, x: ts.Expression, read: 'untyped' | 'asIs' = 'untyped'): string {
		return place(this.placement, x, observerSlot(this.placement, read));
	},

	/** A component created as a root view (bootstrap, route, dialog): made and rendered as the framework makes it. */
	rootView(this: SharedTranslatorHost, cls: ts.ClassDeclaration, type: string, make: string): string {
		return this.framework.hooks.wrapRootView ? this.framework.hooks.wrapRootView(this as never, cls, type, make) : make;
	},

	/** `fooProperty.setNative`: the registered name of the property it belongs to. */
	setNativeOf(this: SharedTranslatorHost, e: ts.Expression): string | null {
		if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'setNative') return null;
		return this.properties?.name(this.resolve(e.expression)) ?? null;
	},

	/** The declared or aliased symbol name of `e`'s type, or empty. */
	symbolName(this: SharedTranslatorHost, e: ts.Expression): string {
		const t = this.checker.getTypeAtLocation(e);
		return (t.aliasSymbol ?? t.getSymbol())?.getName() ?? '';
	},

	/** A module-level function, class, or variable's emitted top-level name. */
	topName(this: SharedTranslatorHost, decl: ts.Node, name: string): string {
		return this.topNames().get(decl) ?? name;
	},

	/** Whether a parameter's initializer can be emitted as a native constant default rather than applied in the body. */
	constantDefault(this: SharedTranslatorHost, p: ts.ParameterDeclaration): boolean {
		return !!p.initializer && isConstant(p.initializer) && !(this.optionalDefaults && (this.optionalDefaults.has(p) || this.isAny(p.name))) && !this.familyDefaultsDiffer(p) && !this.states.defaultTakesUndefined(p);
	},

	/** Runs `body` with `this` in `fn` (and in the arrow functions inside it) read as `name`. */
	withThis<T>(this: SharedTranslatorHost, fn: ts.Node, name: string, untyped: boolean, body: () => T): T {
		const nodes = thisNodes(fn);
		for (const n of nodes) {
			this.subst.set(n, name);
			if (untyped) this.untypedThis.add(n);
		}
		try {
			return body();
		} finally {
			for (const n of nodes) {
				this.subst.delete(n);
				this.untypedThis.delete(n);
			}
		}
	},

	/** Refuses a self-referencing named generator expression (`function* f() { yield f; }`). */
	refuseNamedGenerator(this: RefusalHost, fn: ts.FunctionLikeDeclaration): void {
		if (fn.asteriskToken) throw this.error(fn, 'a named function expression', 'named-function-expression');
	},
};

export type LoweringMethods = typeof loweringMethods;
