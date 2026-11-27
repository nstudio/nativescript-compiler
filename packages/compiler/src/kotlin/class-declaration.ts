// A class declaration as Kotlin: classDeclCode and its record (ClassParts), the record's builder, the key state, view,
// decorator, statics-by-name, iterator, expando, conversion, shape and merged-namespace members, and the closing step
// that makes the declaration's code.
import ts from 'typescript';
import { ERRORS } from '../semantics/globals.ts';
import { OBJECT_TO_STRING, ident, kotlinString, lambda, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { UNKEYED, isPropertyField, memberPlanOf, notesNull, nullNames, definedNamesOf } from '../semantics/shapes.ts';
import { droppedProtocolMemberNames, implementedInterfaces, initializedNull } from '../semantics/lang.ts';
import { hasModifier } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { isCoreDeclaration, isShimDeclaration } from '../program/core-facts.ts';
import { classExprCaptures, classExprScriptName, programBase } from '../semantics/classes.ts';
import type { ClassPlan } from '../semantics/class-plan.ts';

/** What a class declaration's steps share: its facts, computed once, and the parts each step adds to. */
export interface ClassParts {
	readonly cls: ts.ClassLikeDeclaration;
	readonly name: string;
	readonly layout: ClassPlan;
	readonly plugin: boolean;
	readonly appBase: ts.ClassLikeDeclaration | undefined;
	readonly base: string | null;
	readonly kitRoot: string | null;
	readonly collection: string | null;
	readonly isError: boolean;
	readonly isView: boolean;
	readonly abstract: boolean;
	readonly open: boolean;
	readonly memberOpen: string;
	readonly expando: boolean;
	readonly witnesses: string[];
	readonly overridden: Set<string>;
	readonly interfaceFields: Map<string, string>;
	readonly droppedProtocolMembers: Set<string>;
	readonly byName: boolean;
	readonly literalMade: boolean;
	readonly supertypes: string[];
	/** The class's members, between its head line and its closing brace. */
	readonly lines: string[];
	/** The companion object's members. */
	readonly statics: string[];
	readonly fields: { name: string; type: string; expando?: boolean; at?: ts.PropertyDeclaration; made?: 'unset' | 'inherited' }[];
	readonly narrowedParams: Map<ts.ParameterDeclaration, string>;
	readonly initsAfterParamProps: string[];
	readonly symbolFields: { key: string; fixed?: boolean; either?: boolean; maybeUndefined?: boolean; member: string; type: string }[];
	readonly symbolKeyInits: string[];
	symKeyCount: number;
	/** Where each field's lines start, for its doc comment. */
	readonly fieldStarts: [number, ts.PropertyDeclaration][];
	readonly dynAccessors: { name: string; type: string; readable: boolean; settable: boolean; set?: string }[];
	readonly dynMethods: { name: string; key?: string; fixed?: boolean; either?: boolean; maybeUndefined?: boolean; params: string[]; defaults?: (string | undefined)[]; unread?: boolean[]; ret: string }[];
}

export const classDeclMethods = {
	emitClassExprCode(this: Translator, cls: ts.ClassExpression): string {
		if (classExprCaptures(cls, this.checker)) throw this.error(cls, 'class expression capturing outer locals', 'class-expression');
		const name = this.classExprs.name(cls);
		if (!this.classExprs.emitted.has(cls)) {
			this.classExprs.emitted.add(cls);
			const prevIndent = this.indent;
			const prevInits = this.staticInits;
			this.indent = '';
			this.staticInits = [];
			let addedInits: string[];
			try {
				this.hoisted.push(this.classDeclCode(cls, name));
			} finally {
				addedInits = this.staticInits;
				this.staticInits = prevInits;
				this.indent = prevIndent;
			}
			if (prevInits && addedInits.length) prevInits.push(...addedInits);
		}
		return name;
	},

	classDeclCode(this: Translator, cls: ts.ClassLikeDeclaration, explicitName?: string): string {
		// '' where the class is declared in a file of its own package.
		if (ts.isClassDeclaration(cls)) {
			const nativeSubclass = this.native?.classDecl(cls);
			if (nativeSubclass != null) return nativeSubclass;
		}
		// A namespace's class is declared in its object, by its own name.
		const name = explicitName ?? (ts.isModuleBlock(cls.parent) ? ident(cls.name!.text) : this.className(cls));
		if (ts.isClassDeclaration(cls) && this.framework.hooks.serviceClass && this.framework.classRole(cls, this.pluginFiles) === 'service') return this.framework.hooks.serviceClass(this, cls, name);
		if (ts.isClassDeclaration(cls) && !this.library && this.collectionAlias(cls)) {
			this.indent = '    ';
			const statics = cls.members.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && isStatic(m) && !!m.body).map((m) => '    ' + this.func(m, ident(m.name.getText())));
			this.indent = '';
			const alias = this.collectionAlias(cls)!;
			const methods = cls.members.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !isStatic(m) && !!m.body).map((m) => this.func(m, ident(m.name.getText())).replace(/^fun /m, `fun ${alias}.`));
			return [`object ${name} {`, ...statics, '}', ...methods].join('\n');
		}
		const k = this.classPartsCode(cls, name);
		// Before the fields: a constructor's writes note into it, which a later initializer would reset.
		this.keyStateCode(k);
		this.parameterPropertyFieldsCode(k);
		for (const m of cls.members) this.fieldMemberCode(k, m);
		this.optionalMemberFieldsCode(k);
		this.fieldDocsCode(k);
		this.prototypeDefaultsCode(k);
		this.constructorMembersCode(k);
		this.accessorMembersCode(k);
		this.cssTypeMemberCode(k);
		this.classDecoratorsCode(k);
		this.staticsByNameCode(k);
		this.prototypeMethodsCode(k);
		this.computedMethodsCode(k);
		this.methodMembersCode(k);
		this.ownPropertiesCode(k);
		this.iteratorMembersCode(k);
		this.expandoMemberCode(k);
		this.conversionMembersCode(k);
		this.methodsByNameCode(k);
		this.shapeMembersCode(k);
		this.mergedStaticsCode(k);
		if (k.symbolKeyInits.length && this.staticInits) this.staticInits.unshift(...k.symbolKeyInits);
		return this.closeClassCode(k);
	},

	classPartsCode(this: Translator, cls: ts.ClassLikeDeclaration, name: string): ClassParts {
		const c = this.checker;
		const plugin = this.pluginFiles.has(cls.getSourceFile().fileName);
		const layout = this.classPlan(cls);
		const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		const baseDecl = heritage && c.getTypeAtLocation(heritage.expression).getSymbol()?.valueDeclaration;
		const appBase = layout.base;
		// A core class the class extends (directly or through the app's and plugins' classes): kit-android's class of that name.
		const kitRoot = this.kitRootOf(cls);
		const collection = this.collectionSuperType(cls);
		let base: string | null = null;
		if (heritage) {
			const baseName = heritage.expression.getText();
			if (appBase) {
				base = this.type(c.getTypeAtLocation(heritage), heritage);
				// `any` for a bounded type parameter (`Test<any>` of `Test<T extends View>`): its bound, as Kotlin holds the parameter to it.
				const bounds = appBase.typeParameters?.map((p) => (p.constraint && !this.library && !this.pluginFiles.has(appBase.getSourceFile().fileName) ? this.type(c.getTypeFromTypeNode(p.constraint), p) : null));
				if (bounds?.some(Boolean) && heritage.typeArguments?.some((a) => a.kind === ts.SyntaxKind.AnyKeyword)) {
					const kargs = heritage.typeArguments.map((a, k) => (a.kind === ts.SyntaxKind.AnyKeyword && bounds[k] ? bounds[k]!.replace(/\?$/, '') : this.type(c.getTypeFromTypeNode(a), a)));
					base = `${base.replace(/<.*$/, '')}<${kargs.join(', ')}>`;
				}
			} else if (kitRoot && (isCoreDeclaration(baseDecl as ts.Declaration) || isShimDeclaration(baseDecl as ts.Declaration))) base = kitRoot;
			else if (ERRORS[baseName]) base = ERRORS[baseName];
			else if (collection) base = collection;
			else throw this.error(heritage, `extending ${baseName}`, 'unsupported-base');
		}
		const isError = Boolean(base && !appBase && !kitRoot && !collection);
		const isView = !!kitRoot && !!this.core?.isKitView(kitRoot);
		const abstract = hasModifier(cls, ts.SyntaxKind.AbstractKeyword) || (!!this.library && this.leavesAbstract(cls));
		// Library mode: a class core exports is one an app may extend (`class Card extends StackLayout`).
		const exported = !!this.library && hasModifier(cls, ts.SyntaxKind.ExportKeyword);
		const open = (cls.name ? this.extended.has(cls.name.text) : false) || this.extendedDecls.has(cls) || abstract || (ts.isClassDeclaration(cls) && this.literalClasses().has(cls)) || exported;
		// The library's interfaces (`Iterable<T>`, `Iterator<T>`) are interfaces of the kit's, implemented below.
		const witnesses: string[] = [];
		const notOverrides = new Set<string>();
		const implemented = this.implementedProtocols(cls, witnesses, notOverrides);
		const droppedProtocolMembers = droppedProtocolMemberNames(c, cls, this.protocols, implemented, (i) => this.implementedName(i), (i, t, n) => this.untranslatedInterface(i) || this.declaredOnlyInterface(i) || (!!this.library && (t.getSymbol()?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile)) || this.declaresInterface(c.getTypeAtLocation(cls.name ?? cls), n));
		for (const i of implemented) this.used.add(i);
		const ownToString = layout.toString;
		// A class's own toJSON is what JSON.stringify serializes in its instances' place.
		const { valueOf, toJSON } = layout;
		const supertypes = [...implemented, ...(ownToString ? ['JSStringConvertible'] : []), ...(valueOf ? ['JSValueOf'] : []), ...(toJSON ? ['JSToJSON'] : [])];
		// Library mode: a class at the root of its hierarchy keeps what script adds to its instances, and reads its prototype's.
		// An app's class does where script gives its instances members it doesn't declare.
		const expando = (!!this.library || this.keepsAdded(cls)) && !base;
		if (expando) supertypes.push('JSExpando');
		else if ((!base || (collection && !appBase)) && !implemented.length) supertypes.push('JSDynamic');
		const overridden = this.overridden(cls, implemented);
		// Library mode: a field script leaves untyped (`object` of an event's class) where an interface it implements types it: the interface's type.
		const interfaceFields = new Map<string, string>();
		if (this.library)
			for (const i of implementedInterfaces(c, cls).filter((x) => implemented.includes(x.expression.getText()))) {
				const d = c
					.getTypeAtLocation(i)
					.getSymbol()
					?.declarations?.find((x): x is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(x));
				if (d) for (const m of this.withInherited(d, d.members)) if (ts.isPropertySignature(m) && ts.isIdentifier(m.name)) interfaceFields.set(m.name.text, m.questionToken ? optionalType(this.typeOf(m)) : this.typeOf(m));
			}

		for (const n of notOverrides) overridden.delete(n);
		// An accessor over a property of the generated kit's class (`get width()` of a view, its open `var width`).
		if (this.generatedKit && kitRoot) for (const m of cls.members) if (ts.isAccessor(m) && !isStatic(m) && this.core?.kitMember(kitRoot, m.name.getText())?.kind === 'var') overridden.add(m.name.getText());
		const memberOpen = open ? 'open ' : '';
		// An app class extending the generated kit's (a page's view model, a custom view): read by name as core reads it (bindings, the Builder).
		const byName = !this.library && ((this.generatedKit && !!kitRoot) || this.appMembersByName);
		const literalMade = ts.isClassDeclaration(cls) && this.literalMade(cls);
		return { cls, name, layout, plugin, appBase, base, kitRoot, collection, isError, isView, abstract, open, memberOpen, expando, witnesses, overridden, interfaceFields, droppedProtocolMembers, byName, literalMade, supertypes, lines: [], statics: [], fields: [], narrowedParams: new Map(), initsAfterParamProps: [], symbolFields: [], symbolKeyInits: [], symKeyCount: 0, fieldStarts: [], dynAccessors: [], dynMethods: [] };
	},

	/** Evaluates a non-fixed computed symbol key once at class definition time into a companion property. */
	capturedSymbolKey(this: Translator, k: ClassParts, keyCode: string): string {
		if (!this.staticInits) return keyCode;
		const slot = `__symKey_${k.symKeyCount++}`;
		const owner = k.name.replace(/<.*$/, '');
		k.statics.push(`        var ${slot}: String = ""`);
		k.symbolKeyInits.push(`    ${owner}.${slot} = ${keyCode}`);
		return `${owner}.${slot}`;
	},

	/** The modifiers of the class's member of that name: `override` where it overrides one, `open` where the class is. */
	memberMods(this: Translator, k: ClassParts, n: string): string {
		return k.overridden.has(n) ? 'override ' : k.memberOpen;
	},

	keyStateCode(this: Translator, k: ClassParts): void {
		if (!k.isError) this.keyedMembers(k.cls, !!k.appBase, k.lines, k.supertypes);
		if (!k.isError) k.lines.push(...this.madeLevelInit(k.cls));
	},

	cssTypeMemberCode(this: Translator, k: ClassParts): void {
		const { cls, isView, lines } = k;
		// A view class's type selector: its `@CSSType` name, else its class name, as core's `cssType` falls back to `typeName`.
		// The generated kit is core: without a `@CSSType` of its own, a class takes the nearest one above it, which core's decorator
		// sets on the prototype through `cssType`'s lowercasing setter (a plugin's `MenuButton` is a `button`), else core's `typeName` one.
		const cssType = (ts.getDecorators(cls) ?? []).map((d) => d.expression).find((e): e is ts.CallExpression => ts.isCallExpression(e) && e.expression.getText() === 'CSSType');
		if (isView && this.generatedKit && !cssType) lines.push('    override var cssType: String', '        get() = (JSPrototypes.value(javaClass, "cssType", this) as? String)?.lowercase() ?: super.cssType', '        set(value) { super.cssType = value }');
		if (isView && (!this.generatedKit || cssType)) {
			const typeName = cssType && ts.isStringLiteralLike(cssType.arguments[0]) ? cssType.arguments[0].text : (cls.name?.text ?? k.name);
			// The generated kit's `cssType` is core's settable accessor.
			lines.push(this.generatedKit ? `    override var cssType: String\n        get() = ${kotlinString(typeName)}\n        set(@Suppress("UNUSED_PARAMETER") value) {}` : `    override val cssType: String get() = ${kotlinString(typeName)}`);
		}
	},

	classDecoratorsCode(this: Translator, k: ClassParts): void {
		const { cls, name } = k;
		const decorators: ts.Decorator[] = [];
		for (const d of ts.getDecorators(cls) ?? []) {
			if (this.library?.identities.has(d.expression.getText().replace(/\(.*$/s, ''))) continue;
			// Library mode: a module-level class's decorators run with the module's statements, on its prototype (`@CSSType`, `@SelectorProperties`).
			if (this.library && this.staticInits && !this.keptDecorator(d, ['NativeClass'])) {
				decorators.push(d);
				continue;
			}
			// A decorator the framework reads is its compiler's: a compiled build reads what it declares from the components.
			if (!this.keptDecorator(d, ['CSSType', 'NativeClass'])) throw this.error(d, `the class decorator ${d.expression.getText()}`);
		}
		if (decorators.length) {
			this.indent = '    ';
			this.staticInits!.push(`    ${RT.jsDecorate}(${name}::class.java, listOf(${decorators.map((d) => this.coerce(d.expression, 'Any?')).join(', ')}))`);
			this.indent = '    ';
		}
	},

	staticsByNameCode(this: Translator, k: ClassParts): void {
		const { cls, name } = k;
		// Statics script reads by name (`(Registry as any)[key]`), which a companion's members are not to reflection.
		if (this.staticInits && this.states.byNameStatics(cls)) {
			const owner = name.replace(/<.*$/, '');
			const entries = cls.members.flatMap((m): string[] => {
				if (!isStatic(m) || !m.name || !ts.isIdentifier(m.name)) return [];
				const n = m.name.text,
					ref = `${owner}.${ident(n)}`;
				if (ts.isMethodDeclaration(m)) {
					if (!m.body || m.typeParameters?.length || m.asteriskToken || m.parameters.some((p) => p.dotDotDotToken) || this.readsArguments(m) || cls.members.filter((x) => ts.isMethodDeclaration(x) && x.name.getText() === n).length > 1) return [];
					const call = `${ref}(${m.parameters.map((p, k) => this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), this.paramType(p), true)).join(', ')})`;
					return [`${kotlinString(n)} to { ${RT.jsFunction} ${lambda(['__a'], this.returnTypeOf(m) === 'Unit' ? `${call}; null` : call)} }`];
				}
				return ts.isPropertyDeclaration(m) || ts.isGetAccessorDeclaration(m) ? [`${kotlinString(n)} to { ${ref} }`] : [];
			});
			if (entries.length) this.staticInits.push(`    JSPrototypes.declareStatics(${owner}::class.java, listOf(${entries.join(', ')}))`);
		}
	},

	prototypeMethodsCode(this: Translator, k: ClassParts): void {
		const { cls, name } = k;
		if (this.library || !this.staticInits || !ts.isClassDeclaration(cls) || !this.facts.prototypeClasses().has(cls) || cls.typeParameters?.length) return;
		const owner = name.replace(/<.*$/, '');
		const seen = new Set<string>();
		for (const m of cls.members) {
			if (!ts.isMethodDeclaration(m) || !m.body || isStatic(m) || ts.isPrivateIdentifier(m.name) || ts.isComputedPropertyName(m.name) || m.typeParameters?.length || m.asteriskToken || m.parameters.some((p) => p.dotDotDotToken || (ts.isIdentifier(p.name) && p.name.text === 'this')) || this.readsArguments(m)) continue;
			const key = m.name.getText().replace(/^['"]|['"]$/g, '');
			if (seen.has(key)) continue;
			seen.add(key);
			const args = m.parameters.map((p, idx) => this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${idx})`), this.paramType(p), true));
			const call = `__o.${this.methodIdent(key)}(${args.join(', ')})`;
			const body = this.returnTypeOf(m) === 'Unit' ? `${call}; null` : call;
			this.staticInits.push(`    JSPrototypes.of(${owner}::class.java).defineProperty(${kotlinString(key)}, JSPropertyDescriptor(value = JSMethod(${m.parameters.length}) { __this, __a -> val __o = ${RT.jsBox}(__this) as? ${owner} ?: throw JSException(JSTypeError("Illegal invocation")); ${body} }, hasValue = true, enumerable = false, writable = true, configurable = true))`);
		}
	},

	ownPropertiesCode(this: Translator, k: ClassParts): void {
		if (k.isView && !this.generatedKit) {
			const own = k.fields.filter(isPropertyField).map((f) => f.name);
			if (own.length) k.lines.push(`    override fun hasJSProperty(name: String): Boolean = name in setOf(${own.map(kotlinString).join(', ')}) || super.hasJSProperty(name)`);
		}
	},

	iteratorMembersCode(this: Translator, k: ClassParts): void {
		const protocol = this.iteratorProtocol(
			k.cls.members
				.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.body && !isStatic(m) && ['next', 'return', 'throw'].includes(m.name.getText()))
				.map((m) => ({
					name: m.name.getText(),
					params: m.parameters.length,
					ret: this.returnTypeOf(m),
					param: m.parameters[0] ? this.paramType(m.parameters[0]) : undefined,
				})),
		);
		if (protocol && !k.appBase) {
			k.supertypes.push(protocol.conformance);
			k.lines.push(...protocol.lines);
		}
		k.lines.push(...k.witnesses);
	},

	expandoMemberCode(this: Translator, k: ClassParts): void {
		if (k.expando) k.lines.push('    override var jsExpando: JSObject? = null');
	},

	conversionMembersCode(this: Translator, k: ClassParts): void {
		const { layout, supertypes, lines } = k;
		const { valueOf, toJSON } = layout;
		if (valueOf) lines.push(`    override fun jsValueOf(): Any? = ${RT.jsBox}(this.${this.methodIdent('valueOf')}())`);
		// A toString that may give no string: ToPrimitive tries it in the hint's order beside valueOf, a subclass's included.
		if (layout.objectToString && !supertypes.includes('JSToPrimitive')) {
			supertypes.push('JSToPrimitive');
			lines.push(`    override fun jsToPrimitive(hint: String): Any? = ${RT.jsOrdinaryToPrimitive}(hint, ${valueOf ? '{ jsValueOf() }' : '(this as Any as? JSValueOf)?.let { v -> { v.jsValueOf() } }'}, { ${OBJECT_TO_STRING}() })`);
		}
		if (toJSON) lines.push(`    override fun jsToJSON(key: String): Any? = ${RT.jsBox}(this.${this.methodIdent('toJSON')}(${toJSON.parameters.length ? 'key' : ''}))`);
	},

	shapeMembersCode(this: Translator, k: ClassParts): void {
		const { cls, name, appBase, base, kitRoot, isError, supertypes, lines, symbolFields, dynMethods, dynAccessors } = k;
		const fields = k.fields.filter(isPropertyField);
		const plan = this.shapePlan(cls),
			nulls = isError ? new Set<string>() : nullNames(plan, notesNull);
		if (!isError && plan?.declaresNulls) {
			const initial = cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && nulls.has(m.name.getText()) && initializedNull(m));
			lines.push(`    var jsNulls: MutableSet<String>? = ${initial.length ? `mutableSetOf(${initial.map((m) => kotlinString(m.name.getText())).join(', ')})` : 'null'}`);
		}
		if (!isError && this.states.declaresUnset(cls)) lines.push('    var jsUnset: MutableSet<String>? = null');
		const definable = isError ? [] : definedNamesOf(cls, this.states, this.shapeFacts()).filter((n) => fields.some((f) => f.name === n));
		if (!isError) {
			lines.push(...this.dynamicMembers(memberPlanOf(cls, this.states, this.shapeFacts()), { fields, className: ts.isClassExpression(cls) ? classExprScriptName(cls) : (this.scriptClassName(cls) ?? name), inherits: !!appBase || !!kitRoot, symbols: symbolFields, methods: dynMethods, accessors: dynAccessors, superclass: base?.replace(/<.*$/, ''), receiver: this.states.byNameClass(cls) ? name.replace(/<.*$/, '') : undefined, keyIndex: ts.isSourceFile(cls.parent) || ts.isModuleBlock(cls.parent) }));
		}
		// An error's own fields by name, after JSError's `name`/`message`/`stack`; what script adds to it comes after the fields, and it prints as an error, not as `Name { … }`.
		else
			lines.push(
				...this.dynamicMembers(UNKEYED, { fields, className: name, inherits: true, symbols: symbolFields, methods: dynMethods, accessors: dynAccessors, superclass: base!.replace(/<.*$/, '') })
					.filter((l) => !l.startsWith('    override val jsClassName'))
					.map((l) => (l.startsWith('    override val jsKeys') && l.includes('super.jsKeys + ') ? l.replace('super.jsKeys + ', '') + ' + super.jsKeys' : l)),
			);
		if (definable.length) {
			let inherited = false;
			for (let b = programBase(cls, this.checker); b && !inherited; b = programBase(b, this.checker)) inherited = definedNamesOf(b, this.states, this.shapeFacts()).length > 0;
			if (!inherited) supertypes.push('JSDefinable');
			lines.push(...(inherited ? [] : ['    override var jsDefined: JSObject? = null']), `    override fun jsDefinable(key: String): Boolean = when (key) { ${definable.map(kotlinString).join(', ')} -> true; else -> ${inherited ? 'super.jsDefinable(key)' : 'false'} }`);
		}
		if (symbolFields.length) supertypes.push('JSSymbolKeyed');
	},

	mergedStaticsCode(this: Translator, k: ClassParts): void {
		// A merged namespace's enums and classes are the class's nested ones (`TemplateParser.State`), its values the companion's.
		const nestedType = (l: string) => /^(?:(?:open|abstract|enum|data)\s+)*(?:class|interface|object)\s/.test(l);
		k.lines.push(
			...this.mergedStatics.filter(nestedType).map((l) =>
				l
					.split('\n')
					.map((x) => (x ? '    ' + x : x))
					.join('\n'),
			),
		);
		k.statics.push(
			...this.mergedStatics
				.filter((l) => !nestedType(l))
				.map((l) =>
					l
						.split('\n')
						.map((x) => (x ? '        ' + x : x))
						.join('\n'),
				),
		);
		this.mergedStatics = [];
	},

	closeClassCode(this: Translator, k: ClassParts): string {
		const { cls, name, base, abstract, open, supertypes, lines, statics } = k;
		const extras = ts.isClassDeclaration(cls) ? this.framework.hooks.classExtras?.(this, cls, name, lines.join('\n')) : undefined;
		statics.push(...(extras?.members ?? []));
		if (statics.length) lines.push(`    companion object${extras?.companionSupertype ? ` : ${extras.companionSupertype}` : ''} {`, ...statics, '    }');
		this.indent = '';
		const scriptName = this.scriptClassName(cls);
		const head = `${scriptName ? `@JSClassName(${kotlinString(scriptName)}) ` : ''}${abstract ? 'abstract ' : open ? 'open ' : ''}class ${ident(name)}${this.generics(cls)}`;
		const supers = [...(base ? [base] : []), ...supertypes];
		return [`${head}${supers.length ? ` : ${supers.join(', ')}` : ''} {`, ...lines, '}'].join('\n');
	},
};
