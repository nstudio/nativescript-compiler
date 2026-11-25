// The async lowering's state both translators keep alike (`AsyncTranslator.withAsync`, `withLoweredLoop`), installed on
// each prototype as `frontMethods` are. Not traced: they answer nothing.
import type { AsyncCtx, AsyncLowering, AsyncSyntax } from './async.ts';

interface LoweringState {
	asyncCtx: AsyncCtx | null;
	plainBreak: number;
	plainContinue: number;
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
};

export type LoweringMethods = typeof loweringMethods;
