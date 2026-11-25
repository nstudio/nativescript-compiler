// Checked conversions as Kotlin: a value converted, placed or bound where its type is checked at run time.
import ts from 'typescript';
import { isNullable, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { Form } from '../semantics/forms/forms.ts';
import { bindingSlot, type ParamSlot, type StoreSlot } from '../semantics/placement.ts';

export const checkedMethods = {
	/**
	 * The one conversion of a foreign value into the form it enters as: a value of the form's type passes, an
	 * empty state as the slot holds it, any other is JavaScript's TypeError. Null where the form's type has none yet.
	 */
	checkedConvert(this: Translator, code: string, to: Form, at: ts.Node, optional = false): string | null {
		const checked: Record<string, string> = { String: RT.jsCheckedString, Double: RT.jsCheckedNumber, Boolean: RT.jsCheckedBool };
		const t = this.type(to.type, at),
			fn = checked[t];
		if (fn) return `${fn}${optional ? 'OrNull' : ''}(${code})`;
		const element = /^JSArray<(\w+)>$/.exec(t)?.[1];
		if (!element || !checked[element] || !to.element?.foreign || to.element.typeObserved) return null;
		return optional ? `${RT.jsUnlessNullish}(${code}) { __v -> ${RT.jsCheckedArray}(__v) { ${checked[element]}(it) } }` : `${RT.jsCheckedArray}(${code}) { ${checked[element]}(it) }`;
	},

	/** A held read its own type test narrows (`ValueStates.narrowedRead`), read as that type through its checked convert. */
	narrowedHeld(this: Translator, n: ts.Node): Form | null {
		if (this.lenient || this.library || this.rawHeld.has(n)) return null;
		const form = this.states.narrowedRead(n);
		if (!form) return null;
		if (this.checkedConvert('', form, n)) return form;
		const d = this.checker.getNonNullableType(form.type).getSymbol()?.valueDeclaration;
		return d && ts.isClassDeclaration(d) && /^[A-Za-z_][\w.]*$/.test(this.type(form.type, n)) ? form : null;
	},

	/** An untyped value placed where its slot holds its declared type (`foreignPlacement`): converted checked, or null. */
	checkedPlacement(this: Translator, a: ts.Expression, to: string, code?: string, slot?: ParamSlot | StoreSlot): string | null {
		const entry = slot ? (slot.checked ?? null) : this.lenient || this.library ? null : this.states.foreignPlacement(a);
		if (!entry || !this.isAny(a) || this.type(entry.type, a) !== to.replace(/\?$/, '')) return null;
		return this.checkedConvert(code ?? this.expr(a), entry, a, isNullable(to));
	},

	/** A call's untyped result `code`, of the program's type `to`: checked where its slot takes a foreign value (`foreignResult`), else asserted. */
	untypedResult(this: Translator, e: ts.CallExpression, code: string, to: string): string {
		const entry = this.lenient || this.library ? null : this.states.foreignResult(e);
		return (entry && this.type(entry.type, e) === to.replace(/\?$/, '') ? this.checkedConvert(code, entry, e, isNullable(to)) : null) ?? this.fromAnyCode(code, to, true);
	},

	/** An untyped value only Kotlin's code has, stored in a field `slot` (`placeCode`): converted checked, or null. */
	checkedCode(this: Translator, code: string, slot: StoreSlot): string | null {
		const entry = slot.checked!;
		return this.type(entry.type, slot.at) === slot.target.replace(/\?$/, '') ? this.checkedConvert(code, entry, slot.at, isNullable(slot.target)) : null;
	},

	/** A variable a pattern binds or assigns from an untyped value (`bindingSlot`): its value `code` converted checked, or null. */
	checkedBinding(this: Translator, at: ts.BindingElement | ts.Expression, code: string, to: string): string | null {
		const entry = this.lenient || this.library ? null : bindingSlot(this, to, at).checked;
		if (!entry || this.type(entry.type, at) !== to.replace(/\?$/, '')) return null;
		return this.checkedConvert(code, entry, at, isNullable(to));
	},

	/** A number Kotlin holds as `Double?` though declared present (a variable lenient code leaves unset, a field of a shape read
	 *  from JSON): undefined until assigned, so an operation on it reads NaN. */
	heldOptionalNumber(this: Translator, e: ts.Expression): boolean {
		return this.typeOf(e) === 'Double' && this.declaredTypeOf(e) === 'Double?';
	},
};
