// A class declaration's fields as Swift: parameter properties, instance, static and symbol-keyed fields, and the optional members an interface declares.
import ts from 'typescript';
import { ident, isFunctionType, isOptional, metatype, nullishType, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import { implementedOptionalMembers } from '../semantics/shapes.ts';
import { refersToThis } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { overAbstractOnly, prototypeDecorated, readEarly } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { writtenFlag } from '../semantics/states/lenient.ts';
import { prototypeReadSite } from '../semantics/read-sites.ts';

export const classFieldsMethods = {
	parameterPropertyFields(this: Translator, k: ClassParts): void {
		this.indent = '    ';
		for (const p of k.layout.paramProps) {
			const n = (p.name as ts.Identifier).text;
			const t = this.typeOf(p.name);
			const root = this.redeclaredField(p);
			// An optional parameter's property holds undefined: lenient code reads it as its type, the field's value before it is set.
			const omitted = !!p.questionToken && !isOptional(t) && !isUntyped(spelledType(t));
			const decl = omitted || this.lenient ? (this.lenient ? this.fieldType(t) : optionalType(t)) : this.deferred(t);
			const held = omitted && !p.initializer ? /^(.*?) = (.*)$/.exec(decl) : null;
			const unset = held && !/[?!]$/.test(held[1]) ? held[2] : undefined;
			if (!root) {
				k.lines.push(`    var ${ident(n)}: ${decl}`);
				this.declare(n, { kind: 'var', type: decl });
				k.fields.push({ name: n, type: t });
			}
			const val = unset ? `(${ident(n)} ?? ${unset})` : this.states.nullishHeld(p) ? `${ident(n)}.${isUntyped(spelledType(t)) ? 'jsAny' : 'optional'}` : ident(n);
			k.paramPropValues.set(p, root ? this.convert(val, t, this.redeclaredType(root)) : val);
		}
	},

	fieldMember(this: Translator, k: ClassParts, m: ts.ClassElement): void {
		if (ts.isClassStaticBlockDeclaration(m)) {
			this.staticBlock(m, k.name);
			return;
		}
		if (!ts.isPropertyDeclaration(m)) return;
		const keyed = this.symbolMember(m.name);
		if (keyed) return this.symbolKeyedField(k, m, keyed);
		const n = this.staticName(m) ?? m.name.getText();
		const t = this.typeOf(m.name);
		if (isStatic(m)) this.staticField(k, m, n, t);
		else this.instanceField(k, m, n, t);
	},

	symbolKeyedField(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, keyed: { member: string; key: string | null; fixed: boolean; of: ts.Expression | null }): void {
		const { lines } = k;
		if (keyed.key && !isStatic(m)) {
			const t = this.typeOf(m.name);
			const key = keyed.fixed || !keyed.of ? keyed.key : this.storedSymbolKey(k, keyed.of, keyed.key);
			k.symbolFields.push({ key, member: keyed.member, type: t });
			lines.push(`    var ${keyed.member}: ${this.deferred(t)}`);
			this.declare(keyed.member, { kind: 'var', type: this.deferred(t) });
			if (m.initializer) {
				this.indent = '        ';
				k.fieldInits.push(`        self.${keyed.member} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, t))}`);
				this.indent = '    ';
			}
			return;
		}
		// `[Symbol.toStringTag] = 'TextDecoder'`: what Object.prototype.toString reports.
		if (keyed.member === 'jsToStringTag' && !isStatic(m) && m.initializer) {
			// Over a base's own tag (`File` over `Blob`): the base's property, set as the class's fields are.
			if (this.redeclaredField(m)) {
				k.fieldInits.push(`        self.jsToStringTag = ${this.stored(m.initializer, m, 'String')}`);
				return;
			}
			k.conformances.push('JSToStringTag');
			lines.push(`    var jsToStringTag: String = ${this.stored(m.initializer, m, 'String')}`);
			this.declare('jsToStringTag', { kind: 'var', type: 'String' });
			return;
		}
		// `static [native_];`: the class's own property under a symbol, undefined until set.
		if (keyed.key && isStatic(m) && !m.initializer) {
			const t = this.typeOf(m.name);
			// Read where its type says present, as a static named field is.
			const held = isOptional(t) || this.zero(t) !== null ? optionalType(t) : isFunctionType(t) ? `(${t})!` : `${t}!`;
			lines.push(`    static var ${keyed.member}: ${held} = nil`);
			this.declare(keyed.member, { kind: 'var', mods: 'static ', type: held });
			return;
		}
		throw this.error(m.name, 'a field named by this symbol');
	},

	staticField(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): void {
		const { lines } = k;
		const nullInit = !!m.initializer && (m.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(m.initializer) && m.initializer.text === 'undefined'));
		const staticVar = (type: string) => this.declare(n, { kind: 'var', mods: 'static ', type });
		if (nullInit && !isOptional(t) && this.zero(t) === null) {
			lines.push(`    static var ${ident(n)}: ${this.deferred(t)} = nil`);
			staticVar(this.deferred(t));
			return;
		}
		if (!m.initializer && !isOptional(t) && this.zero(t) === null) {
			lines.push(`    static var ${ident(n)}: ${this.deferred(t)}`);
			staticVar(this.deferred(t));
			return;
		}
		// A static initializer that throws or reads changing state runs with the module's statements, where the class is defined; Swift's run lazily and cannot throw.
		if (m.initializer && this.staticInits && !nullInit && this.staticInModuleOrder(m)) {
			lines.push(`    static var ${ident(n)}: ${this.deferred(t)}`);
			staticVar(this.deferred(t));
			this.indent = '    ';
			this.staticInits.push(`    ${ident(k.name)}.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, t))}`);
			return;
		}
		const st = this.lenient ? this.lenientRef(t) : t;
		if (this.states.unsetNullStatic(m)) {
			const flag = writtenFlag(n);
			lines.push(`    static var ${ident(n)}: ${st} { didSet { ${flag} = true } }`, `    static var ${flag} = false`);
			staticVar(st);
			this.declare(flag, { kind: 'var', mods: 'static ', type: 'Bool' });
			return;
		}
		lines.push(`    static var ${ident(n)}: ${st}${m.initializer ? ` = ${this.storedInit(m.initializer, st, false, m)}` : isOptional(st) ? '' : ` = ${this.zero(t) ?? 'nil'}`}`);
		staticVar(st);
	},

	instanceField(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): void {
		if (this.aliasedField(k, m, n, t)) return;
		if (this.wrappedField(k, m, n, t)) return;
		if (this.prototypeField(k, m, n, t)) return;
		this.ownField(k, m, n, t);
	},

	aliasedField(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): boolean {
		const { lines } = k;
		if (this.framework.memoized(m, this.checker)) {
			lines.push(...this.memoField(m, n));
			return true;
		}
		const aliased = this.moduleComputedField(m);
		if (aliased) {
			lines.push(aliased);
			return true;
		}
		if (m.initializer && ts.isCallExpression(m.initializer) && ts.isPropertyAccessExpression(m.initializer.expression) && ts.isPropertyAccessExpression(m.initializer.expression.expression) && /\.asReadonly$/.test(this.calleeName(m.initializer))) {
			lines.push(`    var ${ident(n)}: ${t.replace(/^Signal<(.*)>$/, '$1')} { ${this.expr(m.initializer.expression.expression)}.value }`);
			return true;
		}
		const nativeProperty = this.nativePropertyOf(m);
		if (nativeProperty) {
			lines.push(nativeProperty);
			this.declare(n, { kind: 'var', type: optionalType(t) });
			return true;
		}
		return false;
	},

	wrappedField(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): boolean {
		const { cls, lines, fieldInits } = k;
		if (this.states.nullishHeld(m)) {
			const held = nullishType(t);
			k.fields.push({ name: n, type: held, at: m, ...(this.madeField(cls, n) ? { made: 'unset' as const } : {}) });
			this.declare(n, { kind: 'var', type: held });
			lines.push(`    var ${ident(n)}: ${held} = nil${this.keyObservers(cls, n)}`);
			if (m.initializer) {
				this.indent = '        ';
				fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, held))}`);
				this.indent = '    ';
			}
			return true;
		}
		// A view class narrowing its native view's type (`nativeViewProtected: CHIBasePageControl`) reads the kit's `nativeView`.
		if (k.isView && !m.initializer && ['nativeViewProtected', 'ios'].includes(m.name.getText())) {
			const native = t.replace(/[?!]$/, '');
			lines.push(`    var ${ident(n)}: ${native}! { nativeView as? ${native} }`);
			this.declare(n, { kind: 'var', type: `${native}!` });
			return true;
		}
		// A plugin's field with no value over a kit property (`borderRadius: number` on its view): only a type, as its
		// build defines no fields on the instance; the kit's property, read as that type.
		const typeOnly = !m.initializer && this.pluginFiles.has(cls.getSourceFile().fileName) ? this.kitRedeclared(m) : null;
		if (typeOnly && !typeOnly.same) {
			lines.push(`    var ${ident(n)}: ${t} {`, `        get { ${this.convert(`self.${ident(m.name.getText())}`, typeOnly.type, t)} }`, `        set { self.${ident(m.name.getText())} = ${this.convert('newValue', t, typeOnly.type)} }`, '    }');
			this.declare(n, { kind: 'var', type: t });
			return true;
		}
		if (prototypeDecorated(this, m)) {
			// The decorators run where the module defines the class.
			if (!ts.isSourceFile(cls.parent) && !ts.isModuleBlock(cls.parent)) throw this.error(m, 'a field decorator in a class declared inside a function');
			const ot = optionalType(t);
			const own = `__own_${n.replace(/\W/g, '_')}`;
			const read = `JSPrototypes.value(type(of: self), ${swiftString(n)}, self)`;
			lines.push(`    var ${own}: Optional<${ot}> = nil`, `    var ${ident(n)}: ${ot} {`, `        get { if let v = ${own} { return v }; return ${this.fromAnyCode(read, ot)} }`, `        set { if let set = JSPrototypes.setter(type(of: self), ${swiftString(n)}) { ${RT.jsReport} { try set(self, ${this.convert('newValue', ot, 'Any?')}) } } else { ${own} = .some(newValue) } }`, '    }');
			this.declare(own, { kind: 'var', type: `Optional<${ot}>` });
			this.declare(n, { kind: 'var', type: ot });
			if (m.initializer) {
				this.indent = '        ';
				fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, ot))}`);
				this.indent = '    ';
			}
			return true;
		}
		// A field its base declares already (`nativeViewProtected: UIView` over `any`): the base's, read as this field's type.
		const root = this.redeclaredField(m);
		// Over an accessor its bases only declare abstract: a value of the class's own behind the accessor, unset until the
		// initializer runs.
		if (root && ts.isAccessor(root) && overAbstractOnly(m, this.checker)) {
			const declared = this.lenientRef(this.redeclaredType(root));
			const own = `__own_${n.replace(/\W/g, '_')}`;
			lines.push(`    var ${own}: Optional<${declared}> = nil`, `    override var ${ident(n)}: ${declared} {`, `        get { ${own} ?? ${this.undefinedValue(declared) ?? `${RT.jsNativeZero}(${metatype(declared)})`} }`, `        set { ${own} = .some(newValue) }`, '    }');
			this.declare(own, { kind: 'var', type: `Optional<${declared}>` });
			this.declare(n, { kind: 'var', mods: 'override ', type: declared });
			k.fields.push({ name: n, type: declared, at: m });
			if (m.initializer) {
				this.indent = '        ';
				fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, declared))}`);
				this.indent = '    ';
			}
			return true;
		}
		const kitOver = this.kitRedeclared(m);
		if (root || kitOver?.same) {
			if (root && overAbstractOnly(m, this.checker)) k.fields.push({ name: n, type: this.redeclaredType(root), at: m });
			if (m.initializer) {
				this.indent = '        ';
				fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, root ? this.redeclaredType(root) : kitOver!.type))}`);
				this.indent = '    ';
			}
			return true;
		}
		return false;
	},

	/** The static a read of field `n` through the prototype chain keeps what it found in (`prototypeReadSite`); null where there is none, or the class is generic and holds no static. */
	readSite(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string): string | null {
		if (!prototypeReadSite(m) || this.generics(k.cls)) return null;
		const site = `jsSite_${k.name.replace(/\W/g, '_')}_${n.replace(/\W/g, '_')}`;
		k.lines.push(`    private static let ${site} = JSReadSite(${swiftString(n)})`);
		return `${ident(k.name)}.${site}`;
	},

	prototypeField(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): boolean {
		const { cls, appBase, lines, fieldInits } = k;
		// Library mode: a field under a name some class registers a property as (`col`, registered on View, declared on ViewBase) reads through the prototype chain.
		const registeredName = !!this.library && (!!this.properties?.isRegistered(cls, n) || !!this.properties?.isRegisteredAnywhere(n));
		const keys = this.library && !m.initializer && !registeredName ? this.facts.prototypeKeys() : null;
		if (keys?.data.has(n) && !keys.accessors.has(n)) {
			// A field `Cls.prototype.name = v` writes: the instance's own value once it has one, else its prototype chain's.
			if (this.baseDeclares(appBase, n)) return true;
			const z = isFunctionType(t) ? null : this.zero(t);
			const vt = isOptional(t) || (z && !(this.lenient && this.nullableRef(t) !== t)) ? t : this.lenient ? optionalType(t) : isFunctionType(t) ? `(${t})!` : `${t}!`;
			const stored = isOptional(t) || (z && !isOptional(vt)) ? t : optionalType(t);
			const read = `JSPrototypes.value(type(of: self), ${this.readSite(k, m, n) ?? swiftString(n)}, self)`;
			const own = `__own_${n.replace(/\W/g, '_')}`;
			const inherited = this.reportedRead(z ? this.fromAnyCodeValue(read, t, true) : this.fromAnyValue(read, stored), this.getterSlot(z ? t : stored));
			this.declare(own, { kind: 'var', type: `Optional<${stored}>` });
			this.declare(n, { kind: 'var', type: vt });
			const made = this.madeField(cls, n);
			lines.push(`    var ${own}: Optional<${stored}> = nil`, `    var ${ident(n)}: ${vt} {`, `        get { if let v = ${own} { return v }; return ${z && inherited.startsWith(`(${RT.jsReported}`) ? `${inherited} ?? ${z}` : inherited} }`, `        set { ${own} = .some(newValue)${made ? `; ${this.madeNote(cls, n)}` : ''} }`, '    }');
			k.fields.push({ name: n, type: t, ...(made ? { made: 'inherited' as const } : {}) });
			return true;
		}
		if (keys?.accessors.has(n) && this.baseDeclares(appBase, n)) return true;
		if (this.library && (registeredName || keys?.accessors.has(n))) {
			// A field under a registered property's name is the accessor `register` defines on the prototype.
			// Undefined until set, an array included (`if (!this.items)`): only a string, number or boolean reads as its zero.
			const unset = !t.endsWith('?') && !t.endsWith('!') && (this.zero(t) === null || /^JS(Array|Map|Set)</.test(t)) && !isFunctionType(t);
			const vt = unset ? optionalType(t) : t;
			this.declare(n, { kind: 'var', type: unset && this.lenient ? this.lenientRef(t) : vt });
			const site = this.readSite(k, m, n);
			lines.push(`    var ${ident(n)}: ${unset && this.lenient ? this.lenientRef(t) : vt} {`, `        get { ${this.reportedRead(this.fromAnyCodeValue(`${RT.jsExpandoGet}(self, ${site ?? swiftString(n)})`, vt, true), this.getterSlot(vt))} }`, `        set { ${RT.jsExpandoSet}(self, ${swiftString(n)}, ${this.convert('newValue', vt, 'Any?')}) }`, '    }');
			if (m.initializer) {
				this.indent = '        ';
				fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, t))}`);
				this.indent = '    ';
			}
			return true;
		}
		if (k.isView && !!this.properties?.isRegistered(cls, n)) {
			// A field under a registered property's name is the property: core's accessor on the prototype.
			// A property registered without a default is undefined until set: an object-typed one, an array included, reads as nil.
			const unset = !t.endsWith('?') && !t.endsWith('!') && (this.zero(t) === null || /^JS(Array|Map|Set)</.test(t)) && !isFunctionType(t);
			// Core's `set` runs the property's change handlers, whose errors are reported as core reports them.
			if (this.declOwner) this.declarations?.names(this.declOwner, [n]);
			this.declare(n, { kind: 'var', type: unset ? (this.lenient ? optionalType(t) : `${t}!`) : t });
			lines.push(`    var ${ident(n)}: ${unset ? (this.lenient ? optionalType(t) : `${t}!`) : t} {`, `        get { ${this.fromAnyCode(this.library ? `get(${swiftString(n)})` : `(${RT.jsReported} { try get(${swiftString(n)}) } ?? nil)`, unset ? optionalType(t) : t, true)} }`, `        set { ${RT.jsReport} { try set(${swiftString(n)}, ${this.convert('newValue', unset ? optionalType(t) : t, 'Any?')}) } }`, '    }');
			if (m.initializer) {
				this.indent = '        ';
				fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, t))}`);
				this.indent = '    ';
			}
			return true;
		}
		return false;
	},

	ownField(this: Translator, k: ClassParts, m: ts.PropertyDeclaration, n: string, t: string): void {
		const { cls, lines, fieldInits } = k;
		// A field of a type the OS has only from a newer version (`controller: UIArrangementViewController`): held as an object, typed where the OS has it.
		const needs = this.gatedFields.get(m) ?? this.fieldAvailability(m);
		if (needs && (!m.initializer || m.initializer.kind === ts.SyntaxKind.NullKeyword)) {
			this.gatedFields.set(m, needs);
			const held = t.replace(/[?!]$/, '');
			lines.push(`    private var __gated_${n}: AnyObject?`, `    @available(iOS ${needs}, *) var ${ident(n)}: ${held}? { get { __gated_${n} as? ${held} } set { __gated_${n} = newValue } }`);
			this.declare(n, { kind: 'var', type: `${held}?`, available: needs });
			return;
		}
		// A field of its own beside the kit's property of its name: script reads the property by that name, the kit's.
		const own: ClassParts['fields'][number] | undefined = this.kitRedeclared(m) ? undefined : { name: n, type: t, at: m, ...(this.madeField(cls, n) ? { made: 'unset' as const } : {}) };
		if (own) k.fields.push(own);
		// A field held implicitly unwrapped where its type has a zero (a non-strict app's array): undefined is stored as nil.
		const heldAs = (h: string) => {
			if (own && h === `${t}!` && this.zero(t) !== null) own.type = optionalType(t);
			return h;
		};
		// `field: string = null` in code checked without strictNullChecks: unset, read as the type's zero or an unwrapped nil.
		if (m.initializer && (m.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(m.initializer) && m.initializer.text === 'undefined')) && !isOptional(t)) {
			lines.push(`    var ${ident(n)}: ${heldAs(this.fieldType(t))}`);
			this.declare(n, { kind: 'var', type: this.fieldType(t) });
			return;
		}
		// Read before it is set (`readEarly`): undefined until the class's own initialization, which runs after its base's;
		// a string, number or boolean beside an optional held until then, which reads it as its type does undefined.
		const early = !!m.initializer && readEarly(m, this) && !overAbstractOnly(m, this.checker);
		const undefinedAs = early ? this.undefinedValue(t) : null;
		if (undefinedAs && undefinedAs !== 'nil') {
			const backing = `__early_${n.replace(/\W/g, '_')}`;
			lines.push(`    var ${backing}: Optional<${t}> = nil${this.keyObservers(cls, n)}`, `    var ${ident(n)}: ${t} { get { ${backing} ?? ${undefinedAs} } set { ${backing} = .some(newValue) } }`);
			this.declare(backing, { kind: 'var', type: `Optional<${t}>` });
			this.declare(n, { kind: 'var', type: t });
			this.indent = '        ';
			fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer!), this.stored(m.initializer!, m, t))}`);
			this.indent = '    ';
			return;
		}
		if (m.initializer && !early && this.pure(m.initializer) && !refersToThis(m.initializer) && !this.throwsInfo.expr(m.initializer)) {
			lines.push(`    var ${ident(n)}: ${this.lenientRef(t)} = ${this.storedInit(m.initializer, t, false, m)}${this.keyObservers(cls, n)}`);
			this.declare(n, { kind: 'var', type: this.lenientRef(t) });
			return;
		}
		// A field the constructor assigns before anything can read it holds its type, not an implicitly unwrapped one.
		const deferred = this.fieldType(t);
		const held = heldAs(deferred.endsWith('!') && !m.initializer && this.facts.definiteFields(cls).has(m) ? t : deferred);
		this.declare(n, { kind: 'var', type: held });
		lines.push(`    ${this.weak.fields.has(`${cls.name?.text}.${n}`) && /^[A-Z][\w.]*[!?]$/.test(held) ? 'weak ' : ''}var ${ident(n)}: ${held}${own || !this.madeField(cls, n) ? this.keyObservers(cls, n) : ''}`);
		if (m.initializer) {
			this.indent = '        ';
			fieldInits.push(`        self.${ident(n)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, t))}`);
			this.indent = '    ';
		}
	},

	optionalMemberFields(this: Translator, k: ClassParts): void {
		if (!this.library)
			for (const m of implementedOptionalMembers(k.cls, this.checker)) {
				const n = m.name.text,
					t = optionalType(this.typeOf(m));
				k.fields.push({ name: n, type: t });
				this.declare(n, { kind: 'var', type: t });
				k.lines.push(`    var ${ident(n)}: ${t}${this.keyObservers(k.cls, n)}`);
			}
	},
};
