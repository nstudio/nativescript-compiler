// The async lowering's state and identical placement/refusal forwarding methods both translators keep alike, installed on
// each prototype as `frontMethods` are. Not traced: they answer nothing.
import ts from 'typescript';
import type { AsyncCtx, AsyncLowering, AsyncSyntax } from './async.ts';
import { argumentSlot, place, resultSlot, storeSlot, type ElementStore, type ParamSlot, type PlacementBackend, type ResultSlot, type Store, type StoreSlot } from './placement.ts';
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
};

export type LoweringMethods = typeof loweringMethods;
