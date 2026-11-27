// A class declaration's accessors as Swift: each get/set pair as one property, its setter, and its entry by name.
import ts from 'typescript';
import { ident, isOptional, metatype, optionalType, swiftString, throwingGetter, throwingSetter, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import type { AccessorPair } from '../semantics/class-plan.ts';
import { getterOnlyOverride, isStatic } from '../semantics/throws.ts';
import { isKit, spelledType } from '../semantics/types.ts';

export const classAccessorsMethods = {
	accessorMembers(this: Translator, k: ClassParts): void {
		const accessors = new Map(this.accessorPairs(k.cls));
		if (accessors.has('jsToStringTag')) k.conformances.push('JSToStringTag');
		// An array's own `length` (a Set's or Map's `size`) shadows an accessor of that name on its class's prototype, which never runs.
		if (k.collection) accessors.delete(isKit(spelledType(k.collection), 'JSArray') ? 'length' : 'size');
		for (const [n, a] of accessors) this.accessorMember(k, n, a);
	},

	accessorMember(this: Translator, k: ClassParts, n: string, a: AccessorPair): void {
		const { cls, kitRoot, lines } = k;
		const { inherited } = k.layout;
		// A static accessor pair that reads and writes a base class's static field of its name: the field, which Swift's subclass inherits.
		if (a.get && isStatic(a.get) && this.forwardsToBaseStatic(cls, n, a)) return;
		// A property with only a setter reads as undefined in JavaScript.
		// An override that narrows its type (`get ios(): UIColor` over `get ios(): any`) keeps the type it overrides, as Swift requires.
		const ownType = a.get ? this.returnTypeOf(a.get) : optionalType(this.typeOf(a.set!.parameters[0].name));
		// Over a kit property of the name (`set width(value)` over core's `width`): the kit's type.
		const kitVar = kitRoot && !(a.get ?? a.set)!.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) ? this.core.kitMember(kitRoot, n) : null;
		const overKit = kitVar?.kind === 'var' && !inherited.has(n);
		const t = (a.get && this.narrowedFrom(a.get)) ?? (overKit && kitVar!.type !== ownType ? kitVar!.type : ownType);
		// Library mode: a class's static accessors are `class` ones, which a subclass's can override.
		const mods = `${a.get && isStatic(a.get) ? (this.library ? 'class ' : 'static ') : ''}${inherited.has(n) || overKit ? 'override ' : ''}`;
		const declared = a.get && this.inNativeClass(a.get) ? t : this.lenientRef(t);
		if (!(a.get ?? a.set)!.body) {
			// An abstract accessor is no property in JavaScript: it reads undefined, and a write sets nothing a subclass reads.
			lines.push(`    ${mods}var ${ident(n)}: ${declared} { get { ${this.undefinedValue(declared) ?? `${RT.jsNativeZero}(${metatype(declared)})`} }${a.set ? ' set {}' : ''} }`);
			this.declare(n, { kind: 'var', mods, type: declared });
			return;
		}
		const parts: string[] = [];
		// A getter over a base's field, which Swift's override must keep writable: writing it does nothing, as it sets no own property.
		const ignoredSet = !a.set && !!a.get && !isStatic(a.get) && inherited.has(n) && this.baseHasField(cls, n);
		// What an accessor of a pair throws is reported, as the JavaScript runtime reports what nothing catches; Swift's setters cannot throw.
		const reported = ((!!a.set || ignoredSet) && ((!!a.get && this.throwsInfo.fn(a.get)) || (!!a.set && this.throwsInfo.fn(a.set)))) || (!!a.get && !isStatic(a.get) && k.required.has(n) && this.throwsInfo.fn(a.get));
		if (a.get && reported && this.throwsInfo.fn(a.get)) {
			// An implicitly unwrapped property's getter gives nothing where it throws, or where it gives nothing.
			const got = declared.endsWith('!') ? declared.replace(/!$/, '?') : isOptional(declared) ? declared : t;
			const fallback = isOptional(got) ? 'nil' : (this.zero(t) ?? null);
			const or = fallback ?? `${RT.jsNativeZero}(${metatype(got)})`;
			if (this.throwingBodyOf(a.get)) {
				const method = throwingGetter(n);
				const ret = declared.endsWith('!') ? declared : got;
				const gmods = isStatic(a.get) ? 'static ' : this.baseThrowingBody(cls, n, ts.SyntaxKind.GetAccessor) ? 'override ' : '';
				this.declare(method, { kind: 'func', mods: gmods, params: '', type: ret, throws: true });
				lines.push(`    ${gmods}func ${method}() throws -> ${ret} ${this.functionBody(a.get, got, '    ')}`);
				parts.push(`        get { ${RT.jsReported} { try self.${method}() } ?? ${or} }`);
			} else parts.push(`        get { ${RT.jsReported} { () throws -> ${got} in${this.functionBody(a.get, got, '        ').slice(1)} ?? ${or} }`);
		} else if (a.get) parts.push(`        get${this.throwsInfo.fn(a.get) ? ' throws' : ''} ${this.functionBody(a.get, t, '        ')}`);
		else parts.push('        get { nil }');
		const getterOnly = ignoredSet && getterOnlyOverride(a.get!, this.checker);
		const refused = `throw ${RT.jsGetterOnlyWrite}(${swiftString(cls.name?.text ?? '')}, ${swiftString(n)})`;
		if (getterOnly) {
			parts.push(`        set { ${RT.jsReport} { ${refused} } }`);
			if (this.baseThrowingBody(cls, n, ts.SyntaxKind.SetAccessor)) {
				const method = throwingSetter(n);
				this.declare(method, { kind: 'func', mods: 'override ', params: `_ newValue: ${declared}`, type: 'Void' });
				lines.push(`    override func ${method}(_ newValue: ${declared}) throws { ${refused} }`);
			}
		} else if (ignoredSet) parts.push('        set {}');
		const anySetter = !!a.set && this.setterTakesAny(a.set);
		if (a.set) this.accessorSetter(k, n, a, { t, declared, reported, anySetter }, parts);
		lines.push(`    ${mods}var ${ident(n)}: ${declared} {`, ...parts, '    }');
		this.declare(n, { kind: 'var', mods, type: declared, throws: !!a.get && !reported && this.throwsInfo.fn(a.get) });
		// A plugin's objects are read untyped too (`navigator.gpu.native`): their accessors by name.
		const own = (a.get ?? a.set)!;
		if ((this.byNameAccessor(cls, own) || k.droppedProtocolMembers.has(n)) && !ts.isPrivateIdentifier(own.name)) {
			const getThrows = !!a.get && this.throwsInfo.fn(a.get) && !reported;
			const read = getThrows ? this.marks.orNil(`${RT.jsReported} { try self.${ident(n)} }`) : `self.${ident(n)}`;
			const stored = () => (declared.endsWith('!') ? this.fromAny('newValue', declared.replace(/!$/, '?')) : isKit(spelledType(declared), 'JSNullish') ? `(${RT.jsConverted}(newValue, to: ${declared}.self) ?? nil)` : this.fromAnyCode('newValue', declared, true));
			const set = getterOnly ? `${RT.jsWriting} { ${refused} }` : anySetter ? `self.__set_${n.replace(/\W/g, '_')}(newValue)` : a.set && this.throwingBodyOf(a.set) ? `${RT.jsWriting} { try self.${throwingSetter(n)}(${stored()}) }` : a.set ? `self.${ident(n)} = ${stored()}` : null;
			k.dynAccessors.push({ name: n, get: a.get ? this.convert(read, getThrows ? optionalType(declared.replace(/!$/, '?')) : declared, 'Any?') : null, set });
		}
	},

	/** An accessor pair's setter: its part of the property, added to `parts`, and the methods it writes through. */
	accessorSetter(this: Translator, k: ClassParts, n: string, a: AccessorPair, pair: { t: string; declared: string; reported: boolean; anySetter: boolean }, parts: string[]): void {
		const { cls, lines } = k;
		const { t, declared, reported, anySetter } = pair;
		const set = a.set!;
		const setMethod = `__set_${n.replace(/\W/g, '_')}`;
		const overSetMethod = !isStatic(set) && this.baseSetterMethod(cls, n);
		if (anySetter) {
			const p = set.parameters[0].name;
			let body = this.functionBody(set, 'Void', '    ');
			const fmods = overSetMethod ? 'override ' : '';
			const param = ts.isIdentifier(p) ? ident(p.text) : '__v';
			// A destructured parameter is bound from `__p0`, which the body's prelude takes apart.
			if (!ts.isIdentifier(p)) body = body.replace('{\n', `{\n        let __p0: ${this.typeOf(p)} = ${this.fromAnyCode('__v', this.typeOf(p), true)}\n`);
			const report = this.throwsInfo.fn(set) || !ts.isIdentifier(p);
			this.declare(setMethod, { kind: 'func', mods: fmods, params: `_ ${param}: Any?`, type: 'Void' });
			lines.push(`    ${fmods}func ${setMethod}(_ ${param}: Any?) {\n        ${report ? RT.jsReport : 'do'} ${body.trimStart().replace(/\n/g, '\n    ')}\n    }`);
			parts.push(`        set { ${setMethod}(newValue) }`);
			return;
		}
		if (this.throwsInfo.fn(set) && !reported) throw this.error(set, 'a setter that throws');
		const p = set.parameters[0].name;
		const body = this.functionBody(set, 'Void', '        ');
		// A setter taking more than its getter gives (`set style(value: Style | string)`): its parameter as declared, from the property's value.
		const own = this.typeOf(p);
		// A destructured parameter is bound from `__p0`, which the body's prelude takes apart.
		const bound = ts.isIdentifier(p) ? ident(p.text) : '__p0';
		const value = ts.isIdentifier(p) && !this.isRead(p) ? '' : this.states.nullishHeld(set.parameters[0]) ? `let ${bound} = newValue` : a.get && own !== t && own.replace(/[?!]$/, '') !== t.replace(/[?!]$/, '') ? `let ${bound}: ${own} = ${this.convert('newValue', declared.replace(/!$/, '?'), own)}` : declared !== t ? `let ${bound}: ${declared} = newValue` : !a.get && this.lenient && ts.isIdentifier(p) ? this.setterOnlyValue(p, t) : `let ${bound} = newValue${a.get ? '' : '!'}`;
		const binding = value ? `            ${value}\n` : '';
		// A typed write and a write by name (`jsSet`, as core's Builder sets an attribute) throw what the setter throws; a
		// write through the property itself (a key path, a base's field), whose Swift setter cannot throw, reports it.
		if (this.throwingBodyOf(set)) {
			const throwing = throwingSetter(n);
			const tmods = isStatic(set) ? 'static ' : this.baseThrowingBody(cls, n, ts.SyntaxKind.SetAccessor) ? 'override ' : '';
			this.declare(throwing, { kind: 'func', mods: tmods, params: `_ newValue: ${declared}`, type: 'Void', throws: true });
			lines.push(`    ${tmods}func ${throwing}(_ newValue: ${declared}) throws {\n${binding}            do ${body.trimStart()}\n    }`);
			parts.push(`        set { ${RT.jsReport} { try self.${throwing}(newValue) } }`);
		} else parts.push(this.throwsInfo.fn(set) ? `        set {\n${binding}            ${RT.jsReport} ${body.trimStart()}\n        }` : `        set {\n${binding}            do ${body.trimStart()}\n        }`);
		// A base's `__set_<name>` is what writes through its type and by name call: here, this class's setter.
		if (overSetMethod) {
			lines.push(`    override func ${setMethod}(_ newValue: Any?) { self.${ident(n)} = ${declared.endsWith('!') ? this.fromAny('newValue', declared.replace(/!$/, '?')) : this.fromAnyCode('newValue', declared, true)} }`);
			this.declare(setMethod, { kind: 'func', mods: 'override ', params: '_ newValue: Any?', type: 'Void' });
		}
	},
};
