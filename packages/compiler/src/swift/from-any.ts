// Values read from Any as Swift: stored, converted, checked and unchecked.
import type ts from 'typescript';
import { CF_CLASSES, functionParts, hasTopLevelArrow, isOptional, metatype, rightOperand, splitTopLevel, swiftString, typedElement, RT, lenientReader, convertedReader } from './syntax.ts';
import type { Translator } from './translator.ts';
import { codeStoreSlot, placeCode, resultSlot, type ResultSlot } from '../semantics/placement.ts';
import { structural, type Value } from '../semantics/conversion.ts';
import { isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import { observers } from '../semantics/observers.ts';

export const fromAnyMethods = {
	/**
	 * `lhs = newValue` in a dynamic setter (`obj[key] = v`, a binding's write): a value the field's type cannot
	 * hold is refused, and `jsSet` throws the TypeError, where a cast would trap.
	 */
	storeFromAny(this: Translator, lhs: string, type: string, key: string, symbol = false, at?: ts.PropertyDeclaration): string {
		const checked = placeCode(this.placement, 'newValue', codeStoreSlot(this.placement, type, at));
		if (checked) return `${RT.jsStoring} { ${lhs} = ${checked} }`;
		// A symbol-keyed field is held as `deferred` declares it: an array or a string present, its zero for undefined.
		const saved = this.shapeStore;
		this.shapeStore = this.inShape;
		let value: Value;
		try {
			value = symbol && this.lenient && this.zero(type) !== null && !isOptional(type) ? this.fromAnyOrZeroValue('newValue', type) : this.fromAnyChecked('newValue', this.lenient ? this.lenientRef(type) : type, !!this.library);
		} finally {
			this.shapeStore = saved;
		}
		const code = value.code,
			cast = this.checkedCastIn(value);
		// A conversion that can throw (an array holding undefined where its elements are objects): `jsSet` throws it.
		if (cast.mark?.op === 'try') return `${RT.jsStoring} { ${lhs} = ${code} }`;
		if (cast.throws) return `${RT.jsStoring} { try ${lhs} = ${code} }`;
		const forced = value.mark?.op === 'cast' && value.mark.of.code === 'newValue' && !value.mark.optional && !value.mark.implicit;
		if (!forced || CF_CLASSES.has(type)) return `${lhs} = ${code}`;
		return `if let __v = ${RT.jsConverted}(newValue, to: ${metatype(type)}) { ${lhs} = __v } else { ${RT.jsRefuseSet}(newValue, ${swiftString(key)}, ${swiftString(type)}) }`;
	},

	/** An untyped value read as `type`; with `orZero`, a missing value is the type's zero rather than a trap. */
	fromAnyCode(this: Translator, code: string | Value, type: string, orZero = false, checked = false): string {
		return this.fromAnyCodeValue(code, type, orZero, checked).code;
	},

	fromAnyCodeValue(this: Translator, input: string | Value, type: string, orZero = false, checked = false): Value {
		const code = this.marks.valued(input).code;
		const zero = this.zero(type);
		// An array of another element type (`[CssProperty, unknown][]` read as `[any, any][]`) is no Swift cast: its elements are read, undefined giving none.
		if (orZero && /^JSArray<.*>$/.test(type)) return this.fromAnyValue(input, type);
		// An untyped string, number or boolean is converted as JavaScript converts it where it is used, never refused.
		if (orZero && ['String', 'Double', 'Bool'].includes(type)) return this.fromAnyValue(input, type);
		if (orZero && zero && zero !== 'nil' && !type.endsWith('?')) return this.marks.valued(this.marks.leading(`((${code} as? ${type}) ?? ${zero})`, code));
		// Lenient code converts a string, number or boolean as JavaScript would; a cast to any other type still throws where it fails.
		const saved = this.throwingCast;
		this.throwingCast = checked && this.lenient;
		try {
			return this.fromAnyChecked(input, type, checked && !this.lenient);
		} finally {
			this.throwingCast = saved;
		}
	},

	/** An untyped value read where Swift holds `type` present, undefined as its zero: lenient code's array too, which it otherwise reads as undefined. */
	fromAnyOrZero(this: Translator, code: string, type: string): string {
		return this.fromAnyOrZeroValue(code, type).code;
	},

	fromAnyOrZeroValue(this: Translator, code: string, type: string): Value {
		const array = /^JSArray<(.*)>$/.exec(type);
		if (!array || !this.lenient) return this.fromAnyCodeValue(code, type, true);
		observers.keep?.('swift', 'untyped-read', 'Any?', type, this.currentFile, !!this.library);
		const el = this.arrayElementFromAny(array[1]);
		const made = `${RT.jsArrayFrom}(${code}${typedElement('JSArray', array[1])}, { ${el.code} })`;
		return el.mark?.op === 'try' ? this.marks.tried(made) : this.marks.valued(made);
	},

	/** `f`'s conversion of `e`'s value (its code `code`, written first): checked where `libraryThrowsHere`. */
	readConverts(this: Translator, e: ts.Node, f: (code: string) => string, code: string): string {
		return this.throwingConverts(() => f(code), this.libraryThrowsHere(e), e);
	},

	/**
	 * `f`'s conversions, written where they may throw (inside a throwing closure, or `libraryThrowsHere`): core's library
	 * cell checked. `at`: the value converted, whose statement's `try` covers the conversion where it throws itself.
	 */
	throwingConverts<T>(this: Translator, f: () => T, here = true, at?: ts.Node): T {
		if (!this.library || !here) return f();
		const saved = this.libraryChecked;
		this.libraryChecked = !at ? 'operand' : this.throwsInfo.expr(at) ? 'covered' : rightOperand(at) ? 'operand' : 'own';
		try {
			return f();
		} finally {
			this.libraryChecked = saved;
		}
	},

	/** `fromAny` with the outermost cast checked, for a node `castThrows` approved. */
	fromAnyChecked(this: Translator, code: string | Value, type: string, checked: boolean): Value {
		const saved = this.checkedCast;
		this.checkedCast = checked;
		try {
			return this.fromAnyValue(code, type);
		} finally {
			this.checkedCast = saved;
		}
	},

	/**
	 * `v` given back in `slot`. Where the slot's context cannot throw (a synthesized getter or initializer), a conversion
	 * that may (an array holding undefined where its elements are objects) is reported, the slot given undefined.
	 */
	reportedRead(this: Translator, v: Value, slot: ResultSlot): string {
		if (slot.throws !== false) return v.code;
		const c = this.checkedCastIn(v);
		return c.mark?.op === 'try' ? this.marks.orNil(`${RT.jsReported} { ${v.code} }`) : c.throws && (c.mark?.op === 'converted' || (c.mark?.op === 'cast' && c.mark.checked)) ? this.marks.orNil(`${RT.jsReported} { try ${v.code} }`) : v.code;
	},

	/** The result slot of a synthesized getter or initializer giving back `type`, which cannot throw. */
	getterSlot(this: Translator, type: string): ResultSlot {
		return { ...resultSlot(type), throws: false };
	},

	/**
	 * `code`, an array of type `from`, where `to`, an array of any value, is wanted: the one array (the front's `untyped`
	 * step), as the kit's untyped view of it; `optional`: `code` may be none, which stays none. Null for other types.
	 */
	untypedArray(this: Translator, code: string, from: string, to: string, optional = false): string | null {
		const bare = (t: string) => t.replace(/[?!]$/, '');
		if (structural(parseNativeType(bare(from)), parseNativeType(bare(to)), this.structuralFacts())?.step !== 'untyped') return null;
		return optional ? `(${code}).map { ${RT.jsUntypedArray}($0) }` : `${RT.jsUntypedArray}(${code})`;
	},

	/**
	 * `code`, an array of type `from`, where `to`, an array whose element type sees the same values, is wanted: the one
	 * array (the front's `view` step), as the kit's view of it; `optional`: `code` may be none, which stays none. Null
	 * for other types, and where `to`'s element is an interface (a protocol existential, which no view holds: ledger
	 * `genericsReified`).
	 */
	arrayView(this: Translator, code: string, from: string, to: string, optional = false): string | null {
		const bare = (t: string) => t.replace(/[?!]$/, '');
		if (structural(parseNativeType(bare(from)), parseNativeType(bare(to)), this.structuralFacts())?.step !== 'view') return null;
		const element = /^JSArray<(.+)>$/.exec(bare(to))?.[1];
		if (!element || this.protocols.has(element)) return null;
		return optional ? `(${code}).map { ${RT.jsArrayView}($0, as: ${element}.self) }` : `${RT.jsArrayView}(${code}, as: ${element}.self)`;
	},

	/** `code`, a value of `from` that may be none, held as `to`: the one array where the front steps it (`arrayView`, `untypedArray`), else as it is. */
	optionalArrayAs(this: Translator, code: string, from: string, to: string): string {
		return this.arrayView(code, from, to, true) ?? this.untypedArray(code, from, to, true) ?? code;
	},

	/** An untyped array as an array of `element`, each converted: a new array unless it already is one of them. */
	arrayOf(this: Translator, code: string, element: string): string {
		observers.keep?.('swift', 'untyped-read', 'Any?', `JSArray<${element}>`, this.currentFile, !!this.library);
		const el = this.arrayElementFromAny(element);
		return this.marks.tryIf(el.mark?.op === 'try', `${RT.jsArrayFrom}(${code}) { ${el.code} }`);
	},

	/** An untyped array's element read as `type` (`$0`): lenient code's object elements are checked present, as Swift's array holds no undefined. */
	arrayElementFromAny(this: Translator, type: string): Value {
		return this.presentFromAnyValue('$0', type);
	},

	/** Swift code reading an untyped value (`Any?`) as `type`. */
	fromAny(this: Translator, code: string | Value, type: string): string {
		return this.fromAnyValue(code, type).code;
	},

	fromAnyValue(this: Translator, code: string | Value, type: string): Value {
		type = type.replace(/^@escaping /, '');
		const checked = this.checkedCast,
			throwing = this.throwingCast,
			inThrowing = this.libraryChecked;
		this.checkedCast = this.throwingCast = this.libraryChecked = false;
		try {
			const made = this.fromAnyUnchecked(this.marks.valued(code), type, checked || !!inThrowing, throwing, inThrowing || 'operand');
			return typeof made === 'string' ? this.marks.valued(made) : made;
		} finally {
			this.checkedCast = checked;
			this.throwingCast = throwing;
			this.libraryChecked = inThrowing;
		}
	},

	/** `fromAny` where Swift needs the value present (a function's argument or result, an array's element): lenient code's missing object throws. */
	presentFromAny(this: Translator, code: string | Value, type: string, orZero = false, checked = false): string {
		return this.presentFromAnyValue(code, type, orZero, checked).code;
	},

	presentFromAnyValue(this: Translator, code: string | Value, type: string, orZero = false, checked = false): Value {
		const read = this.fromAnyCodeValue(code, type, orZero, checked);
		if (!this.lenient || (this.nullableRef(type) === type && !type.startsWith('['))) return read;
		const present = this.presentValue(read, type);
		return present.code === read.code ? read : this.marks.tried(present.code);
	},

	fromAnyUnchecked(this: Translator, input: Value, type: string, checked: boolean, throwing = false, placed: 'covered' | 'own' | 'operand' = 'operand'): string | Value {
		const code = input.code;
		if (isUntyped(spelledType(type))) return input;
		const unbox = this.unboxStep(type);
		// Core's own code reads a class unchecked still: `checked` is the library cell's for strings, numbers and booleans there.
		const appChecked = checked && !this.library;
		// `void` (an array of results nothing reads): any value read is none.
		if (type === 'Void' || type === '()') return `(_ = ${code})`;
		// An Error held untyped (a caught or rejected value): the error, or a view of what was thrown instead.
		if (type === 'JSError' && !this.lenient) return `${RT.jsErrorOf}(${code})`;
		// `globalThis as unknown as Worker`: wraps a worker realm's global object as a JSWorker.
		if (type === 'JSWorker') return this.marks.ownTried(`JSWorker.fromAny(${code})`);
		if (type === 'JSWorker?' || type === 'JSWorker!') return `JSWorker.fromAnyOrNil(${code})`;
		// An implicitly unwrapped class (`tabView: TabView!`): the value as it, missing where it is none.
		if (/^[A-Z][\w.]*!$/.test(type) && !this.native.isStructType(type.slice(0, -1)) && !['Double', 'String', 'Bool'].includes(type.slice(0, -1))) return this.libraryClassCast(input, type.slice(0, -1), false, checked || throwing, placed) ?? this.marks.castCode(code, type.slice(0, -1), 'as?');
		if (input.mark?.op === 'empty') {
			// Null where code checked without strictNullChecks declares a string, number or boolean: the type's zero, falsy as null is.
			if (type === 'String') return '""';
			if (type === 'Double') return '0';
			if (type === 'Bool') return 'false';
			return 'nil';
		}
		const m = unbox.composite === 'array' ? /^JSArray<(.*)>$/.exec(type) : null;
		// Lenient code: undefined where an array is declared stays undefined (`let result: string[] = cache[key]; if (result) …`).
		if (m) {
			observers.keep?.('swift', 'untyped-read', 'Any?', type, this.currentFile, !!this.library);
			const el = this.arrayElementFromAny(m[1]);
			const made = this.lenient ? this.marks.helper('jsArrayOrNil', code, `${typedElement('JSArray', m[1])}, { ${el.code} }`) : `${RT.jsArrayFrom}(${code}${typedElement('JSArray', m[1])}, { ${el.code} })`;
			return el.mark?.op === 'try' ? this.marks.tried(made) : made;
		}
		// A promise held untyped (core's `animate()` gives its AnimationPromise as `any`): itself, or one adopting it.
		const pm = unbox.composite === 'promise' ? /^JSPromise<(.*)>$/.exec(type) : null;
		if (pm) return `${RT.jsPromiseOf}(${code}) { ${pm[1] === 'Void' ? '_ in ()' : this.presentFromAny('$0', pm[1])} }`;
		if (type === 'JSDate') return `${RT.jsDateOf}(${code})`;
		if (type === 'JSDate?') return `${RT.jsDateOrNil}(${code})`;
		const om = unbox.composite === 'array' ? /^JSArray<(.*)>\?$/.exec(type) : null;
		if (om) {
			const el = this.arrayElementFromAny(om[1]);
			const made = this.marks.helper('jsArrayOrNil', code, `${typedElement('JSArray', om[1])}, { ${el.code} }`);
			return el.mark?.op === 'try' ? this.marks.tried(made) : made;
		}
		const r = unbox.composite === 'record' ? /^JSRecord<(.*)>\??$/.exec(type) : null;
		// A record's values are read as its type says where they have it (a gesture's extraData holds arrays beside its numbers).
		if (r) {
			const el = this.presentFromAnyValue('$0', r[1], true);
			const made = type.endsWith('?') ? `${RT.jsRecordOrNil}(${code}, as: JSRecord<${r[1]}>.self, { ${el.code} })` : `${RT.jsRecordOf}(${code}${typedElement('JSRecord', r[1])}) { ${el.code} }`;
			return el.mark?.op === 'try' ? this.marks.tried(made) : made;
		}
		const parts = /^\((.*)\)$/.exec(type) && splitTopLevel(type.slice(1, -1));
		if (parts && parts.length > 1 && !type.includes('->')) {
			// A tuple type reads an untyped array's elements.
			return `{ (__a: Any?) -> ${type} in (${parts.map((t, k) => (['String', 'Double', 'Bool'].includes(t) ? `${lenientReader(t)}(${RT.jsField}(__a, "${k}"))` : this.fromAny(`${RT.jsField}(__a, "${k}")`, t))).join(', ')}) }(${code})`;
		}
		const whole = unbox.composite === 'function' && hasTopLevelArrow(type) ? functionParts(type) : null;
		// Lenient code: undefined where a function is declared stays undefined (`if (valueConverter) …`).
		if (whole && this.lenient && this.functionCell(whole.text)) return this.unboxFunction(code, whole, true);
		if (whole && this.lenient) return this.implicit(`{ (__f: Any?) -> (${type})? in ${RT.jsIsNullish}(__f) ? nil : ${this.unboxFunction('__f', whole)} }(${code})`, type);
		if (whole) return this.unboxFunction(code, whole);
		const base = type.replace(/\?$/, '');
		if (this.protocols.has(base) && this.facts.hasInterface(this, this.interfaces, (d, s) => this.topName(d, s), base)) {
			this.used.add(base);
			// An interface classes implement: an object conforming to it as it is, any other read by its keys.
			return type.endsWith('?') ? `${RT.jsUnlessNullish}(${code}, { (${RT.jsFlat}($0) as? ${base}) ?? ${base}Object(jsObject: $0) })` : `{ (__o: Any?) -> ${base} in (${RT.jsFlat}(__o) as? ${base}) ?? ${base}Object(jsObject: __o) }(${code})`;
		}
		if (this.facts.hasInterface(this, this.interfaces, (d, s) => this.topName(d, s), base) || !!this.shapes.named(base) || (!this.library && this.core.viewable(base))) {
			this.used.add(base);
			// An object of the interface's class already is the object read (a receiver `call` passes); any other is read by its keys.
			return type.endsWith('?') ? `${RT.jsUnlessNullish}(${code}, { (${RT.jsFlat}($0) as? ${base}) ?? ${this.viewOf(base, '$0')} })` : `{ (__o: Any?) -> ${base} in (${RT.jsFlat}(__o) as? ${base}) ?? ${this.viewOf(base, '__o')} }(${code})`;
		}
		const fn = unbox.composite === 'function' ? functionParts(/^\(.*\)$/.test(base) && hasTopLevelArrow(base.slice(1, -1)) ? base.slice(1, -1) : base) : null;
		if (fn && (type.endsWith('?') || type.endsWith(')?')) && this.functionCell(fn.text)) return this.unboxFunction(code, fn, true);
		if (fn) return type.endsWith('?') || type.endsWith(')?') ? `{ (__f: Any?) -> ${type} in ${RT.jsIsNullish}(__f) ? nil : ${this.unboxFunction('__f', fn)} }(${code})` : this.unboxFunction(code, fn);
		// A Core Foundation class casts unconditionally: `as?` to one is not a test Swift allows.
		if (/^(CG|CT|CF)[A-Z]\w*$/.test(base) && CF_CLASSES.has(base)) {
			if (type.endsWith('?')) return this.marks.helper('jsForeign', code, `, ${base}.self`);
			return appChecked || throwing ? this.marks.ownTried(`${RT.jsForeignPresent}(${code}, ${base}.self)`) : this.marks.castCode(code, base, 'as!');
		}
		// A type parameter may stand for an interface: an object read untyped becomes one (`JSON.parse` of a cached `T[]`).
		if (this.genericNames.has(base)) return type.endsWith('?') ? `${RT.jsConverted}(${code}, to: ${base}.self)` : appChecked ? this.marks.ownTried(`${RT.jsChecked}(${code}, ${base}.self)`) : this.marks.unwrappedCode(`${RT.jsConverted}(${code}, to: ${base}.self)`);
		// A native enum or option set read untyped (`textView.returnKeyType`): the number script holds, as that type's raw value.
		if (unbox.composite === 'enum') return type.endsWith('?') ? `${RT.jsUnlessNullish}(${code}, { ${this.native.enumFromNumber(`${RT.jsToNumber}($0)`, base)} })` : this.native.enumFromNumber(`${RT.jsToNumber}(${code})`, base);
		// A geometry struct the runtime gives script as an object (`{ origin, size }`): the struct again.
		if (['CGRect', 'CGSize', 'CGPoint', 'UIEdgeInsets'].includes(base)) return type.endsWith('?') ? `${RT.jsNativeStruct}(${code}, ${base}.self)` : `${RT.jsNativeStructPresent}(${code}, ${base}.self)`;
		// Core's own code: the library cell, checked, where the function around the placement throws (`libraryThrowsHere`),
		// the value's own read throws, or the store reports what it throws (`jsStoring`). Elsewhere it stays lenient.
		if (this.library && (checked || throwing || input.throws) && ['String', 'Double', 'Bool'].includes(base) && (type === base || type === `${base}?`)) {
			const made = this.marks.marked(`${convertedReader(base, type !== base)}(${code})`, { op: 'converted', of: input });
			if (placed === 'operand') return this.marks.marked(`(try ${made})`, { op: 'try', of: this.marks.valueOf(made) });
			if (placed === 'own') return this.marks.tried(made);
			return { code: made, throws: true, pure: false, mark: { op: 'converted', of: input } };
		}
		if (['String?', 'Double?', 'Bool?'].includes(type)) return `${lenientReader(base, true)}(${code})`;
		if (type.endsWith('?')) return this.libraryClassCast(input, base, false, checked || throwing, placed) ?? this.marks.castCode(code, base, 'as?');
		// An untyped value read as a string, number or boolean is converted as JavaScript would where it is used
		// (`textWrap = "true"` tests true); undefined is the type's zero.
		if (['String', 'Double', 'Bool'].includes(type)) return this.marks.marked(`${lenientReader(type)}(${code})`, { op: 'lenient', of: input });
		// Lenient code: an object of another type passed for a class made without arguments, as JavaScript lets structurally.
		const plain = this.lenient ? this.plainClass(type) : null;
		// Module-qualified: inside an object of the program's that holds the class under its name (`{ Declaration }`), the bare name is that field.
		if (plain) return this.marks.implicitOf(`${RT.jsShaped}(${code}) { ${plain.throws ? 'try ' : ''}${this.appModule ? `${this.appModule}.` : ''}${type}() }`);
		// Lenient code holds a native collection implicitly unwrapped too (`sceneManifest = bundle.objectForInfoDictionaryKey(…)`): nil where it is missing.
		if (this.lenientRef(type) !== type || (this.lenient && /^\[.*\]$/.test(type))) return this.marks.alreadyAs(code, type) ? code : (this.libraryClassCast(input, type, true, checked || throwing, placed) ?? this.marks.castCode(code, type, 'as?', true));
		if (appChecked || throwing) return this.marks.ownTried(`${RT.jsChecked}(${code}, ${metatype(type)})`);
		return this.forcedCast(input, type);
	},
};
