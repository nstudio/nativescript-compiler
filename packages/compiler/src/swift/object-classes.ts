// The classes Swift declares for objects: object classes, accessor classes, dynamic members and key switches.
import ts from 'typescript';
import { NONISOLATED_DEINIT, functionParts, ident, initOrder, isFunctionType, label, optionalType, swiftString, RT, lenientReader } from './syntax.ts';
import type { DynamicMembers, ShapeField, Translator } from './translator.ts';
import type { RecordedMember } from '../kit/manifest.ts';
import { UNKEYED, holdsNil, holdsNilOrUnwrapped, isFunctionHeld, isPropertyField, inPlanOrder, madeBitIn, memberKeysOf, memberOf, shapePlanOfShape, spelledOptional, resultShapeNamed, type ShapePlan } from '../semantics/shapes.ts';
import { heldOf, spelledType } from '../semantics/types.ts';
import { isStatic } from '../semantics/throws.ts';
import { abstractField, programBase } from '../semantics/classes.ts';

export const objectClassesMethods = {
	objectClassCode(this: Translator, name: string, allFields: ShapeField[], className: string | null): string {
		if (allFields.some((f) => f.accessor)) return this.accessorClass(name, allFields);
		const fields = allFields.filter((f) => !f.symbol);
		const symbolic = allFields.filter((f) => f.symbol && !f.key);
		const keyed = allFields.filter((f) => f.key);
		const symbols = keyed.map((f) => ({ key: f.key!, member: f.name, type: f.type, optional: holdsNil(heldOf(spelledType(f.type))) }));
		// A view keeps no fields: each reads and writes its root's key, and its own object's fields are `jsOwn`'s. A result
		// interface's class in the kit has one for an app's untyped object of it.
		const view = !symbolic.length && !keyed.length && (this.library ? resultShapeNamed(this, name) : this.viewed.has(name));
		this.shapesWritten.add(name);
		const lines = [`final class ${name}: ${['JSDynamic', ...this.shapeProtocols(allFields).map((x) => x.conformance), ...(symbolic.length ? [] : ['JSObjectConvertible']), ...(view ? ['JSViewing'] : []), ...(keyed.length ? ['JSSymbolKeyed'] : [])].join(', ')} {`, NONISOLATED_DEINIT];
		const held = (f: ShapeField) => this.shapeHeld(f);
		// A field the object lacks, or holds of another type (JSON without an optional field), reads as JavaScript converts it where used.
		const fieldType = (f: ShapeField) => (this.lenient ? held(f).replace(/^\((.*)\)!$/, '($1)?') : held(f).endsWith('!') ? optionalType(f.type) : f.type);
		const field = (f: ShapeField, from = 'jsObject') => (['String', 'Double', 'Bool'].includes(f.type) ? `${lenientReader(f.type)}(${RT.jsField}(${from}, ${f.key ?? swiftString(f.name)}))` : this.reportedRead(this.fromAnyValue(`${RT.jsField}(${from}, ${f.key ?? swiftString(f.name)})`, fieldType(f)), this.getterSlot(fieldType(f))));
		// A field the program writes, on an object read from another (an event's data), writes that object too.
		const through = new Set(this.library || symbolic.length ? [] : fields.filter((f) => this.membersWritten().has(f.name)).map((f) => f.name));
		// Only a field Swift holds as optional can be missing.
		const optional = symbolic.length ? [] : fields.filter((f) => spelledOptional(heldOf(spelledType(f.type))) && holdsNilOrUnwrapped(heldOf(spelledType(held(f)))));
		const observer = (f: ShapeField) => [...(optional.includes(f) ? [`jsWrote(${swiftString(f.name)}, oldValue != nil, self.${ident(memberOf(f))} == nil)`] : []), ...(through.has(f.name) ? [`jsWriteThrough(${swiftString(f.name)})`] : [])].join('; ');
		if (view) {
			lines.push(`    private struct JSOwnFields { ${fields.map((f, k) => `var f${k}: ${held(f)}`).join('; ')} }`, '    private var jsOwn: JSOwnFields!', '    private let jsRoot: JSDynamic?', '    var jsViewRoot: JSDynamic? { jsRoot }');
			fields.forEach((f, k) => {
				const box = isFunctionType(f.type.replace(/^\((.*)\)[?!]$/, '$1')) ? this.boxedField('newValue', f.type) : this.untypedEnum('newValue', f.type);
				const set = observer(f) ? `let oldValue = jsOwn.f${k}; jsOwn.f${k} = newValue; ${observer(f)}` : `jsOwn.f${k} = newValue`;
				lines.push(`    var ${ident(memberOf(f))}: ${held(f)} {`, `        get { if let __r = jsRoot { return ${field(f, '__r')} }; return jsOwn.f${k} }`, `        set { if let __r = jsRoot { __r[jsKey: ${swiftString(f.name)}] = ${box}; return }; ${set} }`, '    }');
				this.declare(memberOf(f), { kind: 'var', type: held(f) });
			});
		} else
			for (const f of fields) {
				lines.push(`    var ${ident(memberOf(f))}: ${held(f)}${observer(f) ? ` { didSet { ${observer(f)} } }` : ''}`);
				this.declare(memberOf(f), { kind: 'var', type: held(f) });
			}
		for (const f of [...symbolic, ...keyed]) {
			lines.push(`    var ${f.name}: ${f.type}`);
			this.declare(f.name, { kind: 'var', type: f.type });
		}
		for (const x of this.shapeProtocols(allFields)) {
			lines.push(...x.lines);
			for (const [n, m] of x.members) this.declare(n, m);
		}
		// Keys in the order the literal that made this object wrote them, when not the declared order; a key a write adds comes last.
		lines.push(`    private ${optional.length ? 'var' : 'let'} jsOrder: [String]?`);
		// The optional fields set to null rather than left undefined, which Swift holds as one nil.
		const nullable = symbolic.length ? [] : fields.filter((f) => heldOf(spelledType(f.type)) === 'optional');
		if (nullable.length) lines.push('    private var jsNulls: Set<String>?');
		const memberwise = [...initOrder(allFields).map((f) => `${f.name === 'self' ? '`self` __self' : ident(memberOf(f))}: ${isFunctionHeld(heldOf(spelledType(held(f)))) ? '@escaping ' : ''}${held(f)}${holdsNil(heldOf(spelledType(f.type))) ? ' = nil' : ''}`), 'jsOrder: [String]? = nil', ...(nullable.length ? ['jsNulls: Set<String>? = nil'] : []), ...(optional.length ? ['jsUnset: Set<String>? = nil'] : [])].join(', ');
		lines.push(`    init(${memberwise}) {`);
		this.declareInit(memberwise, false);
		if (view) lines.push(`        self.jsOwn = JSOwnFields(${fields.map((f, k) => `f${k}: ${f.name === 'self' ? '__self' : ident(memberOf(f))}`).join(', ')})`, '        self.jsRoot = nil');
		else for (const f of [...fields, ...symbolic, ...keyed]) lines.push(`        self.${ident(memberOf(f))} = ${f.name === 'self' ? '__self' : ident(memberOf(f))}`);
		lines.push('        self.jsOrder = jsOrder', ...(nullable.length ? ['        self.jsNulls = jsNulls'] : []), ...(optional.length ? ['        self.jsUnset = jsUnset'] : []), '    }');
		if (view) {
			lines.push('    private init(jsViewOf root: JSDynamic) {', '        self.jsRoot = root', '        self.jsOrder = nil', '    }');
			lines.push(`    static func jsView(_ value: Any?) -> ${name} {`, `        guard let root = ${RT.jsViewRootOf}(value) else { return ${name}(jsObject: value) }`, `        return ${RT.jsViewOf}(root, ${name}.self) { ${name}(${RT.jsViewOf}: $0) }`, '    }');
			this.declare('jsView', { kind: 'func', mods: 'static ', params: '_ value: Any?', type: name });
			this.declare('jsViewRoot', { kind: 'var', type: 'JSDynamic?' });
		}
		// Keys beyond the type's: those of the untyped object it was read from (a cast of JSON.parse), in its order, and those set on it later (`o[key] = v`).
		lines.push('    private var jsExtra: JSDynamic?');
		if (symbolic.length) {
			lines.push(...this.dynamicMembers(UNKEYED, { fields, className, symbols }), '}');
			return lines.join('\n');
		}
		lines.push('    convenience init(jsObject: Any?) {');
		this.declareInit('jsObject: Any?', false);
		const nulls = nullable.length ? [`jsNulls: ${RT.jsNullKeys}(jsObject, [${nullable.map((f) => swiftString(f.name)).join(', ')}])`] : [];
		lines.push(`        self.init(${[...[...fields, ...keyed].map((f) => `${label(memberOf(f))}: ${field(f)}`), 'jsOrder: (jsObject as? JSDynamic)?.jsKeys', ...nulls].join(', ')})`);
		if (optional.length) lines.push(`        jsUnset = ${RT.jsUnsetKeys}(jsObject, [${optional.map((f) => swiftString(f.name)).join(', ')}])`);
		lines.push('        jsExtra = jsObject as? JSDynamic', ...(through.size ? ['        jsSourced = jsExtra != nil'] : []), '    }');
		if (through.size) lines.push('    private var jsSourced = false', '    private func jsWriteThrough(_ key: String) { if jsSourced { jsExtra?[jsKey: key] = self[jsKey: key] } }');
		const members = this.dynamicMembers(
			shapePlanOfShape(
				fields.map((f) => ({ name: f.name, noted: nullable.includes(f), rewritten: through.has(f.name) })),
				true,
			),
			{ fields, className, symbols },
		);
		const present = (f: ShapeField) => `self.${ident(memberOf(f))} != nil${nullable.includes(f) ? ` || jsNulls?.contains(${swiftString(f.name)}) == true` : ''} || jsUnset?.contains(${swiftString(f.name)}) == true`;
		const declared = `[${fields.map((f) => swiftString(f.name)).join(', ')}]`;
		if (optional.length) {
			// The optional fields holding undefined as an own key (`o.a = undefined`), which a missing one doesn't.
			lines.push('    private var jsUnset: Set<String>?');
			lines.push(`    private func jsHas(_ key: String) -> Bool { switch key { ${optional.map((f) => `case ${swiftString(f.name)}: return ${present(f)}`).join('; ')}; default: return true } }`);
			lines.push('    private func jsWrote(_ key: String, _ had: Bool, _ unset: Bool) {');
			lines.push(`        let was = had${nullable.length ? ' || jsNulls?.contains(key) == true' : ''} || jsUnset?.contains(key) == true`);
			lines.push(`        if unset { ${nullable.length ? 'jsNulls?.remove(key); ' : ''}jsUnset = (jsUnset ?? []).union([key]) } else { jsUnset?.remove(key) }`);
			lines.push(`        if !was { jsOrder = (jsOrder ?? ${declared}).filter { $0 != key && jsHas($0) } + [key] }`, '    }');
		}
		if (view) {
			const at = (head: string) => members.findIndex((m) => m === head);
			const sub = at('    subscript(jsKey key: String) -> Any? {');
			members.splice(sub + 2, 0, '            if let __r = jsRoot { return __r[jsKey: key] }');
			const set = members.indexOf('        set {', sub);
			members.splice(set + 1, 0, '            if let __r = jsRoot { __r[jsKey: key] = newValue; return }');
			const cn = members.findIndex((m) => m.startsWith('    var jsClassName: String? { '));
			members[cn] = members[cn].replace(/\{ (.*) \}$/, '{ jsRoot != nil ? jsRoot!.jsClassName : $1 }');
		}
		members[0] = `    var jsKeys: [String] {\n${view ? '        if let __r = jsRoot { return __r.jsKeys }\n' : ''}        let order = jsOrder ?? ${declared}\n        let keys = order + (jsExtra?.jsKeys ?? []).filter { !order.contains($0) }\n        return ${optional.length ? 'keys.filter(jsHas)' : 'keys'}\n    }`;
		lines.push(...members);
		lines.push('}');
		return lines.join('\n');
	},

	/**
	 * An object literal's class when it has accessors: each accessor runs a
	 * closure the literal gives, with the object as `this`.
	 */
	accessorClass(this: Translator, name: string, fields: ShapeField[]): string {
		const lines = [`final class ${name}: JSDynamic, JSAccessorKeyed {`, NONISOLATED_DEINIT];
		const params: string[] = [];
		const inits: string[] = [];
		for (const f of fields) {
			const n = ident(f.name);
			if (!f.accessor) {
				lines.push(`    var ${n}: ${f.type}`);
				this.declare(f.name, { kind: 'var', type: f.type });
				params.push(`${f.name === 'self' ? '`self` __self' : n}: ${isFunctionHeld(heldOf(spelledType(f.type))) ? '@escaping ' : ''}${f.type}${holdsNil(heldOf(spelledType(f.type))) ? ' = nil' : ''}`);
				inits.push(`        self.${n} = ${f.name === 'self' ? '__self' : n}`);
				continue;
			}
			const a = f.accessor;
			const getType = `(${name}) ${a.throws ? 'throws ' : ''}-> ${f.type}`;
			const setType = `(${name}, ${a.value}) -> Void`;
			if (a.get) {
				lines.push(`    private let __get_${f.name}: ${getType}`);
				params.push(`__get_${f.name}: @escaping ${getType}`);
				inits.push(`        self.__get_${f.name} = __get_${f.name}`);
			}
			if (a.set) {
				lines.push(`    private let __set_${f.name}: ${setType}`);
				params.push(`__set_${f.name}: @escaping ${setType}`);
				inits.push(`        self.__set_${f.name} = __set_${f.name}`);
			}
			const get = a.get ? this.marks.tryIf(a.throws, `__get_${f.name}(self)`) : 'nil';
			if (a.set) lines.push(`    var ${n}: ${f.type} {`, `        get { ${get} }`, `        set { __set_${f.name}(self, newValue${a.get ? '' : '!'}) }`, '    }');
			else lines.push(`    var ${n}: ${f.type} {`, `        get${a.throws ? ' throws' : ''} { ${get} }`, '    }');
			this.declare(f.name, { kind: 'var', type: f.type, throws: !a.set && !!a.throws });
		}
		lines.push('    private let jsOrder: [String]?');
		lines.push(`    init(${[...params, 'jsOrder: [String]? = nil'].join(', ')}) {`, ...inits, '        self.jsOrder = jsOrder', '    }');
		lines.push(`    var jsKeys: [String] { jsOrder ?? [${fields.map((f) => swiftString(f.name)).join(', ')}] }`);
		lines.push('    var jsClassName: String? { nil }');
		lines.push('    subscript(jsKey key: String) -> Any? {', '        get {', '            switch key {');
		this.declareInit([...params, 'jsOrder: [String]? = nil'].join(', '), false);
		this.declare('jsKeys', { kind: 'var', type: '[String]' });
		this.declare('jsClassName', { kind: 'var', type: 'String?' });
		this.declare('subscript', { kind: 'subscript', params: 'jsKey key: String', type: 'Any?' });
		this.declare('jsAccessorKind', { kind: 'func', params: '_ key: String', type: 'String?' });
		if (this.declOwner)
			this.declarations?.names(
				this.declOwner,
				fields.map((f) => f.name),
			);
		for (const f of fields) lines.push(`            case ${swiftString(f.name)}: return ${f.accessor?.throws ? `(try? self.${ident(f.name)}) ?? nil` : this.boxedField(`self.${ident(f.name)}`, f.type)}`);
		lines.push('            default: return nil', '            }', '        }', '        set {', '            switch key {');
		for (const f of fields) if (!f.accessor || f.accessor.set) lines.push(`            case ${swiftString(f.name)}: ${this.storeFromAny(`self.${ident(f.name)}`, f.type, f.name)}`);
		lines.push('            default: break', '            }', '        }', '    }');
		lines.push('    func jsAccessorKind(_ key: String) -> String? {', '        switch key {');
		for (const f of fields) if (f.accessor) lines.push(`        case ${swiftString(f.name)}: return ${swiftString(f.accessor.get && f.accessor.set ? 'Getter/Setter' : f.accessor.get ? 'Getter' : 'Setter')}`);
		lines.push('        default: return nil', '        }', '    }', '}');
		return lines.join('\n');
	},

	/** What an object literal's class conforms to by its members: an iterator (`next`), an iterable (`[Symbol.iterator]`). */
	shapeProtocols(this: Translator, fields: ShapeField[]): { conformance: string; lines: string[]; members: [string, RecordedMember][] }[] {
		const out: { conformance: string; lines: string[]; members: [string, RecordedMember][] }[] = [];
		const fn = (n: string) => {
			const f = fields.find((x) => x.name === n && !x.accessor && !holdsNil(heldOf(spelledType(x.type))));
			const parts = f && functionParts(f.type.replace(/^\((.*)\)\?$/, '$1'));
			return f && parts ? { name: n, params: parts.params.length, param: parts.params[0], ret: parts.result, throws: true, optional: /^\(.*\)\?$/.test(this.shapeHeld(f)) } : undefined;
		};
		const methods = ['next', 'return', 'throw'].map(fn).filter((m): m is NonNullable<typeof m> => !!m);
		const protocol = this.iteratorProtocol(methods);
		if (protocol) out.push(protocol);
		// A literal's own valueOf and toString, in the order OrdinaryToPrimitive tries them for the hint.
		const own = (n: string) => fields.some((f) => f.name === n && !f.accessor && !holdsNil(heldOf(spelledType(f.type))) && functionParts(f.type)?.params.length === 0);
		// A literal's own `[Symbol.toPrimitive]`, held as a closure field of the protocol method's name: the key path names the field.
		const toPrimitive = fields.find((f) => f.symbol && f.name === 'jsToPrimitive' && !f.accessor && !holdsNil(heldOf(spelledType(f.type))));
		const takes = toPrimitive && functionParts(toPrimitive.type)?.params;
		if (takes && takes.length <= 1 && (!takes.length || takes[0] === 'String')) {
			out.push({ conformance: 'JSToPrimitive', lines: [`    func jsToPrimitive(_ hint: String) throws -> Any? { try self[keyPath: \\Self.jsToPrimitive](${takes.length ? 'hint' : ''}) }`], members: [] });
		} else if (own('valueOf') || own('toString')) {
			const call = (n: string) => (!own(n) ? 'nil' : `{ ${this.lenient ? this.marks.tryCode(`${RT.jsCallable}(self.${n}, ${swiftString(n)})()`) : this.marks.tryCode(`self.${n}()`)} }`);
			const body = this.marks.tryCode(`${RT.jsOrdinaryToPrimitive}(hint, valueOf: ${call('valueOf')}, toString: ${call('toString')})`);
			out.push({ conformance: 'JSToPrimitive', lines: [`    func jsToPrimitive(_ hint: String) throws -> Any? { ${body} }`], members: [['jsToPrimitive', { kind: 'func', params: '_ hint: String', throws: true, type: 'Any?' }]] });
		}
		if (fields.some((f) => f.symbol && f.name === 'jsToStringTag' && !f.accessor && f.type === 'String')) out.push({ conformance: 'JSToStringTag', lines: [], members: [] });
		const iterField = fields.find((f) => f.name === 'jsSymbolIterator');
		if (iterField) {
			const iterRet = functionParts(iterField.type.replace(/^\((.*)\)\?$/, '$1'))?.result ?? 'Any?';
			const rawCall = this.marks.tryIf(/\bthrows\b/.test(iterField.type), 'jsSymbolIterator()');
			const anyBody = iterRet === 'Void' ? `${rawCall}; return try ${RT.jsIteratorResult}(nil)` : /^JS(?:Iterator|Generator)<.*>$/.test(iterRet) || iterRet === 'JSIteratorProtocol' ? (this.lenient ? `try ${RT.jsIterated}(jsSymbolIterator(), "Result of the Symbol.iterator method is not an object")` : rawCall) : `try ${RT.jsIteratorResult}(jsSymbolIterator())`;
			const rawBody = iterRet === 'Void' ? `${rawCall}; return nil` : `return ${this.convert(rawCall, iterRet, 'Any?')}`;
			out.push({
				conformance: 'JSIterableValue',
				lines: [`    func jsAnyIterator() throws -> JSIteratorProtocol { ${anyBody} }`, `    func jsRawIterator() throws -> Any? { ${rawBody} }`],
				members: [
					['jsAnyIterator', { kind: 'func', params: '', throws: true, type: 'JSIteratorProtocol' }],
					['jsRawIterator', { kind: 'func', params: '', throws: true, type: 'Any?' }],
				],
			});
		}
		if (fields.some((f) => f.name === 'jsSymbolAsyncIterator')) out.push({ conformance: 'JSAsyncIterableValue', lines: ['    func jsAnyAsyncIterator() throws -> JSAsyncIteratorProtocol { try jsSymbolAsyncIterator() }'], members: [['jsAnyAsyncIterator', { kind: 'func', params: '', throws: true, type: 'JSAsyncIteratorProtocol' }]] });
		return out;
	},

	/** Whether a program base class conforms to `JSSymbolKeyed` already: a root class keeping expandos, or one with symbol-keyed fields. */
	inheritsSymbolKeyed(this: Translator, cls: ts.ClassLikeDeclaration): boolean {
		for (let b = programBase(cls, this.checker); b; b = programBase(b, this.checker)) {
			if (b.members.some((m) => ts.isPropertyDeclaration(m) && !isStatic(m) && !!this.symbolMember(m.name)?.key)) return true;
			if (!programBase(b, this.checker) && !b.heritageClauses?.some((x) => x.token === ts.SyntaxKind.ExtendsKeyword) && (!!this.library || this.pluginFiles.has(b.getSourceFile().fileName))) return true;
		}
		return false;
	},

	/** `JSDynamic`: the object's keys (`plan`, its plan's state) and members by name, for printing, JSON and untyped access. */
	dynamicMembers(this: Translator, plan: ShapePlan, members: DynamicMembers): string[] {
		const { className, override = false, methods = [], symbols = [], symbolMethods = [], raw = new Set<string>(), accessors = [], symbolKeyedBase = false, classNameMember = true, byName, hasMember = byName ? { inherits: byName.inherits } : undefined } = members;
		const fields = members.fields.filter(isPropertyField);
		const { keyed, appBase, expando, expandoAbove, extra, defined, rewritten, noted, nilNull, made } = memberKeysOf(plan);
		const o = override ? 'override ' : '';
		const ownNames = byName ? new Set([...this.instanceKeys()].map((d) => d.name.getText())) : new Set<string>();
		if ((!keyed?.ordered || !appBase) && (!made || made.declares)) this.declare('jsKeys', { kind: 'var', mods: o, type: '[String]' });
		if (made && (made.declares || fields.length)) this.declare('jsDeclaredKeys', { kind: 'var', mods: made.declares ? '' : 'override ', type: '[String]' });
		if (keyed?.ordered) this.declare('jsFieldKeys', { kind: 'var', mods: appBase ? 'override ' : '', type: '[String]' });
		if (symbols.length) this.declare('jsSymbolKeys', { kind: 'var', mods: symbolKeyedBase ? 'override ' : '', type: '[String]' });
		if (classNameMember) this.declare('jsClassName', { kind: 'var', mods: o, type: 'String?' });
		this.declare('subscript', { kind: 'subscript', mods: o, params: 'jsKey key: String', type: 'Any?' });
		if (this.declOwner) this.declarations?.names(this.declOwner, [...fields.map(memberOf), ...accessors.map((a) => a.name), ...methods.map((m) => m.name)]);
		// A class's noted string, number or boolean field stores its zero; the notes tell null and undefined.
		const zeroNoted = (f: { name: string; type: string }) => plan.kind === 'class' && noted(f.name) && ['Double', 'String', 'Bool'].includes(f.type);
		// Absent: nil, apart from null.
		const absent = (f: { name: string }) => `self.${ident(memberOf(f))} == nil${noted(f.name) ? ` && jsNulls?.contains(${swiftString(f.name)}) != true` : ''}`;
		const at = (n: string) => {
			const k = keyed?.keys.findIndex((x) => x.name === n) ?? -1;
			return k < 0 ? Infinity : k;
		};
		const madePresent = (n: string) => {
			const at = madeBitIn(made!, n);
			return `jsMadeBits${at.word} & (1 << ${at.bit}) != 0`;
		};
		const keyFields = fields.filter((f) => !abstractField(f.at));
		const sorted = keyed ? [...keyFields].sort((a, b) => at(a.name) - at(b.name)) : inPlanOrder(plan, keyFields);
		const keys = sorted
			.map((f) => {
				if (f.made) return `(${madePresent(f.name)} ? [${swiftString(f.name)}] : [])`;
				if (!keyed) return spelledOptional(heldOf(spelledType(f.type))) && !nilNull(f.name) ? `(${absent(f)} ? [] : [${swiftString(f.name)}])` : `[${swiftString(f.name)}]`;
				const present = this.keyPresent(keyed, f.name);
				return present ? `(${present} ? [${swiftString(f.name)}] : [])` : `[${swiftString(f.name)}]`;
			})
			.map((k, i) => (defined(sorted[i].name) ? `${RT.jsDefinedKeys}(self, ${swiftString(sorted[i].name)}, ${k})` : k));
		const expandoKeys = expando ? '(jsExpando?.jsKeys ?? [])' : '';
		const keyLines = made
			? !made.declares && !keys.length
				? []
				: [`    ${made.declares ? '' : 'override '}var jsDeclaredKeys: [String] { ${[made.declares ? (override ? 'super.jsKeys' : '') : 'super.jsDeclaredKeys', ...keys].filter(Boolean).join(' + ') || '[]'} }`, ...(made.declares ? [`    ${o}var jsKeys: [String] { ${RT.jsMadeKeys}(jsMade, ${['jsDeclaredKeys', expandoKeys].filter(Boolean).join(' + ')}) }`] : [])]
			: !keyed?.ordered
				? [`    ${o}var jsKeys: [String] { ${expandoAbove && keys.length ? `${RT.jsKeysBeforeExpando}(super.jsKeys, ${keys.join(' + ')}, jsExpando)` : [override ? 'super.jsKeys' : '', ...keys, expandoKeys].filter(Boolean).join(' + ') || '[]'} }`]
				: [`    ${appBase ? 'override ' : ''}var jsFieldKeys: [String] { ${[appBase ? 'super.jsFieldKeys' : override ? 'super.jsKeys' : '', ...keys].filter(Boolean).join(' + ') || '[]'} }`, ...(appBase ? [] : [`    ${o}var jsKeys: [String] { ${RT.jsOrderedKeys}(jsOrder, jsFieldKeys${expando ? ' + jsAddedKeys' : ''}) }`])];
		// A field whose key is not made yet reads undefined, whatever zero its storage holds.
		const absentNil = (f: { name: string; made?: 'unset' | 'inherited' }) => {
			if (f.made === 'unset') return `if !(${madePresent(f.name)}) { return nil }; `;
			const present = keyed && this.keyPresent(keyed, f.name);
			return present ? `if !(${present}) { return nil }; ` : '';
		};
		const definedGet = (f: { name: string }) => (defined(f.name) ? `if let __d = ${RT.jsDefinedGet}(self, ${swiftString(f.name)}) { return __d }; ` : '');
		const definedSet = (f: { name: string }) => (defined(f.name) ? `if ${RT.jsDefinedSet}(self, ${swiftString(f.name)}, newValue) { return }; ` : '');
		const lines = [
			...keyLines,
			...(symbols.length
				? [
						`    ${symbolKeyedBase ? 'override ' : ''}var jsSymbolKeys: [String] { ${symbolKeyedBase ? 'super.jsSymbolKeys + ' : ''}[${symbols
							.filter((f) => !f.optional)
							.map((f) => f.key)
							.join(', ')}]${symbols
							.filter((f) => f.optional)
							.map((f) => ` + (${f.member} == nil ? [] : [${f.key}])`)
							.join('')}${expando ? ' + (jsExpando?.jsSymbolKeys ?? [])' : ''} }`,
					]
				: []),
			`    ${o}var jsClassName: String? { ${className ? swiftString(className) : 'nil'} }`,
			`    ${o}subscript(jsKey key: String) -> Any? {`,
			'        get {',
			...this.keySwitch(
				[
					...fields.map((f) => ({
						name: f.name,
						code: `${definedGet(f)}${absentNil(f)}return ${raw.has(f.name) ? `${RT.jsExpandoGet}(self, ${swiftString(f.name)})` : isFunctionType(f.type.replace(/^\((.*)\)[?!]$/, '$1')) ? (nilNull(f.name) ? `${RT.jsNulled}(${this.boxedField(`self.${ident(memberOf(f))}`, f.type)})` : this.boxedField(`self.${ident(memberOf(f))}`, f.type)) : zeroNoted(f) ? `${RT.jsNotedNullish}(self.${ident(memberOf(f))}, jsNulls, jsUnset, ${swiftString(f.name)})` : noted(f.name) ? `${RT.jsNullable}(${this.untypedEnum(`self.${ident(memberOf(f))}`, f.type)}, jsNulls, ${swiftString(f.name)})` : nilNull(f.name) ? `${RT.jsNulled}(${this.untypedEnum(`self.${ident(memberOf(f))}`, f.type)})` : this.untypedEnum(`self.${ident(memberOf(f))}`, f.type)}`,
					})),
					...accessors.map((a) => ({ name: a.name, code: `return ${a.get ?? 'nil'}` })),
					...methods
						.filter((m) => !fields.some((f) => f.name === m.name))
						.map((m) => {
							// An app class's method sees the object it is called on as `this` when that is one of the class's (`obj[k].call(other)`).
							const value = byName ? `${RT.jsMethodValue}(self) { (__s: ${byName.receiver}) in ${this.boxFunction(`__s.${ident(m.name)}`, m.type, -1, m.name, m.length, undefined, false)} }` : this.boxFunction(`self.${ident(m.name)}`, m.type, -1, m.name, m.length, undefined, false);
							// A value the instance holds in the method's place (`obj.step = …`) is what reading it gives.
							const own = byName && ownNames.has(m.name) ? `if let __own = ${RT.jsOwnProperty}(self, ${swiftString(m.name)}) { return __own }; ` : '';
							return { name: m.name, code: m.available ? `${own}if #available(iOS ${m.available}, *) { return ${value} } else { return nil }` : `${own}return ${value}` };
						}),
				],
				[
					...symbols.map((f) => `            case ${f.key}: return ${f.member}`),
					...symbolMethods.map((sm) => {
						const args = sm.params.map((p, k) => (sm.unread[k] && this.zero(p)) || this.throwingConverts(() => this.presentFromAny(`${RT.jsArg}(__a, ${k})`, p, true, true)));
						const call = this.marks.tryCode(`(${RT.jsCastPresent}(__this) as ${sm.owner}).${sm.method}(${args.join(', ')})`);
						return `            case ${sm.key}: return ({ (__this: Any?, __a: [Any?]) throws -> Any? in ${sm.ret === 'Void' ? `${call}; return nil` : `return ${this.convert(call, sm.ret, 'Any?')}`} } as JSMethod)`;
					}),
				],
				`return ${override ? 'super[jsKey: key]' : expando ? `${RT.jsExpandoGet}(self, key)` : extra ? 'jsExtra?[jsKey: key] ?? nil' : 'nil'}`,
			),
			'        }',
			'        set {',
			...this.keySwitch(
				[
					// A null is noted after the store, whose observer reads the key's state from before it; a field written through to
					// its source (`rewritten`) is written again once the null is noted.
					...fields.map((f) => {
						const store = raw.has(f.name) ? `${RT.jsExpandoSet}(self, ${swiftString(f.name)}, newValue)` : this.storeFromAny(`self.${ident(memberOf(f))}`, f.type, f.name, false, f.at);
						// An object field that holds null is implicitly unwrapped: null and undefined both store nil, which `jsNulls` tells apart.
						const nullable = noted(f.name) && !raw.has(f.name) && /^[A-Z][\w.]*$/.test(f.type) && !['Double', 'String', 'Bool'].includes(f.type) && !this.native.isStructType(f.type);
						const write = nullable ? `if ${RT.jsIsNullish}(newValue) { self.${ident(memberOf(f))} = nil } else { ${store} }` : store;
						return { name: f.name, code: `${definedSet(f)}${write}${noted(f.name) ? `; ${zeroNoted(f) ? `${RT.jsNoteNullish}(&jsNulls, &jsUnset, ` : `${RT.jsNoteNull}(&jsNulls, `}${swiftString(f.name)}, newValue)${rewritten(f.name) ? `; jsWriteThrough(${swiftString(f.name)})` : ''}` : ''}; return` };
					}),
					...accessors.filter((a) => a.set).map((a) => ({ name: a.name, code: `${a.set}; return` })),
				],
				symbols.map((f) => `            case ${f.key}: ${this.storeFromAny(f.member, f.type, f.member, true)}`),
				override ? 'super[jsKey: key] = newValue' : expando ? `${RT.jsExpandoSet}(self, key, newValue)` : extra ? 'if jsExtra == nil { jsExtra = JSObject() }; jsExtra?[jsKey: key] = newValue' : 'break',
			),
			'        }',
			'    }',
		];
		if (hasMember) {
			// `key in object` of a member its class declares (an accessor, a method), which is no own key.
			const hasMembers = byName ? [...new Set([...accessors.map((a) => a.name), ...methods.map((m) => m.name)])].filter((n) => !fields.some((f) => f.name === n)) : [];
			const patterns = [...hasMembers.map(swiftString), ...symbolMethods.map((sm) => sm.key)];
			const mods = hasMember.inherits ? 'override ' : '';
			const rest = hasMember.inherits ? 'super.jsHasMember(key)' : 'false';
			lines.push(`    ${mods}func jsHasMember(_ key: String) -> Bool { ${patterns.length ? `switch key { case ${patterns.join(', ')}: return true; default: return ${rest} }` : `${rest}`} }`);
			this.declare('jsHasMember', { kind: 'func', mods, params: '_ key: String', type: 'Bool' });
		}
		return lines;
	},

	/**
	 * A `subscript(jsKey:)` body: the named cases switched on the key's UTF-8 length first, so a key compares
	 * only with names of its length (Swift tests a string switch's cases one by one, and a class's key that
	 * misses walks every case of each class up its chain). Each case ends the accessor; symbol-keyed cases,
	 * whose keys are known only at run time, and then `fallback`, come after.
	 */
	keySwitch(this: Translator, cases: { name: string; code: string }[], symbols: string[], fallback: string): string[] {
		const seen = new Set<string>();
		const byLength = new Map<number, { name: string; code: string }[]>();
		for (const c of cases) {
			if (seen.has(c.name)) continue;
			seen.add(c.name);
			const n = Buffer.byteLength(c.name, 'utf8');
			byLength.set(n, [...(byLength.get(n) ?? []), c]);
		}
		const lines: string[] = [];
		if (byLength.size) {
			lines.push('            switch key.utf8.count {');
			for (const [n, group] of [...byLength].sort((a, b) => a[0] - b[0])) {
				lines.push(`            case ${n}:`, '                switch key {');
				for (const c of group) lines.push(`                case ${swiftString(c.name)}: ${c.code}`);
				lines.push('                default: break', '                }');
			}
			lines.push('            default: break', '            }');
		}
		if (symbols.length) lines.push('            switch key {', ...symbols, `            default: ${fallback}`, '            }');
		else if (fallback !== 'break') lines.push(`            ${fallback}`);
		return lines;
	},
};
