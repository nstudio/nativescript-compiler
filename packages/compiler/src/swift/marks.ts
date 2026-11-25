import { type Mark, type Value } from '../semantics/conversion.ts';
import { heldLoss } from '../semantics/losses.ts';
import { CodeMarks } from '../semantics/marks.ts';
import { parseNativeType } from '../semantics/types.ts';
import { SWIFT_RUNTIME as RT } from '../semantics/runtime.ts';

/**
 * The Swift translation's marks: also which code leads with its own `try`, so a `try` before code that holds it is
 * written once. The producers and the questions about recorded code that only Swift has are its methods.
 */
export class SwiftMarks extends CodeMarks {
	/** Code that leads with its own `try`, to that code without it (`(try x)` to `(x)`). */
	private readonly untriedCodes = new Map<string, string>();

	/** `pure`: code known pure before anything is translated. */
	constructor(pure: Iterable<string> = []) {
		super();
		this.marked(this.pureCode('nil'), { op: 'empty', null: false });
		this.marked(this.pureCode('jsNull'), { op: 'empty', null: true });
		for (const code of pure) this.pureCode(code);
	}

	/** Code, recorded with its outermost operation. */
	override marked(code: string, mark: Mark): string {
		if (mark.op === 'try') this.untriedCodes.set(code, code === `try ${mark.of.code}` ? mark.of.code : `(${mark.of.code})`);
		return super.marked(code, mark);
	}

	/** `(try code)`: code that throws where it stands, an operand of its own. */
	ownTried(code: string): string {
		const own = `(try ${code})`;
		this.untriedCodes.set(own, `(${code})`);
		return own;
	}

	/** `try code` where `yes`, else code. */
	tryIf(yes: boolean | undefined, code: string): string {
		if (!yes) return code;
		const own = `try ${code}`;
		this.untriedCodes.set(own, code);
		return own;
	}

	/** Code that begins with `operand`, after any `(`s (`(x as? T)`, `x!`, `x.name`): it leads with a `try` where the operand does. */
	leading(code: string, operand: string): string {
		const inner = this.untriedCodes.get(operand);
		const at = code.indexOf(operand);
		if (inner !== undefined && at >= 0 && /^\(*$/.test(code.slice(0, at))) {
			this.untriedCodes.set(code, code.slice(0, at) + inner + code.slice(at + operand.length));
		}
		return code;
	}

	leadsWithTry(code: string): boolean {
		return this.untriedCodes.has(code);
	}

	/** `try code`, a `try` code leads with folded into this one (`try (x).y`, not `try (try x).y`). */
	tried(code: string): Value {
		const inner = this.untriedCodes.get(code) ?? code;
		const v: Value = { code: `try ${inner}`, throws: true, pure: false, mark: { op: 'try', of: this.valueOf(inner) } };
		this.made.set(v.code, v);
		this.untriedCodes.set(v.code, inner);
		return v;
	}

	/** A statement's `try` (`t`: `try ` or none) before code, one `try` where code leads with its own. */
	tryBefore(t: string, code: string): string {
		return t ? `try ${this.untriedCodes.get(code) ?? code}` : code;
	}

	/** `try` before a statement that needs one: on an assignment's value where evaluating its target cannot throw (`x = try f()`); none before a block placing its own. */
	triedStatement(t: string, code: string): string {
		const m = this.markOf(code);
		if (m?.op === 'block') return code;
		if (!t || m?.op !== 'assign' || m.targetThrows) return this.tryBefore(t, code);
		return m.value.mark?.op === 'try' ? code : `${m.target} = ${this.tryBefore(t, m.value.code)}`;
	}

	/** Code given as text: what its producer recorded of it, a `try` it leads with included. */
	valued(code: string | Value): Value {
		return typeof code === 'string' ? { ...this.valueOf(code), throws: this.leadsWithTry(code) } : code;
	}

	/** `(code)`. */
	parens(code: string): string {
		return this.leading(`(${code})`, code);
	}

	/** `left op right`. */
	infix(left: string, op: string, right: string): string {
		return this.leading(`${left} ${op} ${right}`, left);
	}

	/** `target = value`, a statement. */
	assignedCode(target: string, value: string, targetThrows = false): string {
		return this.leading(this.marked(`${target} = ${value}`, { op: 'assign', target, value: this.valueOf(value), targetThrows }), target);
	}

	/** A statement that is its own block (`if c { … }`, `do { … }`), placing inside it the `try`s it needs. */
	blockCode(code: string): string {
		return this.marked(code, { op: 'block' });
	}

	/** `try code`, as code. */
	tryCode(code: string): string {
		return this.tried(code).code;
	}

	/** `(code as? T)`, `(code as! T)`, `(code as T?)`, or lenient code's `jsImplicit(code as? T)`. */
	castCode(code: string, type: string, how: 'as?' | 'as!' | 'as', implicit = false): string {
		const text = how === 'as' ? `${code} as ${type}?` : `${code} ${how} ${type}`;
		const made = this.marked(implicit ? `${RT.jsImplicit}(${text})` : `(${text})`, { op: 'cast', to: parseNativeType(type), optional: how !== 'as!', implicit, of: this.valueOf(code), spelled: type, up: how === 'as' });
		return implicit ? made : this.leading(made, code);
	}

	/** `jsImplicit(code)`, or a function cell's `implicit` (`cell`), or another of its statics that may give nil (`via`). */
	implicitOf(code: string, cell?: string, via = 'implicit'): string {
		return this.marked(cell ? `${cell}.${via}(${code})` : `${RT.jsImplicit}(${code})`, { op: 'implicit', of: this.valueOf(code), ...(cell ? { cell } : {}), ...(via !== 'implicit' ? { via } : {}) });
	}

	/** `code!`. */
	unwrappedCode(code: string): string {
		heldLoss('unwrappedCode', '!');
		return this.leading(this.marked(`${code}!`, { op: 'unwrap', of: this.valueOf(code) }), code);
	}

	/** `code!` where `yes`, else code. */
	unwrappedIf(code: string, yes: boolean): string {
		return yes ? this.unwrappedCode(code) : code;
	}

	/** The kit's helper of one value (`jsObjectRequired(code)`), its rest of arguments as written (`rest`: `, "key"`). */
	helper(name: 'jsForeign' | 'jsArrayOrNil' | 'jsObjectRequired' | 'jsUnwrap', code: string, rest = ''): string {
		return this.marked(`${RT[name]}(${code}${rest})`, { op: 'helper', name, of: this.valueOf(code), rest });
	}

	/** A member read (`dot`: `.` or `?.`). */
	memberOf(receiver: string, dot: string, name: string): string {
		return this.leading(this.marked(`${receiver}${dot}${name}`, { op: 'member', of: this.valueOf(receiver), name, ...(dot === '?.' ? { optional: true } : {}) }), receiver);
	}

	/** `(code ?? nil)`: an optional read where undefined goes, its nil the missing value. */
	orNil(code: string): string {
		return this.leading(this.marked(`(${code} ?? nil)`, { op: 'undefinedAs', to: parseNativeType('Any?'), of: this.valueOf(code) }), code);
	}

	/** An array's element read, nil past its end (`xs.element(i)`; `via`: what comes between, `?.values`). */
	elementOf(receiver: string, index: string | number, via = ''): string {
		return this.leading(this.marked(`${receiver}${via}.element(${index})`, { op: 'entry', of: this.valueOf(receiver), key: this.valueOf(String(index)), element: true }), receiver);
	}

	isUnwrap(code: string): boolean {
		return this.markOf(code)?.op === 'unwrap';
	}

	/** The value `code!` unwraps, where code is one. */
	unwrapInner(code: string): string | null {
		const m = this.markOf(code);
		return m?.op === 'unwrap' ? m.of.code : null;
	}

	/** The object `try jsObjectRequired(x)` checks: `??` checks its whole instead, since `try` can't follow an operator. */
	requiredOf(code: string): string | null {
		const m = this.markOf(code),
			h = m?.op === 'try' ? m.of.mark : undefined;
		return h?.op === 'helper' && h.name === 'jsObjectRequired' ? h.of.code : null;
	}

	/**
	 * Whether code is already a cast to `type` (`jsImplicit(x as? T)`, `(x as! T)`): converting it again is the same value.
	 * The cast must be the code's last, enclosing operation.
	 */
	alreadyAs(code: string, type: string): boolean {
		return this.castTo(code, type);
	}

	/** The value lenient code holds implicitly (`jsImplicit(x)`, `FunctionCell_X.implicit(x)`): its code, else null. */
	implicitInner(code: string): string | null {
		const c = this.markOf(code);
		if (c?.op === 'implicit' && !c.via) return c.of.code;
		return c?.op === 'cast' && c.implicit ? (c.checked ?? `${c.of.code} ${c.up ? 'as' : c.optional ? 'as?' : 'as!'} ${c.spelled}${c.up ? '?' : ''}`) : null;
	}

	/** An array's element read where undefined goes, boxed (`((xs.element(i) ?? nil) as Any?)`): the element read, else undefined. */
	boxedElement(code: string): string | undefined {
		const c = this.markOf(code),
			u = c?.op === 'cast' && c.up && c.spelled === 'Any' ? c.of.mark : undefined;
		const read = u?.op === 'undefinedAs' && u.to.optional ? u.of : undefined;
		return read?.mark?.op === 'entry' && read.mark.element ? read.code : undefined;
	}

	/** A map's value read (`m.get(k)`), its `try` aside. */
	mapEntry(code: string): boolean {
		const c = this.markOf(code),
			read = c?.op === 'try' ? c.of.mark : c;
		return read?.op === 'entry' && !read.element;
	}

	/** A lenient or library read of a string, number or boolean member (`jsLenientNumber(try jsGet(o, "k"))`): the member read, else null. */
	lenientGet(code: string): Value | null {
		const m = this.markOf(code),
			c = m?.op === 'try' && m.of.mark?.op === 'converted' ? m.of.mark : m;
		const read = c?.op === 'lenient' || c?.op === 'converted' ? c.of : undefined;
		const get = read?.mark?.op === 'try' ? read.mark.of : read;
		return get?.mark?.op === 'member' && get.mark.dynamic ? read! : null;
	}

	/** The code a leading `try` covers, where code is `try x`; else null. */
	afterTry(code: string): string | null {
		const c = this.markOf(code);
		return c?.op === 'try' ? c.of.code : null;
	}

	/** A chain of member reads from a value lenient code holds implicitly (`jsImplicit(x)?.a.b`). */
	rootImplicit(code: string): boolean {
		const c = this.markOf(code);
		return this.heldImplicitly(code) || (c?.op === 'implicit' && !!c.chained) || (c?.op === 'member' && this.rootImplicit(c.of.code));
	}

	/** An optional chain's last member read (`x?.name`, `x?.name.length`), with no `??` along its receivers. */
	chainEnd(code: string): boolean {
		const c = this.markOf(code);
		if (c?.op !== 'member') return false;
		const own = !!c.optional || (c.of.mark?.op === 'implicit' && !!c.of.mark.chained);
		return (own || (c.name === 'length' && this.chainEnd(c.of.code))) && !coalesces(c.of);
	}

	/** Lenient code's value held implicitly, cast or not (`jsImplicit(x)`, `jsImplicit(x as? T)`). */
	private heldImplicitly(code: string): boolean {
		const c = this.markOf(code);
		return (c?.op === 'implicit' && !c.cell && !c.chained) || (c?.op === 'cast' && c.implicit);
	}

	/** Whether code's outermost operation is a conditional or forced cast to `type`; `implicit`: lenient code's `jsImplicit(x as? T)`. */
	castTo(code: string, type: string, implicit?: boolean): boolean {
		const want = type.replace(/[?!]$/, '').replace(/^NativeScriptKit\./, '');
		const c = this.markOf(code);
		return c?.op === 'cast' && !c.up && !c.unchecked && (implicit === undefined || c.implicit === implicit) && c.spelled !== undefined && /^[\w.<>?, ]+$/.test(c.spelled) && c.spelled.replace(/^NativeScriptKit\./, '') === want;
	}

	/** Code whose outermost operation is a forced cast to a non-optional type (`(x as! T)`). */
	presentCast(code: string): boolean {
		const c = this.markOf(code);
		return c?.op === 'cast' && !c.optional && !c.implicit && !!c.spelled && !/[?!]$/.test(c.spelled);
	}
}

const coalesces = (v: Value): boolean => v.mark?.op === 'undefinedAs' || (v.mark?.op === 'member' && coalesces(v.mark.of));
