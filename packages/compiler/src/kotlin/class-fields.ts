// A class declaration's fields as Kotlin: parameter properties, static blocks, instance, static and symbol-keyed fields, the optional members an interface declares, the fields' doc comments and their prototype defaults.
import ts from 'typescript';
import { chainedThrough, earlyBacking, ident, isFunctionType, isNullable, kotlinString, nullishType, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import { implementedOptionalMembers } from '../semantics/shapes.ts';
import { hasModifier, thisNodes } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { prototypeDecorated } from '../semantics/classes.ts';
import { literalKey } from '../semantics/lang.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { writtenFlag } from '../semantics/states/lenient.ts';

export const classFieldsMethods = {
	parameterPropertyFieldsCode(this: Translator, k: ClassParts): void {
		const { plugin, open, overridden, interfaceFields, lines, fields } = k;
		const c = this.checker;
		this.indent = '    ';
		for (const p of k.layout.paramProps) {
			const n = (p.name as ts.Identifier).text;
			const narrower = this.isAny(p.name) ? interfaceFields.get(n) : undefined;
			// Lenient code: the property holds what the parameter may (null or undefined), as its declaration does.
			const t = narrower && !isUntyped(spelledType(narrower)) ? optionalType(narrower) : this.states.mayBeNull(p) ? optionalType(this.typeOf(p.name)) : this.typeOf(p.name);
			if (t !== this.typeOf(p.name)) {
				const sym = c.getSymbolAtLocation(p.name);
				if (sym) this.nullableDecls.add(sym);
			}
			if (narrower && !isUntyped(spelledType(narrower))) k.narrowedParams.set(p, t);
			// A package's property a base class declares already (a package's `AsapAction.scheduler`) is the base's, read as this one's type.
			if (plugin && this.redeclaredField(p)) {
				const sym = c.getSymbolAtLocation(p.name);
				if (sym) this.nullableDecls.add(sym);
				continue;
			}
			// A property a subclass may override needs a value of its own before the constructor runs.
			lines.push(`    ${this.memberMods(k, n)}${open || overridden.has(n) ? this.deferredDeclaration(ident(n), t) : `var ${ident(n)}: ${t}`}`);
			fields.push({ name: n, type: t });
		}
	},

	fieldMemberCode(this: Translator, k: ClassParts, m: ts.ClassElement): void {
		if (ts.isClassStaticBlockDeclaration(m)) this.staticBlockCode(k, m);
		else if (ts.isPropertyDeclaration(m)) this.propertyFieldCode(k, m);
	},

	propertyFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration): void {
		k.fieldStarts.push([k.lines.length, m]);
		// `declare width: number` in an app class: the base's field, typed anew.
		if (!this.library && hasModifier(m, ts.SyntaxKind.DeclareKeyword)) return;
		const keyed = this.symbolMember(m.name);
		if (this.symbolKeyedFieldCode(k, m, keyed)) return;
		if (keyed) throw this.error(m.name, 'a field named by this symbol');
		const n = literalKey(m.name, this.checker) ?? m.name.getText();
		const t = this.states.lenientNullField(m) ? optionalType(this.typeOf(m.name)) : this.typeOf(m.name);
		if (isStatic(m)) this.staticFieldCode(k, m, n, t);
		else this.instanceFieldCode(k, m, n, t);
	},

	staticBlockCode(this: Translator, k: ClassParts, m: ts.ClassStaticBlockDeclaration): void {
		// `static { … }`: with the static initializers the module runs where the class is defined, in their order, or
		// where there are none, the companion's own initialization; `this` is the class.
		for (const t of thisNodes(m.body)) this.subst.set(t, k.name);
		const deferred = !!this.staticInits;
		const saved = this.indent;
		this.indent = deferred ? '    ' : '            ';
		let body: string[];
		try {
			body = this.statements([...m.body.statements]);
		} finally {
			this.indent = saved;
			for (const t of thisNodes(m.body)) this.subst.delete(t);
		}
		if (deferred) this.staticInits!.push(...body);
		else k.statics.push(`        init {\n${body.join('\n')}\n        }`);
	},

	symbolKeyedFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, keyed: { member: string; key: string | null; fixed: boolean; either: boolean } | null): boolean {
		const { lines, symbolFields } = k;
		if (keyed?.key && !isStatic(m)) {
			const t = this.typeOf(m.name);
			const key = keyed.fixed ? keyed.key : this.capturedSymbolKey(k, keyed.key);
			symbolFields.push({ key, fixed: keyed.fixed, either: keyed.either, maybeUndefined: keyed.key.includes('?: "undefined"'), member: keyed.member, type: t });
			lines.push(`    var ${keyed.member}: ${t} = ${m.initializer ? this.stored(m.initializer, m, t) : (this.zero(t) ?? 'null')}`);
			return true;
		}
		// `[Symbol.toStringTag] = 'TextDecoder'`: what Object.prototype.toString reports.
		if (keyed?.member === 'jsToStringTag' && !isStatic(m) && m.initializer) {
			k.supertypes.push('JSToStringTag');
			lines.push(`    override var jsToStringTag: String = ${this.stored(m.initializer, m, 'String')}`);
			return true;
		}
		// `static [native_];`: a static field of that symbol, unset.
		if (keyed?.key && isStatic(m)) {
			const t = optionalType(this.typeOf(m.name));
			this.indent = '        ';
			k.statics.push(`        @JvmStatic var ${keyed.member}: ${t} = ${m.initializer ? this.stored(m.initializer, m, t) : 'null'}`);
			this.indent = '    ';
			return true;
		}
		return false;
	},

	staticFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): void {
		const { name, statics } = k;
		const c = this.checker;
		this.indent = '        ';
		// An initializer reading changing state runs with the module's statements, where the class is defined; a companion's run when it is first used.
		if (m.initializer && this.staticInits && this.staticInModuleOrder(m)) {
			const st = isUntyped(spelledType(t)) || t.endsWith('?') || this.zero(t) ? t : optionalType(t);
			const ssym = c.getSymbolAtLocation(m.name);
			if (ssym && st !== t) this.nullableDecls.add(ssym);
			statics.push(`        var ${ident(n)}: ${st} = ${this.zero(t) ?? 'null'}`);
			this.indent = '    ';
			this.staticInits.push(`    ${name}.${ident(n)} = ${this.stored(m.initializer, m, t)}`);
			return;
		}
		const st = isUntyped(spelledType(t)) || t.endsWith('?') ? t : this.zero(t) || m.initializer ? t : optionalType(t);
		const ssym = c.getSymbolAtLocation(m.name);
		if (ssym && st !== t) this.nullableDecls.add(ssym);
		if (this.states.unsetNullStatic(m)) {
			const flag = writtenFlag(n);
			statics.push(`        var ${ident(n)}: ${st} = null\n            set(value) {\n                field = value\n                ${flag} = true\n            }`, `        var ${flag} = false`);
		} else statics.push(`        var ${ident(n)}: ${st} = ${m.initializer ? this.stored(m.initializer, m, t) : (this.zero(t) ?? 'null')}`);
		this.indent = '    ';
	},

	instanceFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): void {
		if (this.aliasedFieldCode(k, m, n)) return;
		if (this.wrappedFieldCode(k, m, n, t)) return;
		if (this.prototypeFieldCode(k, m, n, t)) return;
		this.ownFieldCode(k, m, n, t);
	},

	aliasedFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string): boolean {
		const { lines } = k;
		if (this.framework.memoized(m, this.checker)) {
			lines.push(...this.memoField(m, n));
			return true;
		}
		if (this.signalAlias(m)) {
			lines.push(`    val ${ident(n)}: ${this.typeOf(m.name)}`, `        get() = ${this.signalValue(m.initializer!)}`);
			return true;
		}
		if (!this.library && m.initializer && ts.isCallExpression(m.initializer) && ts.isPropertyAccessExpression(m.initializer.expression) && m.initializer.expression.name.text === 'asReadonly' && ['writable', 'computed'].includes(this.framework.signalKind(this.symbolName(m.initializer.expression.expression)) ?? '')) {
			lines.push(`    val ${ident(n)}: ${this.typeOf(m.name)}`, `        get() = ${this.expr(m.initializer.expression.expression)}.value`);
			return true;
		}
		const nativeProperty = this.nativePropertyOf(m);
		if (nativeProperty) {
			lines.push(nativeProperty);
			return true;
		}
		return false;
	},

	wrappedFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): boolean {
		const { cls, name, plugin, interfaceFields, lines, fields } = k;
		const c = this.checker;
		if (this.states.nullishHeld(m)) {
			const held = nullishType(t);
			fields.push({ name: n, type: held, at: m, ...(this.madeField(cls, n) ? { made: 'unset' as const } : {}) });
			lines.push(`    ${this.memberMods(k, n)}var ${ident(n)}: ${held} = JSNullish.Undefined`, ...this.keySetter(cls, n));
			if (m.initializer) {
				this.indent = '        ';
				lines.push('    init {', `        this.${ident(n)} = ${this.stored(m.initializer, m, held)}`, '    }');
				this.indent = '    ';
			}
			return true;
		}
		if (prototypeDecorated(this, m)) {
			// The decorators run where the module defines the class.
			if (!ts.isSourceFile(cls.parent) && !ts.isModuleBlock(cls.parent)) throw this.error(m, 'a field decorator in a class declared inside a function');
			const kt = isUntyped(spelledType(t)) || isNullable(t) ? t : optionalType(t);
			const dsym = c.getSymbolAtLocation(m.name);
			if (dsym && kt !== t) this.nullableDecls.add(dsym);
			const own = `__own_${n.replace(/\W/g, '_')}`;
			lines.push(`    private var ${own}: ${kt} = null`, `    private var ${own}_set = false`, `    ${this.memberMods(k, n)}var ${ident(n)}: ${kt}`, `        get() = if (${own}_set) ${own} else ${this.fromAnyCode(`JSPrototypes.value(this.javaClass, ${kotlinString(n)}, this)`, kt, true)}`, `        set(value) { val set = JSPrototypes.setter(this.javaClass, ${kotlinString(n)}); if (set != null) set(this, value) else { ${own} = value; ${own}_set = true } }`);
			if (m.initializer) {
				this.indent = '        ';
				lines.push('    init {', `        this.${ident(n)} = ${this.stored(m.initializer, m, t)}`, '    }');
				this.indent = '    ';
			}
			this.staticInits?.push(
				`    ${RT.jsDecorateField}(${name}::class.java, ${kotlinString(n)}, listOf(${ts
					.getDecorators(m)!
					.map((d) => this.decoratorValue(d.expression))
					.join(', ')}))`,
			);
			return true;
		}
		// A function field implementing a base method (`_handler = (args) => …` for `abstract _handler(arg)`): an override running the function.
		const implemented = !this.library && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)) ? this.inheritedMethod(cls, n) : undefined;
		if (implemented && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)) && implemented.parameters.length === m.initializer.parameters.length && m.initializer.parameters.every((p) => ts.isIdentifier(p.name))) {
			const fn = m.initializer;
			const ret = this.returnTypeOf(implemented);
			this.takeBaseNames(fn, this.paramNames(implemented));
			const params = implemented.parameters.map((p, k) => `${this.baseParamNames.get(fn.parameters[k]) ?? ident((fn.parameters[k].name as ts.Identifier).text)}: ${this.paramType(p)}`);
			lines.push(`    override fun ${this.methodIdent(n)}(${params.join(', ')})${ret === 'Unit' ? '' : `: ${ret}`} ${this.functionBody(fn, ret, '    ')}`);
			return true;
		}
		const sym = c.getSymbolAtLocation(m.name);
		const narrower = isUntyped(spelledType(t)) && !isStatic(m) ? interfaceFields.get(n) : undefined;
		if (narrower && !isUntyped(spelledType(narrower))) {
			const it = optionalType(narrower);
			fields.push({ name: n, type: it });
			lines.push(`    override var ${ident(n)}: ${it} = ${m.initializer ? this.stored(m.initializer, m, it) : 'null'}`);
			return true;
		}
		// The generated kit: a field only typed again (`nativeViewProtected: NativeButton`) is the kit class's, read as this one's type.
		if (this.kitRedeclared(m)) return true;
		// Library mode: a field a base class declares already (`nativeViewProtected: Toolbar` over `any`) is the base's, read as this one's type.
		const root = this.library || plugin ? this.redeclaredField(m) : null;
		if (root) {
			if (sym) this.nullableDecls.add(sym);
			if (m.initializer) {
				this.indent = '        ';
				lines.push('    init {', `        this.${ident(n)} = ${this.stored(m.initializer, m, t)}`, '    }');
				this.indent = '    ';
			}
			return true;
		}
		return false;
	},

	prototypeFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): boolean {
		const { cls, isView, lines, fields } = k;
		const sym = this.checker.getSymbolAtLocation(m.name);
		// Library mode: a field under a name core registers a property as (`col`, registered on View, declared on ViewBase), or one
		// `Object.defineProperty(X.prototype, …)` defines, is the accessor on the prototype chain. Undefined until set: only a
		// string, number or boolean reads as its zero.
		if (this.library && (this.properties?.isRegistered(cls, n) || this.properties?.isRegisteredAnywhere(n) || this.facts.prototypeKeys().accessors.has(n))) {
			const kt = isUntyped(spelledType(t)) || isNullable(t) || (this.zero(t) && !/^JS(Array|Map|Set|Record)</.test(t)) ? t : optionalType(t);
			if (sym && kt !== t) this.nullableDecls.add(sym);
			fields.push({ name: n, type: kt, expando: true });
			// A string property a template or script set to a number (`[text]="index + 1"`) reads as that number's string, as core's `text + ''` does.
			const read = kt === 'String' ? `${RT.jsStringOrEmpty}(${RT.jsExpandoGet}(this, ${kotlinString(n)}))` : this.fromAnyCode(`${RT.jsExpandoGet}(this, ${kotlinString(n)})`, kt, true);
			lines.push(`    ${this.memberMods(k, n)}var ${ident(n)}: ${kt}`, `        get() = ${read}`, `        set(value) { ${RT.jsExpandoSet}(this, ${kotlinString(n)}, value) }`);
			if (m.initializer) {
				this.indent = '        ';
				lines.push('    init {', `        this.${ident(n)} = ${this.stored(m.initializer, m, t)}`, '    }');
				this.indent = '    ';
			}
			return true;
		}
		// Library mode: a field `X.prototype.name = v` gives a value, which reads through the prototype chain until the instance has its own.
		if (this.library && !m.initializer && this.facts.prototypeKeys().data.has(n) && !this.prototypeDefaulted().has(m)) {
			const kt = isUntyped(spelledType(t)) || isNullable(t) ? t : optionalType(t);
			if (sym && kt !== t) this.nullableDecls.add(sym);
			const own = `__own_${n.replace(/\W/g, '_')}`;
			const made = this.madeBitOf(cls, n);
			fields.push({ name: n, type: kt, ...(made ? { made: 'inherited' as const } : {}) });
			lines.push(`    private var ${own}: ${kt} = null`, `    private var ${own}_set = false`, `    ${this.memberMods(k, n)}var ${ident(n)}: ${kt}`, `        get() = if (${own}_set) ${own} else ${this.fromAnyCode(isFunctionType(kt.replace(/^\((.*)\)\?$/, '$1')) ? `${RT.jsBoundTo}(JSPrototypes.value(this.javaClass, ${kotlinString(n)}, this), this)` : `JSPrototypes.value(this.javaClass, ${kotlinString(n)}, this)`, kt, true)}`, `        set(value) { ${own} = value; ${own}_set = true${made ? `; jsMadeNote${made.word}(1L shl ${made.bit}, ${kotlinString(n)})` : ''} }`);
			return true;
		}
		if (isView && !!this.properties?.isRegistered(cls, n)) {
			// A field under a registered property's name is the property: core's accessor on the prototype.
			const kt = isUntyped(spelledType(t)) || t.endsWith('?') ? t : optionalType(t);
			if (sym && kt !== t) this.nullableDecls.add(sym);
			lines.push(`    ${this.memberMods(k, n)}var ${ident(n)}: ${kt}`, `        get() = ${this.fromAnyCode(`get(${kotlinString(n)})`, kt)}`, `        set(value) { set(${kotlinString(n)}, value) }`);
			if (m.initializer) {
				this.indent = '        ';
				lines.push('    init {', `        this.${ident(n)} = ${this.stored(m.initializer, m, t)}`, '    }');
				this.indent = '    ';
			}
			return true;
		}
		return false;
	},

	ownFieldCode(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): void {
		const { cls, layout, plugin, overridden, literalMade, lines, fields } = k;
		const sym = this.checker.getSymbolAtLocation(m.name);
		// A field no subclass redeclares is a JVM field: its accessors would clash with methods of the same JVM names (`tag` and `getTag()`).
		// A field whose writes note its key has a setter, which a JVM field can't: its accessors are named apart, as a JVM field's would clash.
		const fieldMods = overridden.has(n) ? 'override ' : this.subclassFields(cls).has(n) ? 'open ' : plugin ? (this.madeField(cls, n) ? `@get:JvmName("__get_${n}") @set:JvmName("__set_${n}") ` : '@JvmField ') : this.memberMods(k, n);
		const nullInit = !!m.initializer && (m.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(m.initializer) && m.initializer.text === 'undefined'));
		// A field of a class with no base that something may read before the constructor assigns it (see `definitelyAssignedFields`).
		const readEarly = !m.initializer && !this.library && !cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) && !this.facts.definiteFields(cls).has(m) && this.deferredDeclaration('x', t).startsWith('lateinit ');
		// A field whose writes note its key has a setter, which `lateinit` can't.
		const setter = this.keySetter(cls, n);
		const lateSetter = setter.length > 0 && !m.initializer && this.deferredDeclaration('x', t).startsWith('lateinit ');
		// A made field the prototype gives a value (`prototypeDefaults`) starts with it as its declared value, which notes no key.
		const protoDefault = this.madeField(cls, n) ? (this.prototypeDefaults().get(cls) ?? []).find((d) => d.field === m) : undefined;
		const made = this.madeField(cls, n) ? { made: protoDefault ? ('inherited' as const) : ('unset' as const) } : {};
		if ((plugin || readEarly || lateSetter || (!m.initializer && chainedThrough(cls, n))) && (nullInit || !m.initializer) && !isNullable(t) && !isUntyped(spelledType(t)) && t !== 'Unit') {
			// Unset (or `null`) in code checked without strictNullChecks: nullable, unwrapped where it is read.
			if (sym) this.nullableDecls.add(sym);
			fields.push({ name: n, type: optionalType(t), at: m, ...made });
			lines.push(`    ${fieldMods}var ${ident(n)}: ${optionalType(t)} = ${protoDefault ? this.coerce(protoDefault.value, t) : 'null'}`, ...setter);
			return;
		}
		fields.push({ name: n, type: t, at: m, ...made });
		// Read early by a base class's constructor: null (undefined) until the class's own initialization sets it.
		if (m.initializer && fieldMods !== '@JvmField ' && this.earlyField(m)) {
			const backing = earlyBacking(n);
			lines.push(`    var ${backing}: ${t}? = ${this.stored(m.initializer, m, t)}`, `    ${fieldMods}var ${ident(n)}: ${t}`, `        get() = ${this.undefinedAs(backing, t)}`, setter.length ? setter[0].replace('field = value', `${backing} = value`) : `        set(value) { ${backing} = value }`);
			return;
		}
		if (m.initializer && (layout.initializersAfterParamProps.includes(m) || (literalMade && !this.pure(m.initializer)))) {
			lines.push(`    ${fieldMods}var ${ident(n)}: ${t} = ${this.zero(t) ?? `${RT.jsUncheckedNull}<${t}>()`}`, ...setter);
			this.indent = '        ';
			k.initsAfterParamProps.push(`        this.${ident(n)} = ${this.stored(m.initializer, m, t)}`);
			this.indent = '    ';
		} else if (m.initializer) lines.push(`    ${fieldMods}var ${ident(n)}: ${t} = ${this.stored(m.initializer, m, t)}`, ...setter);
		// A non-strict app's array, map or set field holds undefined until given one.
		else if (this.lenientApp && !this.library && /^JS(Array|Map|Set)</.test(t)) lines.push(`    ${fieldMods}var ${ident(n)}: ${t} = ${RT.jsUncheckedNull}<${t}>()`, ...setter);
		else if (protoDefault) lines.push(`    ${fieldMods}var ${ident(n)}: ${t} = ${this.coerce(protoDefault.value, t)}`, ...setter);
		else {
			const d = this.deferredDeclaration(ident(n), t);
			lines.push(`    ${d.startsWith('lateinit') && fieldMods === '@JvmField ' ? '' : fieldMods}${d}`, ...setter);
		}
	},

	optionalMemberFieldsCode(this: Translator, k: ClassParts): void {
		const { cls, overridden } = k;
		if (!this.library)
			for (const m of implementedOptionalMembers(cls, this.checker)) {
				const n = m.name.text,
					t = optionalType(this.typeOf(m));
				k.fields.push({ name: n, type: t });
				k.lines.push(`    ${overridden.has(n) ? 'override ' : this.subclassFields(cls).has(n) ? 'open ' : ''}var ${ident(n)}: ${t} = null`, ...this.keySetter(cls, n));
			}
	},

	fieldDocsCode(this: Translator, k: ClassParts): void {
		const { lines, fieldStarts } = k;
		fieldStarts.forEach(([at], k) => {
			if ((fieldStarts[k + 1]?.[0] ?? lines.length) > at) fieldStarts[k][0] = -1 - at;
		});
		for (const [at, m] of fieldStarts.reverse()) {
			const doc = at < 0 ? this.docOf(m, '    ') : '';
			if (doc) lines.splice(-1 - at, 0, `    ${doc.trimEnd()}`);
		}
	},

	prototypeDefaultsCode(this: Translator, k: ClassParts): void {
		const { cls } = k;
		const defaults = (this.prototypeDefaults().get(cls) ?? []).filter((d) => !this.madeField(cls, d.field.name.getText()));
		if (defaults.length) {
			this.indent = '        ';
			k.lines.push('    init {', ...defaults.map((d) => `        this.${ident(d.field.name.getText())} = ${this.coerce(d.value, this.typeOf(d.field.name))}`), '    }');
			this.indent = '    ';
		}
	},
};
