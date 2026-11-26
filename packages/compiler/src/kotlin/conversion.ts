// Conversions between Kotlin representations: object classes, casts, boxing.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { accessorKey, cast, EMPTY_READ, functionTypeParts, ident, isNullable, kotlinString, lambda, optionalType, safeCast, splitTopLevel, RT } from './syntax.ts';
import type { DynamicMembers, ShapeField, Translator } from './translator.ts';
import { UNKEYED, holdsNil, inPlanOrder, madeBitIn, memberKeysOf, memberOf, shapePlanOfShape, spelledOptional, resultShapeNamed } from '../semantics/shapes.ts';
import type { ShapePlan } from '../semantics/shapes.ts';
import { codeStoreSlot, placeCode } from '../semantics/placement.ts';
import { heldOf, isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import { observers } from '../semantics/observers.ts';
import { abstractField, overAbstractOnly } from '../semantics/classes.ts';

export const conversionMethods = {
	/** A plain JavaScript object of a known shape: a class with named fields, readable as a dynamic object. */
	objectClass(this: Translator, name: string, allFields: ShapeField[], className: string | null, implementing?: string, overrides?: Set<string>): string {
		if (allFields.some((f) => f.accessor)) return this.accessorClass(name, allFields);
		const fields = allFields.filter((f) => !f.symbol);
		const protocols = this.shapeProtocols(allFields);
		if (protocols.some((x) => x.conformance === 'JSToStringTag')) overrides = new Set([...(overrides ?? []), 'jsToStringTag']);
		// Keys apart only in their first letter's case (`vert`, `Vert`) have one JVM accessor name: fields, without accessors.
		const firsts = new Map<string, number>();
		for (const f of fields) {
			const k = f.name[0].toLowerCase() + f.name.slice(1);
			firsts.set(k, (firsts.get(k) ?? 0) + 1);
		}
		const jvmField = (f: ShapeField) => !overrides?.has(f.name) && (firsts.get(f.name[0].toLowerCase() + f.name.slice(1)) ?? 0) > 1;
		const optional = fields.filter((f) => holdsNil(heldOf(spelledType(f.type))));
		// An optional member set after the object is made becomes its last key, as a property JavaScript adds does.
		const symbolic = allFields.some((f) => f.symbol && !f.key);
		const symbols = allFields.filter((f) => f.key).map((f) => ({ key: f.key!, member: f.name, type: f.type, optional: holdsNil(heldOf(spelledType(f.type))) }));
		// A view keeps no fields: each reads and writes its root's key. A result interface's class in the kit has one for an
		// app's untyped object of it.
		const view = !symbolic && !symbols.length && !this.unviewable.has(name) && (this.library ? resultShapeNamed(this, name) : this.viewed.has(name)) && !fields.some(jvmField);
		this.shapesWritten.add(name);
		const tracked = new Set(symbolic ? [] : optional.filter((f) => (!overrides?.has(f.name) || !this.library) && !jvmField(f)).map((f) => f.name));
		const modifiers = (f: ShapeField) => (overrides?.has(f.name) ? 'override ' : jvmField(f) ? '@JvmField ' : '');
		// A literal stores what it is given, undefined included (`{ …, view } as ItemEventData` before the view exists). Kotlin
		// checks a non-null constructor parameter at the call, so such a field is set from a nullable one inside the class.
		const loose = (f: ShapeField) => !this.library && !tracked.has(f.name) && !holdsNil(heldOf(spelledType(f.type))) && this.zero(f.type) === null && f.type !== 'Unit' && !this.isTypeParameterName(f.type);
		// A field the program writes, on an object read from another (an event's data), writes that object too.
		const through = new Set(this.library || symbolic ? [] : fields.filter((f) => !jvmField(f) && this.membersSetLater().has(f.name)).map((f) => f.name));
		const own = (f: ShapeField) => tracked.has(f.name) || through.has(f.name);
		const params = [...fields, ...allFields.filter((f) => f.symbol)].map((f) => (view ? `${ident(memberOf(f))}: ${optionalType(f.type)} = null` : loose(f) ? `${ident(memberOf(f))}: ${optionalType(f.type)}` : `${own(f) ? '' : `${modifiers(f)}var `}${ident(memberOf(f))}: ${f.type}${holdsNil(heldOf(spelledType(f.type))) ? ' = null' : ''}`));
		const lines = [`class ${name}(${[...params, `${tracked.size ? '' : 'private val '}jsOrder: List<String>? = null`].join(', ')}) : ${[implementing ?? 'JSDynamic', ...protocols.map((x) => x.conformance), ...(view ? ['JSViewing'] : []), ...(symbols.length ? ['JSSymbolKeyed'] : [])].join(', ')} {`];
		const writes = (f: ShapeField) => (through.has(f.name) ? `; jsWriteThrough(${kotlinString(f.name)})` : '');
		// Library mode: a class-typed field a caller fills with another class's object (core's application as an event's `object`): none.
		// A string, number or boolean the object lacks (parsed JSON missing a field) reads as its zero, as on iOS.
		const zero: Record<string, string> = { String: '""', Double: 'Double.NaN', Boolean: 'false' };
		const field = (f: ShapeField, o = 'o') => (this.library && /^[A-Z]\w*\?$/.test(f.type) && !f.type.startsWith('JS') && this.isObjectType(f.type) ? `(${RT.jsField}(${o}, ${f.key ?? kotlinString(f.name)}) as? ${f.type.slice(0, -1)})` : !this.library && zero[f.type] ? (heldLoss('shapeFieldRead', zero[f.type]), this.fromAny(`(${RT.jsField}(${o}, ${f.key ?? kotlinString(f.name)}) ?: ${zero[f.type]})`, f.type, f.name)) : this.fromAny(`${RT.jsField}(${o}, ${f.key ?? kotlinString(f.name)})`, f.type, f.name));
		if (view) {
			lines.push('    private var jsRoot: JSDynamic? = null', '    override val jsViewRoot: JSDynamic? get() = jsRoot');
			for (const f of fields) {
				const set = tracked.has(f.name) ? `jsKeySet(field, value, ${kotlinString(f.name)})` : 'value';
				// A view is made with no fields given: a number or boolean field's backing value unboxes.
				const unboxed: Record<string, string> = { Double: '0.0', Boolean: 'false', Int: '0', Long: '0L', Float: '0f' };
				lines.push(`    ${overrides?.has(f.name) ? 'override ' : ''}var ${ident(memberOf(f))}: ${f.type} = ${unboxed[f.type] ? `${ident(memberOf(f))} ?: ${unboxed[f.type]}` : `${RT.jsUnchecked}(${ident(memberOf(f))})`}`, `        get() { val __r = jsRoot ?: return field; return ${field(f, '__r')} }`, `        set(value) { val __r = jsRoot; if (__r != null) { __r.jsSet(${kotlinString(f.name)}, ${RT.jsBox}(value)); return }; field = ${set}${writes(f)} }`);
			}
		} else for (const f of [...fields, ...allFields.filter((f) => f.symbol)]) if (loose(f)) lines.push(`    ${modifiers(f)}var ${ident(memberOf(f))}: ${f.type} = ${RT.jsUnchecked}(${ident(memberOf(f))})`, ...(through.has(f.name) ? [`        set(value) { field = value${writes(f)} }`] : []));
		for (const x of protocols) lines.push(...x.lines);
		if (symbolic) {
			lines.push(...this.dynamicMembers(UNKEYED, { fields, className, symbols }), '}');
			return lines.join('\n');
		}
		const declared = `listOf(${fields.map((f) => kotlinString(f.name)).join(', ')})`;
		if (tracked.size) {
			lines.push('    private var jsOrder: List<String>? = jsOrder');
			for (const f of fields) {
				if (!tracked.has(f.name) || view) continue;
				lines.push(`    ${modifiers(f)}var ${ident(memberOf(f))}: ${f.type} = ${ident(memberOf(f))}`, `        set(value) { field = jsKeySet(field, value, ${kotlinString(f.name)})${writes(f)} }`);
			}
			lines.push(`    private fun <T> jsKeySet(old: T?, value: T?, key: String): T? = value.also {`, '        val was = old != null || jsNulls?.contains(key) == true || jsUnset?.contains(key) == true', '        if (it == null) { jsNulls?.remove(key); jsUnset = (jsUnset ?: mutableSetOf()).also { s -> s.add(key) } } else jsUnset?.remove(key)', `        if (!was) jsOrder = (jsOrder ?: ${declared}).filter { k -> k != key && jsHas(k) } + key`, '    }');
		}
		if (!view) for (const f of fields) if (through.has(f.name) && !tracked.has(f.name) && !loose(f)) lines.push(`    ${modifiers(f)}var ${ident(memberOf(f))}: ${f.type} = ${ident(memberOf(f))}`, `        set(value) { field = value${writes(f)} }`);
		// The optional fields holding undefined as an own key (`o.a = undefined`), which a missing one doesn't.
		if (optional.length) lines.push('    var jsUnset: MutableSet<String>? = null');
		// Read from an untyped object (a cast of JSON.parse): the keys it has beyond the type's stay readable, in its order.
		lines.push('    private var jsExtra: JSDynamic? = null');
		if (through.size) lines.push('    private var jsSourced = false', `    private fun jsWriteThrough(key: String) { if (jsSourced) jsExtra?.jsSet(key, ${RT.jsGet}(key)) }`);
		// Kotlin's null is undefined: the optional fields holding JavaScript's null are noted by key.
		if (optional.length) lines.push('    var jsNulls: MutableSet<String>? = null');
		lines.push('    companion object {');
		lines.push(`        fun fromJS(o: Any?): ${name} = ${name}(${[...[...fields, ...allFields.filter((f) => f.key)].map((f) => `${ident(memberOf(f))} = ${field(f)}`), 'jsOrder = (o as? JSDynamic)?.jsKeys'].join(', ')}).also { it.jsExtra = o as? JSDynamic${through.size ? '; it.jsSourced = it.jsExtra != null' : ''}${optional.length ? `; it.jsNulls = ${RT.jsNullKeys}(o, listOf(${optional.map((f) => kotlinString(f.name)).join(', ')})); it.jsUnset = ${RT.jsUnsetKeys}(o, listOf(${optional.map((f) => kotlinString(f.name)).join(', ')}))` : ''} }`);
		if (view) lines.push(`        fun jsView(o: Any?): ${name} { val root = ${RT.jsViewRootOf}(o) ?: return fromJS(o); return ${RT.jsViewOf}(root, ${name}::class.java) { r -> ${name}().also { it.jsRoot = r } } }`);
		lines.push('    }');
		if (optional.length) lines.push(`    private fun jsHas(key: String): Boolean = when (key) { ${optional.map((f) => `${kotlinString(f.name)} -> this.${ident(memberOf(f))} != null || jsNulls?.contains(${kotlinString(f.name)}) == true || jsUnset?.contains(${kotlinString(f.name)}) == true`).join('; ')}; else -> true }`);
		lines.push(`    override val jsKeys: List<String>`);
		lines.push(`        get() = ${view ? 'jsRoot?.jsKeys ?: ' : ''}(jsOrder ?: ${declared}).let { order -> order + (jsExtra?.jsKeys ?: listOf()).filter { it !in order } }${optional.length ? '.filter(::jsHas)' : ''}`);
		// Keys set beyond the type's (`Object.assign(shape, more)`) are kept with the extra ones.
		const members = this.dynamicMembers(
			shapePlanOfShape(
				fields.map((f) => ({ name: f.name, noted: optional.includes(f), rewritten: through.has(f.name) })),
				true,
			),
			{ fields, className, symbols },
		).slice(1);
		if (view) {
			const at = (head: string) => members.findIndex((m) => m.startsWith(head));
			const cn = at('    override val jsClassName: String? get() = ');
			members[cn] = members[cn].replace(/get\(\) = (.*)$/, 'get() = jsRoot.let { root -> if (root != null) root.jsClassName else $1 }');
			const head = '    override fun jsGet(key: String): Any? = ';
			const get = at(head);
			members[get] = `${head}jsRoot.let { root -> if (root != null) root.jsGet(key) else ${members[get].slice(head.length)}`;
			const end = at(`    override fun jsSet(key: String, value: Any?) {`) - 1;
			members[end] += ' }';
			members.splice(at(`    override fun jsSet(key: String, value: Any?) {`) + 1, 0, '        jsRoot?.let { it.jsSet(key, value); return }');
		}
		lines.push(...members);
		lines.push('}');
		return lines.join('\n');
	},

	/**
	 * `get value()` beside a method `getValue()` (a package's BehaviorSubject): both are `getValue` on the JVM, so the property's
	 * accessors take other names. Only a final property may be renamed.
	 */
	accessorJvmNames(this: Translator, cls: ts.ClassLikeDeclaration, n: string, settable: boolean, mod: string): string {
		if (/\b(open|override|abstract)\b/.test(mod) || !/^[A-Za-z_$][\w$]*$/.test(n)) return '';
		const cap = n[0].toUpperCase() + n.slice(1);
		const methods = new Set(cls.members.filter((m) => ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)).map((m) => (m.name as ts.Identifier).text));
		const getter = /^is[A-Z]/.test(n) ? n : `get${cap}`;
		return (methods.has(getter) ? `@get:JvmName("__get_${n}") ` : '') + (settable && methods.has(`set${cap}`) ? `@set:JvmName("__set_${n}") ` : '');
	},

	/**
	 * An object literal's class when it has accessors: each accessor runs a
	 * function the literal gives, with the object as `this`.
	 */
	accessorClass(this: Translator, name: string, fields: ShapeField[]): string {
		const params: string[] = [];
		const body: string[] = [];
		for (const f of fields) {
			const n = ident(f.name);
			const a = f.accessor;
			if (!a) {
				params.push(`var ${n}: ${f.type}${spelledOptional(heldOf(spelledType(f.type))) ? ' = null' : ''}`);
				continue;
			}
			const ak = n.replace(/`/g, '');
			if (a.get) params.push(`private val __get_${ak}: (${name}) -> ${f.type}`);
			if (a.set) params.push(`private val __set_${ak}: (${name}, ${a.value}) -> Unit`);
			body.push(`    ${a.set ? 'var' : 'val'} ${n}: ${f.type}`, `        get() = ${a.get ? `__get_${ak}(this)` : 'null'}`);
			if (a.set) body.push(`        set(v) { __set_${ak}(this, v${a.get ? '' : '!!'}) }`);
		}
		const lines = [`class ${name}(${[...params, 'private val jsOrder: List<String>? = null'].join(', ')}) : JSDynamic, JSAccessorKeyed {`, ...body];
		lines.push(`    override val jsKeys: List<String> get() = jsOrder ?: listOf(${fields.map((f) => kotlinString(f.name)).join(', ')})`);
		lines.push('    override val jsClassName: String? get() = null');
		lines.push(`    override fun jsGet(key: String): Any? = when (key) {`, ...fields.map((f) => `        ${kotlinString(f.name)} -> this.${ident(f.name)}`), '        else -> null', '    }');
		lines.push(`    override fun jsSet(key: String, value: Any?) {`, '        when (key) {');
		for (const f of fields) if (!f.accessor || f.accessor.set) lines.push(`            ${kotlinString(f.name)} -> this.${ident(f.name)} = ${this.fromAny(this.marks.pureCode('value'), f.type, f.name)}`);
		lines.push('            else -> {}', '        }', '    }');
		lines.push('    override fun jsAccessorKind(key: String): String? = when (key) {');
		for (const f of fields) if (f.accessor) lines.push(`        ${kotlinString(f.name)} -> ${kotlinString(f.accessor.get && f.accessor.set ? 'Getter/Setter' : f.accessor.get ? 'Getter' : 'Setter')}`);
		lines.push('        else -> null', '    }', '}');
		return lines.join('\n');
	},

	/** What an object literal's class implements by its members: an iterator (`next`), an iterable (`[Symbol.iterator]`). */
	shapeProtocols(this: Translator, fields: ShapeField[]): { conformance: string; lines: string[] }[] {
		const out: { conformance: string; lines: string[] }[] = [];
		const fn = (n: string) => {
			const f = fields.find((x) => x.name === n && !x.accessor);
			const parts = f && functionTypeParts(f.type);
			return f && parts ? { name: n, member: memberOf(f), params: parts.params.length, ret: parts.ret, param: parts.params[0] } : undefined;
		};
		const methods = ['next', 'return', 'throw'].map(fn).filter((m): m is NonNullable<typeof m> => !!m);
		const protocol = this.iteratorProtocol(methods);
		if (protocol) out.push(protocol);
		// Its own `toString()`/`valueOf()`, which string and number conversion call (the field holds the function).
		const toStr = fn('toString'),
			valueOf = fn('valueOf');
		if (toStr && !toStr.params) out.push({ conformance: 'JSStringConvertible', lines: [`    override fun toString(): String = ${RT.jsToString}(this.${toStr.member}.invoke())`] });
		if (valueOf && !valueOf.params) out.push({ conformance: 'JSValueOf', lines: [`    override fun jsValueOf(): Any? = this.${valueOf.member}.invoke()`] });
		const toPrimitive = fn('jsToPrimitive');
		if (toPrimitive && toPrimitive.params <= 1) {
			const call = `this.jsToPrimitive.invoke(${toPrimitive.params ? 'hint' : ''})`;
			out.push({ conformance: 'JSToPrimitive', lines: [`    override fun jsToPrimitive(hint: String): Any? = ${toPrimitive.ret === 'Unit' ? `run { ${call}; null }` : call}`] });
		} else if ((toStr && !toStr.params) || (valueOf && !valueOf.params)) {
			const own = (m: typeof toStr) => (m && !m.params ? `{ this.${m.member}.invoke() }` : 'null');
			out.push({ conformance: 'JSToPrimitive', lines: [`    override fun jsToPrimitive(hint: String): Any? = ${RT.jsOrdinaryToPrimitive}(hint, ${own(valueOf)}, ${own(toStr)})`] });
		}
		if (fields.some((f) => f.symbol && f.name === 'jsToStringTag' && !f.accessor && f.type === 'String')) out.push({ conformance: 'JSToStringTag', lines: [] });
		const symbolIter = fields.find((x) => x.name === 'jsSymbolIterator');
		if (symbolIter) {
			const ret = functionTypeParts(symbolIter.type.replace(/^\((.*)\)\?$/, '$1'))?.ret ?? 'Any?';
			const rawExpr = ret === 'Unit' ? 'run { jsSymbolIterator(); null }' : 'jsSymbolIterator()';
			const anyExpr = /^JS(?:Iterator|Generator)<.*>$/.test(ret) || ret === 'JSIteratorProtocol' ? 'jsSymbolIterator()' : `${RT.jsIteratorResult}(${rawExpr})`;
			out.push({
				conformance: 'JSIterableValue',
				lines: [`    override fun jsAnyIterator(): JSIteratorProtocol = ${anyExpr}`, `    override fun jsRawIterator(): Any? = ${rawExpr}`],
			});
		}
		if (fields.some((f) => f.name === 'jsSymbolAsyncIterator')) out.push({ conformance: 'JSAsyncIterableValue', lines: ['    override fun jsAnyAsyncIterator(): JSAsyncIteratorProtocol = jsSymbolAsyncIterator() as JSAsyncIteratorProtocol'] });
		return out;
	},

	/** `JSDynamic`: the object's keys (`plan`, its plan's state) and members by name, for printing, JSON and untyped access. */
	dynamicMembers(this: Translator, plan: ShapePlan, members: DynamicMembers): string[] {
		const { fields, className, inherits = false, symbols = [], methods = [], superclass, receiver, keyIndex = false } = members;
		const { keyed, appBase, expando, expandoAbove, extra, defined, rewritten, noted, nilNull, made } = memberKeysOf(plan);
		const fallbackGet = expando ? `${RT.jsExpandoGet}(this, key)` : extra ? 'jsExtra?.jsGet(key)' : 'null';
		// A class's noted string, number or boolean field stores its zero; the notes tell null and undefined.
		const zeroNoted = (f: { name: string; type: string }) => plan.kind === 'class' && noted(f.name) && ['Double', 'String', 'Boolean'].includes(f.type);
		const fallbackSet = expando ? `${RT.jsExpandoSet}(this, key, value)` : extra ? '(jsExtra ?: JSObject().also { jsExtra = it }).jsSet(key, value)' : '';
		const accessors = (members.accessors ?? []).filter((a) => !fields.some((f) => f.name === a.name) && !methods.some((m) => m.name === a.name));
		// A made field the prototype gives a value is in the object (`key in o`) before it is a key of its own.
		const hasMembers = [...new Set([...accessors.map((a) => accessorKey(a.name)), ...methods.filter((m) => !m.key).map((m) => m.name), ...fields.filter((f) => f.made === 'inherited').map((f) => f.name)])];
		const at = (n: string) => {
			const k = keyed?.keys.findIndex((x) => x.name === n) ?? -1;
			return k < 0 ? Infinity : k;
		};
		const madePresent = (n: string) => {
			const at = madeBitIn(made!, n);
			return `(jsMadeBits${at.word} and (1L shl ${at.bit})) != 0L`;
		};
		// A field a source base declares too is one key, which the base's keys list; an abstract field is none, and a field over
		// abstract declarations only is the class's own.
		const own = fields.filter((f) => !abstractField(f.at) && (!inherits || !f.at || !this.redeclaredField(f.at) || overAbstractOnly(f.at, this.checker)));
		const sorted = keyed ? [...own].sort((a, b) => at(a.name) - at(b.name)) : inPlanOrder(plan, own);
		const fieldKeys = sorted
			.map((f) => {
				if (f.made) return `(if (${madePresent(f.name)}) listOf(${kotlinString(f.name)}) else listOf())`;
				if (!keyed) return holdsNil(heldOf(spelledType(f.type))) && !nilNull(f.name) ? `(if (${ident(memberOf(f))} == null${noted(f.name) ? ` && jsNulls?.contains(${kotlinString(f.name)}) != true` : ''}) listOf() else listOf(${kotlinString(f.name)}))` : `listOf(${kotlinString(f.name)})`;
				const present = this.keyPresent(keyed, f.name);
				return present ? `(if (${present}) listOf(${kotlinString(f.name)}) else listOf())` : `listOf(${kotlinString(f.name)})`;
			})
			.map((k, i) => (defined(sorted[i].name) ? `${RT.jsDefinedKeys}(this, ${kotlinString(sorted[i].name)}, ${k})` : k));
		const expandoKeys = expando ? ['(jsExpando?.jsKeys ?: listOf())'] : [];
		const keys = [...fieldKeys, ...expandoKeys];
		const keyLines = made
			? !made.declares && !fieldKeys.length
				? []
				: [`    override val jsDeclaredKeys: List<String> get() = ${[made.declares ? (inherits ? 'super.jsKeys' : '') : 'super.jsDeclaredKeys', ...fieldKeys].filter(Boolean).join(' + ') || 'listOf()'}`, ...(made.declares ? [`    override val jsKeys: List<String> get() = ${RT.jsMadeKeys}(jsMade, ${['jsDeclaredKeys', ...expandoKeys].join(' + ')})`] : [])]
			: !keyed?.ordered
				? // A subclass adding no keys has its superclass's.
					inherits && !keys.length
					? []
					: [`    override val jsKeys: List<String> get() = ${expandoAbove && inherits ? `${RT.jsKeysBeforeExpando}(super.jsKeys, ${keys.join(' + ')}, jsExpando)` : [inherits ? 'super.jsKeys' : '', ...keys].filter(Boolean).join(' + ') || 'listOf()'}`]
				: appBase
					? fieldKeys.length
						? [`    override val jsFieldKeys: List<String> get() = ${['super.jsFieldKeys', ...fieldKeys].join(' + ')}`]
						: []
					: [`    override val jsFieldKeys: List<String> get() = ${[inherits ? 'super.jsKeys' : '', ...fieldKeys].filter(Boolean).join(' + ') || 'listOf()'}`, `    override val jsKeys: List<String> get() = ${RT.jsOrderedKeys}(jsOrder, jsFieldKeys${expandoKeys.length ? ' + jsAddedKeys' : ''})`];
		const definedGet = (f: { name: string }, read: string) => (defined(f.name) ? `${RT.jsDefinedGet}(this, ${kotlinString(f.name)}).let { if (it != null) it.value else ${read} }` : read);
		const definedSet = (f: { name: string }, write: string) => (defined(f.name) ? `{ if (!${RT.jsDefinedSet}(this, ${kotlinString(f.name)}, value)) ${write.startsWith('{') ? write : `{ ${write} }`} }` : write);
		const withDefined = (f: { name: string }, line: string, wrap: (f: { name: string }, code: string) => string) => {
			const at = line.indexOf(' -> ');
			return line.slice(0, at + 4) + wrap(f, line.slice(at + 4));
		};
		// A field whose key is not made yet reads undefined, whatever zero its storage holds.
		const absentUndefined = (f: { name: string; made?: 'unset' | 'inherited' }, line: string) => {
			const present = f.made === 'unset' ? madePresent(f.name) : keyed && this.keyPresent(keyed, f.name);
			if (!present) return line;
			const at = line.indexOf(' -> ');
			return `${line.slice(0, at + 4)}if (${present}) ${line.slice(at + 4)} else null`;
		};
		const ownNames = new Set([...this.instanceKeys()].map((d) => d.name.getText()));
		// A method read by name is a script function calling it with the arguments it is given.
		const method = (m: { name: string; key?: string; params: string[]; unread?: boolean[]; ret: string }) => {
			const args = m.params.map((t, k) => (m.unread?.[k] && this.zero(t)) || this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), t, true));
			// An app class's method sees the object it is called on as `this` when that is one of the class's (`obj[k].call(other)`).
			const call = `${receiver && !m.key ? `${RT.jsMethodReceiver}(__s, this, ${receiver}::class.java)` : 'this'}.${this.methodIdent(m.name)}(${args.join(', ')})`;
			const fn = receiver && !m.key ? `JSMethod(${m.params.length}) ${lambda(['__s', '__a'], m.ret === 'Unit' ? `${call}; null` : call)}` : `${RT.jsFunction} ${lambda(['__a'], m.ret === 'Unit' ? `${call}; null` : call)}`;
			return `        ${m.key ?? kotlinString(m.name)} -> ${!m.key && ownNames.has(m.name) ? `(${RT.jsOwnProperty}(this, ${kotlinString(m.name)}) ?: JSFound(${fn})).value` : fn}`;
		};
		return [
			...keyLines,
			...(symbols.length
				? [
						`    override val jsSymbolKeys: List<String> get() = listOf${symbols.every((f) => f.optional) ? '<String>' : ''}(${symbols
							.filter((f) => !f.optional)
							.map((f) => f.key)
							.join(', ')})${symbols
							.filter((f) => f.optional)
							.map((f) => ` + listOfNotNull(${f.key}.takeIf { this.${f.member} != null })`)
							.join('')}`,
					]
				: []),
			`    override val jsClassName: String? get() = ${className ? kotlinString(className) : 'null'}`,
			...this.byNameGet(
				[
					// A field Kotlin declares `lateinit` (an object type, unset): undefined until set.
					...fields.map((f) => ({
						name: f.name,
						line: withDefined(
							f,
							absentUndefined(
								f,
								zeroNoted(f)
									? `        ${kotlinString(f.name)} -> ${RT.jsNotedNullish}(this.${ident(memberOf(f))}, jsNulls, jsUnset, ${kotlinString(f.name)})`
									: noted(f.name)
										? `        ${kotlinString(f.name)} -> ${RT.jsNullable}(${RT.jsUnsetIsUndefined} { this.${ident(memberOf(f))} }, jsNulls, ${kotlinString(f.name)})`
										: !this.library && !holdsNil(heldOf(spelledType(f.type))) && this.zero(f.type) === null && f.type !== 'Unit' && !this.isTypeParameterName(f.type)
											? `        ${kotlinString(f.name)} -> ${RT.jsUnsetIsUndefined} { ${f.own ? this.scriptFunctionRead(`this.${ident(memberOf(f))}`, f.type) : `this.${ident(memberOf(f))}`} }`
											: `        ${kotlinString(f.name)} -> ${nilNull(f.name) ? `${RT.jsNulled}(this.${ident(memberOf(f))})` : f.own ? this.scriptFunctionRead(`this.${ident(memberOf(f))}`, f.type) : `this.${ident(memberOf(f))}`}`,
							),
							definedGet,
						),
					})),
					...accessors.filter((a) => a.readable).map((a) => ({ name: accessorKey(a.name), line: `        ${kotlinString(accessorKey(a.name))} -> this.${ident(a.name)}` })),
					...symbols.map((f) => ({ key: f.key, fixed: !!f.fixed, either: !!f.either, maybeUndefined: !!f.maybeUndefined, line: `        ${f.key} -> this.${f.member}` })),
					...methods.filter((m) => !fields.some((f) => f.name === m.name)).map((m) => (m.key ? { key: m.key, fixed: !!m.fixed, either: !!m.either, maybeUndefined: !!m.maybeUndefined, line: method(m) } : { name: m.name, line: method(m) })),
				],
				inherits ? 'super.jsGet(key)' : fallbackGet,
				keyIndex,
			),
			`    override fun jsSet(key: String, value: Any?) {`,
			'        when (key) {',
			// A registered property's accessor is the prototype's, which converts what script sets (`col = "1"`): the value as it is.
			// A null is noted after the store, whose setter reads the key's state from before it; a field written through to its
			// source (`rewritten`) is written again once the null is noted.
			...fields.map((f) =>
				withDefined(
					f,
					`            ${kotlinString(f.name)} -> ${(f as { expando?: boolean }).expando ? `${RT.jsExpandoSet}(this, ${kotlinString(f.name)}, value)` : zeroNoted(f) ? `{ this.${ident(memberOf(f))} = if (${RT.jsIsNullish}(value)) ${f.type === 'Double' ? '(if (value == null) Double.NaN else 0.0)' : this.zero(f.type)} else ${this.storeFromAny(f)}; jsNulls = ${RT.jsNoteNull}(jsNulls, ${kotlinString(f.name)}, value); jsUnset = ${RT.jsNoteUnset}(jsUnset, ${kotlinString(f.name)}, value)${rewritten(f.name) ? `; jsWriteThrough(${kotlinString(f.name)})` : ''} }` : noted(f.name) ? `{ this.${ident(memberOf(f))} = ${holdsNil(heldOf(spelledType(f.type))) ? this.storeFromAny(f) : `if (${RT.jsIsNullish}(value)) ${RT.jsUncheckedNull}<${f.type}>() else ${this.storeFromAny(f)}`}; jsNulls = ${RT.jsNoteNull}(jsNulls, ${kotlinString(f.name)}, value)${rewritten(f.name) ? `; jsWriteThrough(${kotlinString(f.name)})` : ''} }` : `this.${ident(memberOf(f))} = ${this.storeFromAny(f)}`}`,
					definedSet,
				),
			),
			// A setter takes what script gives it (`textWrap = "true"`): as JavaScript reads it as the setter's type.
			...accessors.filter((a) => a.settable).map((a) => `            ${kotlinString(accessorKey(a.name))} -> ${a.set ?? `this.${ident(a.name)} = ${a.type === 'Boolean' ? `${RT.jsTruthy}(value)` : a.type === 'Double' ? `${RT.jsToNumber}(value)` : this.fromAnyCode('value', a.type, true)}`}`),
			...symbols.map((f) => `            ${f.key} -> this.${f.member} = ${this.fromAny('value', f.type)}`),
			`            else -> ${inherits ? 'super.jsSet(key, value)' : fallbackSet || '{}'}`,
			'        }',
			'    }',
			// `key in object` of a member its class declares (an accessor, a method), not only of its own keys.
			...(hasMembers.length ? [`    override fun jsHasMember(key: String): Boolean = when (key) { ${hasMembers.map(kotlinString).join(', ')} -> true; else -> ${inherits && superclass ? `super<${superclass}>.jsHasMember(key)` : 'false'} }`] : []),
		];
	},

	/**
	 * `jsGet` over a class's members by name, `entries` in their order: each a constant key (`name`) or a key a symbol gives
	 * (`key`), which a `jsPropertyKey` spelling may make any string. Kotlin dispatches a `when` over constant strings by
	 * hash, and one with any other condition by comparing each in turn; so where no constant key can be a symbol's key or
	 * "undefined" (a missing symbol's), the constants are a `when` of their own and only such a key goes on to the others.
	 * Those, where every one is `fixed` and the class may keep one (`keyIndex`), are found by their place in a `JSKeyIndex`.
	 */
	byNameGet(this: Translator, entries: ({ name: string; line: string } | { key: string; fixed: boolean; either?: boolean; maybeUndefined?: boolean; line: string })[], fallback: string, keyIndex: boolean): string[] {
		const head = '    override fun jsGet(key: String): Any? = ';
		const computed = entries.flatMap((e) => ('key' in e ? [e] : []));
		const constant = entries.flatMap((e) => ('name' in e ? [e] : []));
		const split = computed.length > 0 && computed.every((e) => !e.either && !e.key.startsWith(`${RT.jsPropertyKey}(`)) && constant.every((e) => !e.name.startsWith('\u0000') && e.name !== 'undefined');
		if (!split) return [`${head}when (key) {`, ...entries.map((e) => e.line), `        else -> ${fallback}`, '    }'];
		const undefinedKey = computed.some((e) => e.maybeUndefined || e.key.includes('?: "undefined"')) ? ' && key != "undefined"' : '';
		const indexed = keyIndex && computed.length > 2 && computed.every((e) => e.fixed);
		const index = indexed ? [`    private object JSSymbolKeys { val index = JSKeyIndex(${computed.length}) { when (it) { ${computed.map((e, i) => `${i} -> ${e.key}`).join('; ')}; else -> "" } } }`] : [];
		const symbolic = (indent: string) => [
			`if (!${RT.jsIsSymbolKey}(key)${undefinedKey}) ${fallback} else when (${indexed ? 'JSSymbolKeys.index.of(key)' : 'key'}) {`,
			...computed.map((e, i) => {
				const at = `        ${e.key} -> `;
				if (!e.line.startsWith(at)) throw new Error(`byNameGet: a branch not keyed by ${e.key}`);
				return `${indent}    ${indexed ? i : e.key} -> ${e.line.slice(at.length)}`;
			}),
			`${indent}    else -> ${fallback}`,
			`${indent}}`,
		];
		if (!constant.length) return [...index, ...symbolic('    ').map((l, i) => (i ? l : head + l))];
		return [...index, `${head}when (key) {`, ...constant.map((e) => e.line), ...symbolic('        ').map((l, i) => (i ? l : `        else -> ${l}`)), '    }'];
	},

	/** A dynamic setter's `value` (`obj[key] = v`, a binding's write) where Kotlin holds the field `f`. */
	storeFromAny(this: Translator, f: { name: string; type: string; at?: ts.PropertyDeclaration }): string {
		return placeCode(this.placement, this.marks.pureCode('value'), codeStoreSlot(this.placement, f.type, f.at)) ?? this.fromAny(this.marks.pureCode('value'), f.type, f.name);
	},

	fromAnyCode(this: Translator, code: string, type: string, orZero = false): string {
		const zero = this.zero(type);
		// Library mode: another primitive converts, as JavaScript reads it where it is used, and an object is a TypeError.
		if (orZero && type === 'Double') return `${this.library ? RT.jsConvertedNumberOrZero : RT.jsNumberOrZero}(${code})`;
		if (orZero && this.library && type === 'String') return `${RT.jsConvertedStringOrEmpty}(${code})`;
		if (orZero && this.library && type === 'Boolean') return `${RT.jsConvertedBooleanOrFalse}(${code})`;
		// App code: an untyped string or boolean is converted as JavaScript converts it where it is used, never refused.
		if (orZero && (type === 'String' || type === 'Boolean')) return this.fromAny(code, type);
		if (orZero && zero && zero !== 'null' && !type.endsWith('?')) return `(${safeCast(code, type)} ?: ${zero})`;
		return this.fromAny(code, type);
	},

	/** Kotlin code reading an untyped value (`Any?`) as `type`; `name` is the field or variable it goes to, for the TypeError. */
	fromAny(this: Translator, code: string, type: string, name?: string): string {
		if (isUntyped(spelledType(type)) || this.constructs(code, type)) return code;
		const nullish = /^JSNullish<(.*)>$/.exec(type);
		if (nullish) return this.nullishOfAny(code, nullish[1]);
		// An Error held untyped (a caught or rejected value): the error, or a view of what was thrown instead.
		if (type === 'JSError' && !this.lenient) return `${RT.jsErrorOf}(${code})`;
		// A call's value read as nothing: the call still runs.
		if (type === 'Unit') return this.marks.isPure(code) ? this.marks.pureCode('Unit') : this.marks.marked(`run { ${code}; Unit }`, { op: 'discarded', of: this.marks.valueOf(code) });
		if (code === 'null' && type.endsWith('?')) return 'null';
		const unbox = this.unboxStep(type);
		const m = unbox.composite === 'array' ? /^JSArray<(.*)>(\??)$/.exec(type) : null;
		if (m) {
			observers.keep?.('kotlin', 'untyped-read', 'Any?', type, this.currentFile, !!this.library);
			const read = (x: string) => `${RT.jsArrayFrom}(${x}) { ${this.fromAny('it', m[1])} }`;
			if (!m[2]) return read(code);
			return this.marks.isPure(code) ? `(if (${RT.jsIsNullish}(${code})) null else ${read(code)})` : `${RT.jsUnlessNullish}(${code}) { ${read('it')} }`;
		}
		const record = unbox.composite === 'record' ? /^JSRecord<(.*)>(\??)$/.exec(type) : null;
		// App code: of objects it types as its own classes, which a package's copies (`{ ...entity }`) are not: each read as one.
		const entry = record?.[1].replace(/\?$/, '');
		if (record && !this.library && entry && (this.interfaces.has(entry) || this.isShapeType(entry))) {
			const read = (x: string) => `${RT.jsRecordOf}(${x}) { ${this.fromAny('it', record[1])} }`;
			if (!record[2]) return read(code);
			return this.marks.isPure(code) ? `(if (${RT.jsIsNullish}(${code})) null else ${read(code)})` : `${RT.jsUnlessNullish}(${code}) { ${read('it')} }`;
		}
		if (record) return `${record[2] ? RT.jsRecordOrNull : RT.jsRecord}<${record[1]}>(${code})`;
		const pair = /^(Pair|Triple)<(.*)>$/.exec(type);
		if (pair) {
			const parts = splitTopLevel(pair[2]);
			return `run { val __a = ${code}; ${pair[1]}(${parts.map((t, k) => this.fromAny(`${RT.jsField}(__a, "${k}")`, t)).join(', ')}) }`;
		}
		const base = type.replace(/\?$/, '');
		if (this.isShapeType(base)) {
			this.used.add(base);
			// An object of a class implementing the interface is itself; anything else is read into the interface's class.
			const read = (x: string) => (this.protocols.has(base) ? `${x}.let { it as? ${base} ?: ${this.viewOf(`${base}Object`, 'it')} }` : this.viewOf(base, x));
			if (!type.endsWith('?')) return read(code);
			return this.marks.isPure(code) ? `(if (${RT.jsIsNullish}(${code})) null else ${read(code)})` : `${RT.jsUnlessNullish}(${code}) { ${read('it')} }`;
		}
		if (!this.library && /^[A-Z]\w*\??$/.test(type)) {
			const reified = this.reifiedRead(code, type);
			if (reified) return reified;
		}
		// A function held untyped (a script function, a method read by name): callable as the typed function.
		const fn = unbox.composite === 'function' ? functionTypeParts(type.replace(/^\((.*)\)\?$/, '$1')) : null;
		if (fn && fn.params.length <= 7) {
			// Where the signatures do not settle it, a wrapper is read back as its own function (`, false`).
			const kind = /^JSArray</.test(fn.params.at(-1) ?? '') && fn.params.length <= 3 ? (this.restFunctionTypes.get(type.replace(/^\((.*)\)\?$/, '$1')) ?? 'both') : 'array';
			const typed = `${kind === 'array' ? 'jsFunction' : 'jsRestFunction'}${fn.params.length}<${[...fn.params, fn.ret].join(', ')}>`;
			const call = (x: string) => `${typed}(${x}${kind === 'both' ? ', false' : ''})`;
			return /\)\?$/.test(type) ? `${RT.jsUnlessNullish}(${code}) { ${call('it')} }` : call(code);
		}
		// A promise its type promises may be any thenable: adopted, as awaiting it or `Promise.resolve` would.
		const promised = unbox.composite === 'promise' ? /^JSPromise<(.*)>$/.exec(base) : null;
		if (promised) {
			// Kotlin cannot tell a promise's element type: objects read into classes are read as each value arrives.
			const read = this.readsIntoClass(promised[1]) ? ` { ${this.fromAny('it', promised[1])} }` : '';
			const of = (x: string) => `${RT.jsPromiseOf}<${promised[1]}>(${x})${read}`;
			return type.endsWith('?') ? `${RT.jsUnlessNullish}(${code}) { ${of('it')} }` : of(code);
		}
		// Library mode: JavaScript's null where an object goes (`cond ? entry.fragment : null`) is Kotlin's.
		// A string, number or boolean slot given another primitive converts it (a binding's 5 for a string is "5"); an empty
		// marker (`unsetValue`) holds none, and any object is a TypeError.
		if (this.library && /^(String|Double|Boolean)\?$/.test(type)) return `${({ 'String?': RT.jsConvertedStringOrNil, 'Double?': RT.jsConvertedNumberOrNil, 'Boolean?': RT.jsConvertedBoolOrNil } as Record<string, string>)[type]}(${code}${name ? `, ${kotlinString(name)}` : ''})`;
		// App code: an untyped string, number or boolean is converted as JavaScript converts it where it is used; undefined and null stay null.
		if (/^(String|Double|Boolean)\?$/.test(type)) return `${({ 'String?': RT.jsAssertedStringOrNull, 'Double?': RT.jsAssertedNumberOrNull, 'Boolean?': RT.jsAssertedBooleanOrNull } as Record<string, string>)[type]}(${code})`;
		// JavaScript's null (JSNull in an untyped object) where a nullable slot goes is Kotlin's.
		if (isNullable(type)) return this.checkedCast(code, type);
		// A Date its type promises that JSON gave as text (`createdAt: Date` of a parsed payload): the date the text names, as `new Date(text)` reads it.
		if (!this.library && type === 'JSDate') return `${RT.jsDateOf}(${code})`;
		if (!this.library && type === 'JSRegExp') return `${RT.jsRegExpFrom}(${code})`;
		// An object slot its declarations call non-null may still get null (`getAncestor` finding none), which JavaScript passes on.
		// Core's own code: null is carried so, and an instance of another class is a TypeError.
		if (this.isObjectType(type) && !/^(String|Double|Boolean)$/.test(type)) {
			const cls = this.library && !['JSError', 'JSDate'].includes(type) ? this.castClass(type) : null;
			if (cls) return this.marks.marked(`${RT.jsCastCarried}(${code}, ${cls})`, { op: 'cast', to: parseNativeType(type), optional: false, implicit: false, of: this.marks.valueOf(code), unchecked: true });
			return this.unchecked(type, `${RT.jsJavaArgument}(${code})`);
		}
		const converted = this.library ? ({ String: RT.jsConvertedString, Double: RT.jsConvertedNumber, Boolean: RT.jsConvertedBool } as Record<string, string>)[type] : undefined;
		if (converted) heldLoss('convertedRead', EMPTY_READ[type]);
		if (converted) return `${converted}(${code}${name ? `, ${kotlinString(name)}` : ''})`;
		return this.checkedCast(code, type, name);
	},

	/**
	 * `code as type` checked by the runtime: a string, number, boolean or class instance of another type is a TypeError
	 * naming `name` where given. A nullable class takes JavaScript's null and undefined as null.
	 */
	checkedCast(this: Translator, code: string, type: string, name?: string): string {
		// A string, number or boolean is converted as JavaScript converts it where it is used, never refused.
		const primitive = this.library ? ({ String: RT.jsAsString, Double: RT.jsAsNumber, Boolean: RT.jsAsBoolean } as Record<string, string>)[type] : ({ String: RT.jsAssertedString, Double: RT.jsAssertedNumber, Boolean: RT.jsAssertedBoolean } as Record<string, string>)[type];
		if (primitive && !this.library) heldLoss('assertedRead', EMPTY_READ[type]);
		if (primitive) return this.library ? `${primitive}(${code}${name ? `, ${kotlinString(name)}` : ''})` : `${primitive}(${code})`;
		const cls = this.castClass(type);
		if (!cls) return cast(isNullable(type) ? `${RT.jsJavaArgument}(${code})` : code, type);
		return `${isNullable(type) ? RT.jsCast : RT.jsCastPresent}(${code}, ${cls})`;
	},

	/** Whether an untyped value of `type` is read into an interface's or object shape's class, directly or as elements. */
	readsIntoClass(this: Translator, type: string): boolean {
		const base = type.replace(/\?$/, '');
		const inner = /^JS(?:Array|Record)<(.*)>$/.exec(base);
		return inner ? this.readsIntoClass(inner[1]) : base !== 'Unit' && this.isShapeType(base);
	},

	/** The class `jsCast` tests a value of `type` against, or null where Kotlin has none to test (generics, `Any`). */
	castClass(this: Translator, type: string): string | null {
		const base = type.replace(/\?$/, '');
		if (!/^[A-Za-z_][\w.]*$/.test(base) || this.isTypeParameterName(base) || ['Any', 'Unit', 'Nothing'].includes(base)) return null;
		return ['Double', 'Boolean', 'Int', 'Long', 'Float', 'Short', 'Byte', 'Char'].includes(base) ? `${base}::class.javaObjectType` : `${this.native?.expressionName?.(base, this.translating) ?? base}::class.java`;
	},
};
