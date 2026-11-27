import type { Mark, Value } from './conversion.ts';

/**
 * Structured emitted expression carrying code alongside its semantic metadata (purity, throwing, outermost mark),
 * replacing ad-hoc string-keyed lookups over raw emitted source text as producers migrate.
 */
export interface EmittedExpr {
	readonly code: string;
	readonly throws: boolean;
	readonly pure: boolean;
	readonly mark?: Mark;
}

/** Constructs a structured `EmittedExpr`. */
export function emitted(code: string, opts?: { throws?: boolean; pure?: boolean; mark?: Mark }): EmittedExpr {
	return { code, throws: opts?.throws ?? false, pure: opts?.pure ?? false, ...(opts?.mark ? { mark: opts.mark } : {}) };
}

/** Constructs a pure `EmittedExpr` (evaluating twice equals evaluating once). */
export function pureExpr(code: string, mark?: Mark): EmittedExpr {
	return mark ? { code, throws: false, pure: true, mark } : { code, throws: false, pure: true };
}

/** Constructs a marked `EmittedExpr`. */
export function markedExpr(code: string, mark: Mark, opts?: { throws?: boolean; pure?: boolean }): EmittedExpr {
	return { code, throws: opts?.throws ?? false, pure: opts?.pure ?? false, mark };
}

/** Extracts raw code text from either a string or an `EmittedExpr`. */
export function exprText(expr: string | EmittedExpr): string {
	return typeof expr === 'string' ? expr : expr.code;
}

/**
 * What one translation's producers recorded of the code they emitted (its outermost operation, and whether reading it twice
 * is reading it once), kept by the code: a string carries no fields, and readers get code from `expr`, the conversions and
 * built strings alike. Producers that emit one string share its entry, so an entry must describe the text's outermost
 * operation, never where the text came from. Each translator owns one (`marks`), so nothing one translation records
 * reaches another.
 */
export class CodeMarks {
	protected readonly made = new Map<string, Value>();
	private readonly pureCodes = new Set<string>();

	/** Registers a structured `EmittedExpr` and returns its code string for incremental callers. */
	emit(expr: EmittedExpr): string {
		if (expr.pure) this.pureCodes.add(expr.code);
		if (expr.mark || expr.throws) this.made.set(expr.code, { code: expr.code, throws: expr.throws, pure: expr.pure || this.pureCodes.has(expr.code), ...(expr.mark ? { mark: expr.mark } : {}) });
		return expr.code;
	}

	/** Reads a structured `EmittedExpr` view of previously emitted code. */
	read(code: string | EmittedExpr): EmittedExpr {
		if (typeof code !== 'string') return code;
		return this.valueOf(code);
	}

	/** Code, recorded with its outermost operation. */
	marked(code: string, mark: Mark): string {
		this.made.set(code, { code, throws: false, pure: this.pureCodes.has(code), mark });
		return code;
	}

	valueOf(code: string): Value {
		return this.made.get(code) ?? { code, throws: false, pure: this.pureCodes.has(code) };
	}

	markOf(code: string): Mark | undefined {
		return this.made.get(code)?.mark;
	}

	/** Code that gives the same value however often it is read: a name, a path of names, a literal, a translator temporary. */
	pureCode(code: string): string {
		this.pureCodes.add(code);
		const v = this.made.get(code);
		if (v) v.pure = true;
		return code;
	}

	/** Whether reading code twice is reading it once (else it is bound first). */
	isPure(code: string): boolean {
		return this.pureCodes.has(code);
	}

	/** A name, or a chain of member reads from one (`Module_x.items`, `this.page`): evaluating it twice is evaluating it once. */
	isPath(code: string): boolean {
		const c = this.markOf(code);
		return this.isPure(code) || (c?.op === 'member' && !c.optional && !c.dynamic && this.isPath(c.of.code));
	}
}
