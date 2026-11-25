import type { Mark, Value } from './conversion.ts';

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
