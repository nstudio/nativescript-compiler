// A class declaration as Swift: classDeclaration and its record (ClassParts), the record's builder, the conversion,
// view, decorator, iterator, shape and static-key members, and the closing step that makes the declaration's code.
import ts from 'typescript';
import { atLossSite, HELD_LOSS } from '../semantics/losses.ts';
import { ERRORS } from '../semantics/globals.ts';
import { NONISOLATED_DEINIT, ident, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { SymbolMethod } from './translator-types.ts';
import { UNKEYED, memberPlanOf, notesNull, nullNames, definedNamesOf } from '../semantics/shapes.ts';
import { droppedProtocolMemberNames, initializedNull } from '../semantics/lang.ts';
import { isStatic } from '../semantics/throws.ts';
import { isCoreDeclaration, isShimDeclaration } from '../program/core-facts.ts';
import { classExprCaptures, classExprScriptName, programBase } from '../semantics/classes.ts';
import type { ClassPlan } from '../semantics/class-plan.ts';

/** What a class declaration's steps share: its facts, computed once, and the parts each step adds to. */
export interface ClassParts {
	cls: ts.ClassLikeDeclaration;
	name: string;
	layout: ClassPlan;
	heritage: ts.ExpressionWithTypeArguments | undefined;
	appBase: ts.ClassLikeDeclaration | undefined;
	base: string | null;
	kitRoot: string | null;
	collection: string | null;
	isError: boolean;
	expando: boolean;
	isView: boolean;
	implemented: string[];
	droppedProtocolMembers: Set<string>;
	witnesses: string[];
	required: Set<string>;
	conformances: string[];
	implicitlyCalled: Set<string>;
	/** The class's lines; the first is its header's place. */
	lines: string[];
	fieldInits: string[];
	fields: { name: string; type: string; at?: ts.PropertyDeclaration; made?: 'unset' | 'inherited' }[];
	paramPropValues: Map<ts.ParameterDeclaration, string>;
	symbolFields: { key: string; member: string; type: string }[];
	symbolMethods: SymbolMethod[];
	keyInits: string[];
	symKeyCount: number;
	dynAccessors: { name: string; get: string | null; set: string | null }[];
	dynMethods: { name: string; type: string; available?: number; length?: number; trailingFrom?: number }[];
}

export const classDeclMethods = {
	classDecl(this: Translator, cls: ts.ClassDeclaration): string {
		const owner = this.declOwner;
		this.declOwner = this.nestedName(cls, ts.isModuleBlock(cls.parent) ? cls.name!.text : this.topName(cls, cls.name!.text));
		try {
			const code = HELD_LOSS ? atLossSite('swift', this, cls, () => this.classDeclaration(cls)) : this.classDeclaration(cls);
			const after = this.framework.hooks.afterClass?.(this, cls, code);
			return after === undefined ? code : `${code}\n${after}`;
		} finally {
			this.declOwner = owner;
		}
	},

	emitClassExpr(this: Translator, cls: ts.ClassExpression): string {
		if (classExprCaptures(cls, this.checker)) throw this.error(cls, 'expression', 'class-expression');
		const name = this.classExprs.name(cls);
		if (this.classExprs.emitted.has(cls)) return name;
		this.classExprs.emitted.add(cls);
		const savedIndent = this.indent;
		const savedInits = this.staticInits;
		const owner = this.declOwner;
		this.indent = '';
		this.staticInits = [];
		this.declOwner = name;
		let extraInits: string[];
		try {
			this.hoisted.push(this.classDeclaration(cls, name));
		} finally {
			extraInits = this.staticInits;
			this.staticInits = savedInits;
			this.indent = savedIndent;
			this.declOwner = owner;
		}
		if (savedInits && extraInits.length) savedInits.push(...extraInits);
		return name;
	},

	classDeclaration(this: Translator, cls: ts.ClassLikeDeclaration, explicitName?: string): string {
		if (ts.isClassDeclaration(cls)) {
			const nativeSubclass = this.native.classDecl(cls);
			if (nativeSubclass) return nativeSubclass;
		}
		const name = explicitName ?? (ts.isModuleBlock(cls.parent) ? cls.name!.text : this.topName(cls, cls.name!.text));
		// Before any member: the function cells their code makes are generic in the type parameters they name.
		this.generics(cls);
		if (ts.isClassDeclaration(cls) && this.framework.hooks.serviceClass && this.framework.classRole(cls, this.pluginFiles) === 'service') return this.framework.hooks.serviceClass(this, cls, name);
		const k = this.classParts(cls, name);
		this.conversionMembers(k);
		this.parameterPropertyFields(k);
		for (const m of cls.members) this.fieldMember(k, m);
		this.optionalMemberFields(k);
		this.constructorMembers(k);
		this.accessorMembers(k);
		this.cssTypeMember(k);
		this.classDecoratorsChecked(k);
		this.computedMethods(k);
		this.methodMembers(k);
		this.iteratorMembers(k);
		this.constructibleMember(k);
		this.shapeMembers(k);
		this.staticKeysMember(k);
		if (this.staticInits && k.keyInits.length) this.staticInits.unshift(...k.keyInits);
		return this.closeClass(k);
	},

	classParts(this: Translator, cls: ts.ClassLikeDeclaration, name: string): ClassParts {
		const c = this.checker;
		const layout = this.classPlan(cls);
		const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		const baseDecl = heritage && c.getTypeAtLocation(heritage.expression).getSymbol()?.valueDeclaration;
		const appBase = layout.base;
		let base: string | null = null;
		// A core class the class extends (directly or through the app's and plugins' classes): NativeScriptKit's class of that name.
		const kitRoot = this.kitRootOf(cls);
		const collection = this.collectionBase(cls);
		if (heritage) {
			const baseName = heritage.expression.getText();
			if (appBase) base = this.className(appBase) + this.typeArguments(heritage, appBase);
			else if (kitRoot && (isCoreDeclaration(baseDecl) || isShimDeclaration(baseDecl))) base = kitRoot;
			else if (ERRORS[baseName]) base = ERRORS[baseName];
			else if (collection) base = collection;
			else throw this.error(heritage, `extending ${baseName}`, 'unsupported-base');
		}
		const isError = !!base && !appBase && !kitRoot && !collection;
		// A class at the root of its hierarchy keeps what script adds to its instances (JSExpando): core's, and a
		// plugin's, written as JavaScript is (`device[adapter_] = adapter`).
		const expando = (!!this.library || this.pluginFiles.has(cls.getSourceFile().fileName) || this.givenUndeclared().has(cls)) && !base;
		const isView = !!kitRoot && this.core.isKitView(kitRoot);
		// The library's interfaces (`Iterable<T>`, `Iterator<T>`) are protocols of the kit's, conformed to below.
		const witnesses: string[] = [];
		const { named, met, implemented } = this.implementedProtocols(cls, kitRoot, witnesses);
		const droppedProtocolMembers = droppedProtocolMemberNames(c, cls, this.protocols, implemented, (i) => this.heritageName(i), (_, t, n) => this.uncompiledType(t) || (t.getSymbol()?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile && (this.library || !isCoreDeclaration(d) || !this.core.has(n))) || this.conformsToProtocol(cls, n));
		// What a protocol requires the class reads without throwing: a getter that throws reports instead.
		const required = new Set([...named, ...met].filter((i) => implemented.includes(i.name)).flatMap((i) => i.type.getProperties().map((p) => p.name)));
		const conformances = [...(base ? [base] : []), ...(collection && !appBase && !implemented.length ? ['JSDynamic'] : []), ...implemented];
		// The methods JavaScript calls without the program naming them, each through the conformance that calls it:
		// a plugin's class keeps them, where its other methods the app never names are left out.
		const implicitlyCalled = new Set(['toString']);
		// A class's own toString is what JavaScript's string conversion calls.
		if (layout.toString) conformances.push('JSStringConvertible');
		const { valueOf, toJSON } = layout;
		if (valueOf) {
			conformances.push('JSValueOfConvertible');
			implicitlyCalled.add('valueOf');
		}
		// A class's own toJSON is what JSON.stringify serializes in its instances' place.
		if (toJSON) {
			conformances.push('JSToJSONConvertible');
			implicitlyCalled.add('toJSON');
		}
		return { cls, name, layout, heritage, appBase, base, kitRoot, collection, isError, expando, isView, implemented, droppedProtocolMembers, witnesses, required, conformances, implicitlyCalled, lines: [''], fieldInits: [], fields: [], paramPropValues: new Map(), symbolFields: [], symbolMethods: [], keyInits: [], symKeyCount: 0, dynAccessors: [], dynMethods: [] };
	},

	conversionMembers(this: Translator, k: ClassParts): void {
		const { cls, layout, lines } = k;
		const { valueOf, toJSON } = layout;
		if (valueOf) {
			lines.push(`    func jsValueOf() throws -> Any? { ${this.throwsInfo.fn(valueOf) ? 'try ' : ''}self.valueOf() }`);
			this.declare('jsValueOf', { kind: 'func', params: '', throws: true, type: 'Any?' });
		}
		if (toJSON) {
			lines.push(`    func jsToJSON(_ key: String) throws -> Any? { ${this.throwsInfo.fn(toJSON) ? 'try ' : ''}self.toJSON(${toJSON.parameters.length ? 'key' : ''}) }`);
			this.declare('jsToJSON', { kind: 'func', params: '_ key: String', throws: true, type: 'Any?' });
		}
		// A toString that may give no string: ToPrimitive tries it in the hint's order beside valueOf, a subclass's included.
		const ownPrimitive = cls.members.some((m) => ts.isMethodDeclaration(m) && ts.isComputedPropertyName(m.name) && this.symbolMember(m.name)?.member === 'jsToPrimitive');
		if (layout.objectToString && !ownPrimitive) {
			const toString = cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText() === 'toString' && !m.parameters.length)!;
			const valueOf = `(self as AnyObject as? JSValueOfConvertible).map { v in { try v.jsValueOf() } }`;
			lines.push(`    func jsToPrimitive(_ hint: String) throws -> Any? { try ${RT.jsOrdinaryToPrimitive}(hint, valueOf: ${valueOf}, toString: { ${this.throwsInfo.fn(toString) ? 'try ' : ''}self.toString() }) }`);
			this.declare('jsToPrimitive', { kind: 'func', params: '_ hint: String', throws: true, type: 'Any?' });
			k.conformances.push('JSToPrimitive');
		}
	},

	cssTypeMember(this: Translator, k: ClassParts): void {
		// A view class's type selector: its `@CSSType` name, else its class name, as core's `cssType` falls back to `typeName`.
		if (k.isView) {
			const cssType = (ts.getDecorators(k.cls) ?? []).map((d) => d.expression).find((e): e is ts.CallExpression => ts.isCallExpression(e) && e.expression.getText() === 'CSSType');
			const typeName = cssType && ts.isStringLiteralLike(cssType.arguments[0]) ? cssType.arguments[0].text : k.name;
			k.lines.push(`    override var cssType: String { get { ${swiftString(typeName)} } set {} }`);
			this.declare('cssType', { kind: 'var', mods: 'override ', type: 'String' });
		}
	},

	classDecoratorsChecked(this: Translator, k: ClassParts): void {
		for (const d of ts.getDecorators(k.cls) ?? []) {
			if (ts.isIdentifier(d.expression) && this.library?.identities?.has(d.expression.text)) continue;
			if (this.library && ts.isSourceFile(k.cls.parent)) continue;
			// A decorator the framework reads is its compiler's: a compiled build reads what it declares from the components.
			if (!this.keptDecorator(d)) throw this.error(d, `the class decorator ${d.expression.getText()}`);
		}
	},

	iteratorMembers(this: Translator, k: ClassParts): void {
		const protocol = this.iteratorProtocol(
			k.cls.members
				.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.body && !isStatic(m) && ['next', 'return', 'throw'].includes(m.name.getText()))
				.map((m) => ({
					name: m.name.getText(),
					params: m.parameters.length,
					param: m.parameters[0]?.dotDotDotToken ? undefined : this.signatureOf(m).params[0]?.type,
					ret: this.returnTypeOf(m),
					throws: this.throwsInfo.fn(m),
				})),
		);
		if (protocol && !k.appBase && !k.kitRoot) {
			k.conformances.push(protocol.conformance);
			k.lines.push(...protocol.lines);
			for (const [n, x] of protocol.members) this.declare(n, x);
		}
		k.lines.push(...k.witnesses);
	},

	/** Evaluates a non-fixed computed symbol key once at class definition time into a stored string slot. */
	storedSymbolKey(this: Translator, k: ClassParts, e: ts.Expression, keyCode: string): string {
		if (!this.staticInits) return keyCode;
		const idx = k.symKeyCount++;
		const generic = !!k.cls.typeParameters?.some((p) => !this.erasesTypeParameter(p));
		const initExpr = this.marks.tryBefore(this.tryPrefix(e), keyCode);
		if (generic) {
			const globalSlot = `__symKey_${ident(k.name).replace(/`/g, '')}_${idx}`;
			this.hoisted.push(`fileprivate var ${globalSlot}: String = ""`);
			k.keyInits.push(`    ${globalSlot} = ${initExpr}`);
			return globalSlot;
		}
		const slot = `__symKey_${idx}`;
		k.lines.push(`    static var ${slot}: String = ""`);
		this.declare(slot, { kind: 'var', mods: 'static ', type: 'String' });
		const ref = `${this.className(k.cls)}.${slot}`;
		k.keyInits.push(`    ${ref} = ${initExpr}`);
		return ref;
	},

	/** Whether a non-expando app class declares symbol-named instance methods handled through `subscript(jsKey:)` and `jsHasMember`. */
	hasPlainSymbolMethods(this: Translator, cls: ts.ClassLikeDeclaration): boolean {
		if (this.library || this.kitRootOf(cls)) return false;
		let root: ts.ClassLikeDeclaration = cls;
		for (let b = programBase(root, this.checker); b; b = programBase(b, this.checker)) root = b;
		if (!root.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) && (this.pluginFiles.has(root.getSourceFile().fileName) || this.givenUndeclared().has(root))) return false;
		return cls.members.some((m) => ts.isMethodDeclaration(m) && !!m.body && !isStatic(m) && !m.typeParameters?.length && !m.parameters.some((p) => p.dotDotDotToken) && !this.readsArguments(m) && ts.isComputedPropertyName(m.name) && !!this.symbolMemberOf(m.name)?.key);
	},

	/** Whether an ancestor program class already conforms to `JSMemberKeyed`. */
	inheritsMemberKeyed(this: Translator, cls: ts.ClassLikeDeclaration): boolean {
		for (let b = programBase(cls, this.checker); b; b = programBase(b, this.checker)) {
			if (this.states.byNameClass(b) || this.hasPlainSymbolMethods(b)) return true;
		}
		return false;
	},

	shapeMembers(this: Translator, k: ClassParts): void {
		const { cls, name, appBase, kitRoot, fields, lines, conformances } = k;
		// Library mode: a registered property's value reaches its accessor as it is, which converts it (`col = "1"`).
		const raw = new Set(this.library ? fields.filter((f) => this.properties?.isRegistered(cls, f.name) || this.properties?.isRegisteredAnywhere(f.name)).map((f) => f.name) : []);
		const symbolKeyedBase = !!kitRoot || this.inheritsSymbolKeyed(cls);
		// Script knows the class by its own name, not the one Swift's module gives it apart from another of that name.
		// An Error subclass keeps JSError's class name, which is the error's `name`.
		const byName = this.states.byNameClass(cls) ? { receiver: name, inherits: !!appBase && this.states.byNameClass(appBase) } : undefined;
		const hasMember = byName || k.symbolMethods.length > 0 ? { inherits: !!appBase && this.inheritsMemberKeyed(cls) } : undefined;
		if (hasMember && !hasMember.inherits) conformances.push('JSMemberKeyed');
		if (k.isError) lines.push(...this.dynamicMembers(UNKEYED, { fields, className: null, override: true, methods: k.dynMethods, symbols: k.symbolFields, symbolMethods: k.symbolMethods, raw, accessors: k.dynAccessors, classNameMember: false, byName, hasMember }).filter((l) => !l.includes(' var jsClassName: ')));
		else {
			const plan = this.shapePlan(cls),
				nulls = nullNames(plan, notesNull);
			if (plan?.declaresNulls) {
				const initial = cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && nulls.has(m.name.getText()) && initializedNull(m));
				lines.push(`    var jsNulls: Set<String>?${initial.length ? ` = [${initial.map((m) => swiftString(m.name.getText())).join(', ')}]` : ''}`);
			}
			if (this.states.declaresUnset(cls)) lines.push('    var jsUnset: Set<String>?');
			const definable = definedNamesOf(cls, this.states, this.shapeFacts()).filter((n) => fields.some((f) => f.name === n));
			this.keyedMembers(cls, !!appBase, lines, conformances);
			lines.push(...this.dynamicMembers(memberPlanOf(cls, this.states, this.shapeFacts()), { fields, className: ts.isClassExpression(cls) ? classExprScriptName(cls) : (cls.name?.text ?? name), override: !!appBase || !!kitRoot, methods: k.dynMethods, symbols: k.symbolFields, symbolMethods: k.symbolMethods, raw, accessors: k.dynAccessors, symbolKeyedBase, byName, hasMember }));
			if (definable.length) {
				let inherited = false;
				for (let b = programBase(cls, this.checker); b && !inherited; b = programBase(b, this.checker)) inherited = definedNamesOf(b, this.states, this.shapeFacts()).length > 0;
				if (!inherited) conformances.push('JSDefinable');
				const mods = inherited ? 'override ' : '';
				lines.push(`    ${mods}func jsDefinable(_ key: String) -> Bool {`, `        switch key { case ${definable.map(swiftString).join(', ')}: return true; default: return ${inherited ? 'super.jsDefinable(key)' : 'false'} }`, '    }');
				this.declare('jsDefinable', { kind: 'func', mods, params: '_ key: String', type: 'Bool' });
			}
		}
		if (k.symbolFields.length && !symbolKeyedBase) conformances.push('JSSymbolKeyed');
	},

	staticKeysMember(this: Translator, k: ClassParts): void {
		const { cls, appBase, lines } = k;
		// Library mode: the class's `name`, which a static method reads of the class it is called on.
		if (this.library && !this.errorBased(cls)) {
			lines.push(`    ${appBase ? 'override ' : ''}class var jsName: String { ${swiftString(cls.name ? cls.name.text : classExprScriptName(cls as ts.ClassExpression))} }`);
			this.declare('jsName', { kind: 'var', mods: `${appBase ? 'override ' : ''}class `, type: 'String' });
		}
		// Library mode: the static members script can test for by name (`'tapEvent' in view.constructor`).
		if (this.library && !this.inNativeClass(cls.members[0] ?? cls)) {
			const statics = cls.members.filter((m) => m.name && isStatic(m) && !ts.isComputedPropertyName(m.name)).map((m) => m.name!.getText().replace(/^['"]|['"]$/g, ''));
			const own = `[${[...new Set(statics)].map(swiftString).join(', ')}]`;
			if (!appBase) {
				k.conformances.push('JSStaticKeyed');
				lines.push(`    open class var jsStaticKeys: [String] { ${own} }`);
			} else if (own !== '[]') lines.push(`    open override class var jsStaticKeys: [String] { super.jsStaticKeys + ${own} }`);
			if (!appBase || own !== '[]') this.declare('jsStaticKeys', { kind: 'var', mods: 'class ', type: '[String]' });
		}
	},

	closeClass(this: Translator, k: ClassParts): string {
		const { cls, name, base, lines, conformances } = k;
		const extras = ts.isClassDeclaration(cls) ? this.framework.hooks.classExtras?.(this, cls, name, lines.join('\n')) : undefined;
		if (extras) {
			conformances.push(...(extras.supertypes ?? []));
			lines.push(...(extras.members ?? []));
		}
		this.indent = '';
		lines.push('}');
		lines[0] = `${this.extended.has(name) || this.extendedDecls.has(cls) || this.library ? '' : 'final '}class ${ident(name)}${this.generics(cls)}: ${[...(base || k.implemented.length ? [] : ['JSDynamic']), ...conformances].join(', ')} {`;
		if (this.declOwner) this.declarations?.type(this.declOwner, 'class', base?.replace(/<.*$/, '') ?? null);
		lines.splice(1, 0, NONISOLATED_DEINIT);
		this.documentMembers(cls, lines);
		return [...this.docLines(cls, ''), ...lines].join('\n');
	},
};
