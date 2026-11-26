// Components and classes as Kotlin: a component's or service's members, interfaces and conformance, class declarations.
import ts from 'typescript';
import { atLossSite, HELD_LOSS } from '../semantics/losses.ts';
import { ident, isFunctionType, isNullable, kotlinString, nullishType, optionalType, ownReturns, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { UNKEYED, definesDuringConstruction, implementedOptionalMembers, restrictsField, definedField } from '../semantics/shapes.ts';
import { extendsHeritage, hasModifier, isLibDeclaration, nonSuperStatements } from '../semantics/ast.ts';
import { implementedInterfaces } from '../semantics/lang.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { isStatic } from '../semantics/throws.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { COLLECTION_OVERRIDE_METHODS, collectionBaseInfo } from '../semantics/classes.ts';

export const componentMethods = {
	/** A static field the module's statements initialize (`classDeclCode`'s statics): nullable until they run. */
	heldUntilModuleRuns(this: Translator, m: ts.PropertyDeclaration): boolean {
		const cls = m.parent;
		if (!ts.isClassDeclaration(cls) || !ts.isSourceFile(cls.parent) || !this.staticInModuleOrder(m)) return false;
		if (this.framework.componentClass(cls) || (!!cls.name && this.components.has(cls.name.text)) || this.patterns.mixinTarget(cls)) return false;
		const t = this.typeOf(m.name);
		return !(isUntyped(spelledType(t)) || t.endsWith('?') || this.zero(t));
	},

	/** The value a component's or service's constructor parameter is given: the framework's (an injected service), else its default. */
	constructorParameter(this: Translator, p: ts.ParameterDeclaration): string {
		const given = this.framework.hooks.constructorParameter?.(this, p);
		if (given !== undefined) return given;
		const pt = this.typeOf(p.name);
		if (p.initializer) return this.stored(p.initializer, p, pt);
		return isNullable(pt) || isUntyped(spelledType(pt)) ? 'null' : this.fromAny('null', pt);
	},

	/** A component's members; the caller adds `render()`. Returns the constructor parameters and the lines inside the class. */
	componentMembers(this: Translator, cls: ts.ClassDeclaration, props: string[], plainFields?: boolean): { params: string[]; lines: string[]; statics: string[] } {
		const at = this.translating;
		this.translating = cls;
		try {
			return this.componentMembersCode(cls, props, plainFields);
		} finally {
			this.translating = at;
		}
	},

	componentMembersCode(this: Translator, cls: ts.ClassDeclaration, props: string[], plainFields?: boolean): { params: string[]; lines: string[]; statics: string[] } {
		if (plainFields === undefined) plainFields = this.plainFields;
		this.props = new Set(props);
		const lines: string[] = [];
		const params: string[] = [];
		// A component's or service's static members, in its companion object.
		const statics: string[] = [];
		const staticAccessors = new Set<string>();
		this.indent = '        ';
		for (const m of cls.members) {
			if (!isStatic(m)) continue;
			if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name)) {
				const t = this.typeOf(m.name);
				const constant = hasModifier(m, ts.SyntaxKind.ReadonlyKeyword);
				statics.push(m.initializer ? `        ${constant ? 'val' : 'var'} ${ident(m.name.text)}: ${t} = ${this.stored(m.initializer, m, t)}` : `        ${this.deferredDeclaration(ident(m.name.text), t)}`);
			} else if (ts.isMethodDeclaration(m) && m.body) statics.push('        ' + this.func(m, ident(m.name.getText())));
			else if ((ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && ts.isIdentifier(m.name)) {
				const n = m.name.text;
				if (staticAccessors.has(n)) continue;
				staticAccessors.add(n);
				const get = cls.members.find((x): x is ts.GetAccessorDeclaration => ts.isGetAccessorDeclaration(x) && isStatic(x) && x.name.getText() === n);
				const set = cls.members.find((x): x is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(x) && isStatic(x) && x.name.getText() === n);
				const t = get ? this.returnTypeOf(get) : this.typeOf(set!.parameters[0].name);
				statics.push(`        ${set ? 'var' : 'val'} ${ident(n)}: ${t}`, get ? `            get() ${this.functionBody(get, t, '            ')}` : `            get() = ${isNullable(t) || isUntyped(spelledType(t)) ? 'null' : (this.zero(t) ?? 'null')}`);
				if (set) statics.push(`            set(${ident((set.parameters[0].name as ts.Identifier).text)}) ${this.functionBody(set, 'Unit', '            ')}`);
			} else if (m.kind !== ts.SyntaxKind.ClassStaticBlockDeclaration || (m as ts.ClassStaticBlockDeclaration).body.statements.length) throw this.error(m, 'a static member of this kind in a component or service');
		}
		this.indent = '    ';
		const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
		if (ctor?.parameters.length && !props.length) {
			for (const p of ctor.parameters) {
				const pName = (p.name as ts.Identifier).text;
				const pt = this.typeOf(p.name);
				const val = this.constructorParameter(p);
				const isParamProp = (ts.getModifiers(p) ?? []).some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword || mod.kind === ts.SyntaxKind.PublicKeyword || mod.kind === ts.SyntaxKind.ReadonlyKeyword);
				if (isParamProp) {
					const reassigned = !hasModifier(p, ts.SyntaxKind.ReadonlyKeyword) && this.isAssigned(cls, pName);
					params.push(`${reassigned ? 'var' : 'val'} ${ident(pName)}: ${pt} = ${val}`);
				} else {
					params.push(`${ident(pName)}: ${pt} = ${val}`);
				}
			}
		}
		const seenAccessors = new Set<string>();
		for (const m of cls.members) {
			if (isStatic(m)) continue;
			if (ts.isPropertyDeclaration(m)) {
				const name = (m.name as ts.Identifier).text;
				if (this.states.nullishHeld(m)) {
					const held = nullishType(this.typeOf(m.name));
					this.indent = '        ';
					lines.push(`    var ${ident(name)}: ${held} = ${m.initializer ? this.stored(m.initializer, m, held) : 'JSNullish.Undefined'}`);
					this.indent = '    ';
					continue;
				}
				const callee = m.initializer ? this.calleeName(m.initializer) : '';
				const field = this.framework.hooks.componentField?.(this, m, name);
				if (field && 'prop' in field) {
					const { type: t, default: given } = field.prop;
					const unset = this.framework.unsetError(m, given);
					if (unset !== undefined) {
						// Its parent sets it once the component is made; read before then, its signal throws the framework's error.
						lines.push(`    val ${ident(name)}: Signal<${t}> = ${this.newSignal(t, 'Signal.placeholder()', 'identity')}.unset(${kotlinString(unset)})`);
						continue;
					}
					params.push(`${ident(name)}: ${t}${given === undefined ? '' : ` = ${given}`}`);
					lines.push(`    val ${ident(name)}: Signal<${t}> = ${this.newSignal(t, ident(name), 'identity')}`);
					continue;
				}
				if (field && 'lines' in field) {
					lines.push(...field.lines);
					continue;
				}
				// A field holding another signal (`dayColor = ink`, a module's memo): read through it, so each read is the signal's current value.
				if (this.signalAlias(m)) {
					lines.push(`    val ${ident(name)}: ${this.typeOf(m.name)}`, `        get() = ${this.signalValue(m.initializer!)}`);
					continue;
				}
				// `signal.asReadonly()`: a field reading the signal it wraps.
				if (/\.asReadonly$/.test(callee) && ts.isPropertyAccessExpression((m.initializer as ts.CallExpression).expression)) {
					const source = ((m.initializer as ts.CallExpression).expression as ts.PropertyAccessExpression).expression;
					lines.push(`    val ${ident(name)}: ${this.typeOf(m.name)}`, `        get() = ${this.expr(source)}.value`);
					continue;
				}
				if (this.framework.memoized(m, this.checker)) {
					lines.push(...this.memoField(m, name));
					continue;
				}
				const t = this.typeOf(m.name);
				if (name === '$passed') {
					// The props the parent gave, for a spread that passes on only those.
					params.push('_passed: Set<String> = emptySet()');
					lines.push('    val _passed: Set<String> = _passed');
					continue;
				}
				// A field without an initializer is a field like any other where the framework declares props otherwise.
				if (!m.initializer && plainFields && !this.props.has(name)) {
					// One the class tests for (a view kept from its `loaded` event): missing until then, unwrapped where it is read.
					if (this.isObjectType(t) && !isNullable(t) && !isFunctionType(t) && this.memberTruthTested(cls, name)) {
						const sym = this.checker.getSymbolAtLocation(m.name);
						if (sym) this.nullableDecls.add(sym);
						lines.push(`    var ${ident(name)}: ${optionalType(t)} = null`);
						continue;
					}
					lines.push(`    ${this.deferredDeclaration(ident(name), t)}`);
					continue;
				}
				if (!m.initializer) {
					// A prop the parent may leave out is undefined.
					params.push(`${ident(name)}: ${t}${m.questionToken && isNullable(t) ? ' = null' : ''}`);
					lines.push(`    val ${ident(name)}: Signal<${t}> = ${this.newSignal(t, ident(name), 'identity')}`);
					continue;
				}
				this.indent = '        ';
				// A field the class assigns after construction (a script's `let`) is a Kotlin `var`.
				const reassigned = !hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) && this.isAssigned(cls, name);
				lines.push(`    ${reassigned ? 'var' : 'val'} ${ident(name)}: ${t} = ${this.stored(m.initializer, m, t)}`);
				this.indent = '    ';
				continue;
			}
			if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
				const aName = (m.name as ts.Identifier).text;
				if (seenAccessors.has(aName)) continue;
				seenAccessors.add(aName);
				const get = cls.members.find((x): x is ts.GetAccessorDeclaration => ts.isGetAccessorDeclaration(x) && x.name.getText() === aName && !isStatic(x));
				const set = cls.members.find((x): x is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(x) && x.name.getText() === aName && !isStatic(x));
				if (get && !set) {
					const t = this.returnTypeOf(get);
					lines.push(`    val ${ident(aName)}: ${t}`, `        get() ${this.functionBody(get, t, '        ')}`);
				} else if (set) {
					const t = get ? this.returnTypeOf(get) : this.typeOf(set.parameters[0].name);
					const p = set.parameters[0].name as ts.Identifier;
					const getLine = get ? `        get() ${this.functionBody(get, t, '        ')}` : `        get() = ${isNullable(t) || isUntyped(spelledType(t)) ? 'null' : (this.zero(t) ?? 'null')}`;
					const setLine = `        set(${ident(p.text)}) ${this.functionBody(set, 'Unit', '        ')}`;
					lines.push(`    var ${ident(aName)}: ${t}`, getLine, setLine);
				}
				continue;
			}
			if (ts.isMethodDeclaration(m)) {
				// An overload's signature: Kotlin's one function is the implementation's.
				if (!m.body) continue;
				this.templateParams = /^\$[be]\d+$/.test(m.name.getText());
				// A template's own bindings and handlers are read only by the module's generated views.
				try {
					lines.push('    ' + this.func(m, ident((m.name as ts.Identifier).text), this.templateParams ? 'internal ' : ''));
				} finally {
					this.templateParams = false;
				}
				continue;
			}
		}
		for (const m of implementedOptionalMembers(cls, this.checker)) lines.push(`    var ${ident(m.name.text)}: ${optionalType(this.typeOf(m))} = null`);
		// The constructor's body runs once every field has its value, as TypeScript's class fields come first.
		const ctorStmts = nonSuperStatements(ctor);
		if (ctorStmts.length && ctor?.body && ownReturns(ctor.body)) {
			this.returnLabel = '__ctor';
			this.indent = '            ';
			try {
				lines.push(`    init {\n        run __ctor@{\n${this.statements(ctorStmts).join('\n')}\n        }\n    }`);
			} finally {
				this.returnLabel = null;
			}
		} else if (ctorStmts.length) {
			this.indent = '        ';
			lines.push(`    init {\n${this.statements(ctorStmts).join('\n')}\n    }`);
		}
		this.indent = '';
		statics.push(...(this.framework.hooks.componentStatics?.(this, cls) ?? []));
		return { params, lines, statics };
	},

	/** A component created as a root view (bootstrap, route, dialog): made and rendered as the framework makes it. */
	rootView(this: Translator, cls: ts.ClassDeclaration, type: string, make: string): string {
		return this.framework.hooks.wrapRootView ? this.framework.hooks.wrapRootView(this, cls, type, make) : make;
	},

	/**
	 * `Object.defineProperty` on an app class's instance that makes one of its declared fields an accessor, read-only,
	 * hidden or fixed: the class's Kotlin field keeps none of these.
	 */
	checkFieldDefinition(this: Translator, target: ts.Expression, key: ts.Node | undefined, descriptor: ts.Node): void {
		if (this.library) return;
		const cls = this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)).getSymbol()?.valueDeclaration;
		if (!cls || !ts.isClassLike(cls) || cls.getSourceFile().isDeclarationFile || this.pluginFiles.has(cls.getSourceFile().fileName)) return;
		if (!restrictsField(descriptor)) return;
		const keyText = key && (ts.isStringLiteralLike(key) || ts.isIdentifier(key) || ts.isNumericLiteral(key)) ? key.text : undefined;
		const field = keyText !== undefined ? this.checker.getTypeAtLocation(target).getProperty(keyText)?.valueDeclaration : undefined;
		const declared = !!field && (ts.isPropertyDeclaration(field) || ts.isParameter(field)) && !field.getSourceFile().isDeclarationFile;
		if (keyText !== undefined && !declared) return;
		const during = keyText !== undefined && definesDuringConstruction(target);
		if (keyText !== undefined && !during && definedField(this.states, () => this.shapeFacts(), target, keyText)) return;
		throw this.error(
			key ?? target,
			keyText === undefined ? 'Object.defineProperty with a key known only at run time on a class instance, with a descriptor that may restrict a declared field' : during ? `Object.defineProperty on \`this\` while its class constructs it, making a declared field (${keyText}) an accessor, read-only, hidden or fixed: the constructor and field initializers read the Kotlin field directly; define it after \`new\` returns` : `Object.defineProperty making a declared field (${keyText}) of a class whose objects keep no descriptor for it (an Error subclass's) an accessor, read-only, hidden or fixed`,
		);
	},

	/** A method of an app's generic interface that is a Kotlin interface, which holds the interface's type parameters as `Any?`. */
	erasingInterface(this: Translator, m: ts.MethodSignature): boolean {
		const iface = m.parent;
		return ts.isInterfaceDeclaration(iface) && !!iface.typeParameters?.length && !iface.getSourceFile().isDeclarationFile && this.protocols.has(this.topName(iface, iface.name.text));
	},

	calleeName(this: Translator, e: ts.Expression): string {
		return ts.isCallExpression(e) ? e.expression.getText() : '';
	},

	/** The names an app class's members override: its app base classes' and its interfaces'. */
	overridden(this: Translator, cls: ts.ClassLikeDeclaration, implemented?: string[]): Set<string> {
		const out = new Set<string>();
		const c = this.checker;
		const addInterface = (h: ts.ExpressionWithTypeArguments) => {
			if (implemented && h.parent.parent === cls && !implemented.includes(this.implementedName(h))) return;
			const t = c.getTypeAtLocation(h);
			if (isLibDeclaration(t.getSymbol()?.declarations?.[0]) || this.untranslatedInterface(h) || this.declaredOnlyInterface(h)) return;
			// A class implemented as an interface (core's `implements ListViewDefinition`, a subclass of its own) is no supertype.
			if (this.library && t.getSymbol()?.declarations?.some((d) => ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile)) return;
			// Library mode: an interface only a declaration file has is no Kotlin interface (`implementedInterfaces` leaves it out).
			if (this.library && (t.getSymbol()?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile)) return;
			for (const p of t.getProperties()) out.add(p.name);
		};
		for (const n of this.classPlan(cls).inherited) out.add(n);
		const col = collectionBaseInfo(cls, c);
		if (col) for (const n of COLLECTION_OVERRIDE_METHODS[col.kind]) out.add(n);
		for (let b: ts.ClassLikeDeclaration | undefined = cls; b;) {
			for (const i of b.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? []) addInterface(i);
			for (const d of this.structural.get(b) ?? []) if (b !== cls || !implemented || implemented.includes(this.topName(d, d.name.text))) for (const m of d.members) if (m.name) out.add(m.name.getText());
			const h: ts.ExpressionWithTypeArguments | undefined = b.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			const d: ts.Declaration | undefined = h && c.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
			b = d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
		}
		return out;
	},

	/** The Kotlin name of an interface a class names in its `implements` clause. */
	implementedName(this: Translator, i: ts.ExpressionWithTypeArguments): string {
		const text = ts.isPropertyAccessExpression(i.expression) ? i.expression.name.text : i.expression.getText();
		const d = this.checker.getTypeAtLocation(i).getSymbol()?.declarations?.find(ts.isInterfaceDeclaration);
		return d && !d.getSourceFile().isDeclarationFile ? this.topName(d, text) : text;
	},

	/** The interfaces a class implements, named or met, that are Kotlin interfaces it implements; `witnesses` gets the adapters its methods need. */
	implementedProtocols(this: Translator, cls: ts.ClassLikeDeclaration, witnesses: string[], notOverrides: Set<string>): string[] {
		const implemented: string[] = implementedInterfaces(this.checker, cls)
			.filter((i) => !isLibDeclaration(this.checker.getTypeAtLocation(i).getSymbol()?.declarations?.[0]))
			// An interface of a module that is not translated (a package's `types.ts`, which declares only types) is no Kotlin interface.
			.filter((i) => !this.untranslatedInterface(i))
			// Library mode: an interface only a declaration file has is no Kotlin interface.
			.filter((i) => !this.library || !(this.checker.getTypeAtLocation(i).getSymbol()?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile))
			.filter((i) => !this.declaredOnlyInterface(i))
			// What an app implements of a framework's interfaces called untyped (`Validator`), or a package's class of a
			// stand-in's interface (`OnDestroy`): no Kotlin interface, as Swift writes no protocol.
			.filter((i) => !this.framework.untypedInterface(this.checker.getTypeAtLocation(i).getSymbol()?.declarations ?? [], this.pluginFiles.has(cls.getSourceFile().fileName)))
			// The generated kit: an interface core declares that the kit has no type for (`TraceWriter`, which core holds untyped).
			.filter((i) => !this.generatedKit || !isCoreDeclaration(this.checker.getTypeAtLocation(i).getSymbol()?.declarations?.[0]) || !!this.core?.has(ts.isPropertyAccessExpression(i.expression) ? i.expression.name.text : i.expression.getText()))
			// An interface the class's signatures cannot meet is left out; untyped parameters meet it through a witness.
			.filter((i) => this.protocolWitnesses(cls, this.checker.getTypeAtLocation(i).getSymbol()?.declarations?.find(ts.isInterfaceDeclaration), this.implementedName(i), witnesses, notOverrides))
			.map((i) => this.implementedName(i));
		for (const d of this.structural.get(cls) ?? []) {
			const name = this.topName(d, d.name.text);
			if (!implemented.includes(name) && this.protocolWitnesses(cls, d, name, witnesses, notOverrides)) implemented.push(name);
		}
		return implemented;
	},

	/** A child component's input held as `JSNullish<T>`: a binding's value (its method's result, or a static attribute's text) converted to it. */
	propValue(this: Translator, cls: ts.ClassDeclaration, child: ts.ClassDeclaration | undefined, prop: string, method: string | null): ((value: string) => string) | null {
		const field = child?.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === prop);
		const to = field && /^Signal<JSNullish<(.*)>>$/.exec(this.typeOf(field.name))?.[1];
		if (!to) return null;
		const m = method === null ? undefined : cls.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === method);
		const from = method === null ? 'String' : m ? this.returnTypeOf(m) : 'Any?';
		if (from === `JSNullish<${to}>`) return null;
		if (isUntyped(spelledType(from))) return (v) => this.nullishOfAny(v, to);
		return (v) => `JSNullish.of(${v})`;
	},

	/**
	 * A component class's supertypes for the app interfaces it implements, the names its members override, and the
	 * members it adds: every app interface extends JSDynamic, which here reads and writes the interfaces' fields only.
	 */
	componentConformance(this: Translator, cls: ts.ClassDeclaration): { supertypes: string[]; overrides: Set<string>; lines: string[] } {
		const witnesses: string[] = [];
		const notOverrides = new Set<string>();
		const appInterface = (n: string) => this.protocols.has(n) && [...implementedInterfaces(this.checker, cls).map((i) => this.checker.getTypeAtLocation(i).getSymbol()?.declarations?.find(ts.isInterfaceDeclaration)), ...(this.structural.get(cls) ?? [])].some((d) => !!d && this.topName(d, d.name.text) === n && !d.getSourceFile().isDeclarationFile);
		const heritage = extendsHeritage(cls);
		const baseSuper = heritage && this.classPlan(cls).base ? [`${this.type(this.checker.getTypeAtLocation(heritage), heritage)}()`] : [];
		const supertypes = this.implementedProtocols(cls, witnesses, notOverrides).filter(appInterface);
		if (!supertypes.length) return { supertypes: baseSuper, overrides: new Set(), lines: [] };
		for (const i of supertypes) this.used.add(i);
		const overrides = this.overridden(cls, supertypes);
		for (const n of notOverrides) overrides.delete(n);
		const fields: { name: string; type: string }[] = [];
		const accessors: { name: string; type: string; readable: boolean; settable: boolean }[] = [];
		const seen = new Set<string>();
		for (const i of implementedInterfaces(this.checker, cls)) {
			const d = this.checker.getTypeAtLocation(i).getSymbol()?.declarations?.find(ts.isInterfaceDeclaration);
			if (!d || !supertypes.includes(this.topName(d, d.name.text))) continue;
			for (const m of this.withInherited(d, d.members)) {
				if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name) || seen.has(m.name.text)) continue;
				seen.add(m.name.text);
				const type = m.questionToken ? optionalType(this.typeOf(m)) : this.typeOf(m);
				const own = cls.members.find((x) => x.name?.getText() === m.name.getText());
				const readOnly = hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) || (!!own && hasModifier(own, ts.SyntaxKind.ReadonlyKeyword));
				if (readOnly) accessors.push({ name: m.name.text, type, readable: true, settable: false });
				else fields.push({ name: m.name.text, type });
			}
		}
		return { supertypes: [...baseSuper, ...supertypes], overrides, lines: [...witnesses, ...this.dynamicMembers(UNKEYED, { fields, className: cls.name?.text ?? null, accessors })] };
	},

	/**
	 * Whether a class can implement an interface. A method whose untyped
	 * parameters the interface types (`handle(error)` for `handle(error: Error)`)
	 * implements it through a witness of the interface's signature that calls
	 * it; any other difference leaves the interface out.
	 */
	protocolWitnesses(this: Translator, cls: ts.ClassLikeDeclaration, decl: ts.InterfaceDeclaration | undefined, name: string, out: string[], notOverrides: Set<string>): boolean {
		if (!decl || !this.protocols.has(name)) return true;
		const own = (name: string) => cls.members.find((x) => x.name?.getText() === name);
		const added: string[] = [];
		const skipped: string[] = [];
		for (const req of decl.members) {
			const name = req.name?.getText();
			const m = name ? own(name) : undefined;
			// A writable field the interface erases to any value, which a field typed by the class's type parameter can't override.
			if (name && ts.isPropertySignature(req) && !hasModifier(req, ts.SyntaxKind.ReadonlyKeyword) && this.isAny(req)) {
				const field = m ?? cls.members.find(ts.isConstructorDeclaration)?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name && ts.getModifiers(p)?.length);
				const t = field && (ts.isPropertyDeclaration(field) || ts.isParameter(field) || ts.isGetAccessorDeclaration(field) || ts.isSetAccessorDeclaration(field)) ? this.checker.getTypeAtLocation(field.name) : undefined;
				if (!this.ledger.genericsReified && t && t.flags & ts.TypeFlags.TypeParameter && t.symbol?.declarations?.[0]?.parent === cls) throw this.limit(field!, 'generic-field-erased', "a field typed by a generic class's type parameter, met as a generic interface's writable field");
			}
			if (!name || !m || !ts.isMethodSignature(req)) continue;
			if (!ts.isMethodDeclaration(m)) return false;
			const want = req.parameters.map((p) => this.requirementParamType(p));
			const have = m.parameters.map((p) => this.paramType(p));
			const ret = this.returnTypeOf(req),
				ownRet = this.returnTypeOf(m);
			if (want.length === have.length && want.every((t, k) => t === have[k]) && ret === ownRet) continue;
			// A generic class's own type parameter where the interface, which erases its own, takes or gives any value.
			const typeParameter = (t: string) => !!cls.typeParameters?.some((p) => p.name.text === t);
			const erased = (t: string, k: number) => isUntyped(spelledType(want[k])) && typeParameter(t);
			// Kotlin overrides with a narrower result.
			if (want.length === have.length && want.every((t, k) => t === have[k]) && isUntyped(spelledType(ret)) && typeParameter(ownRet)) continue;
			if (want.length !== have.length || have.some((t, k) => t !== want[k] && !isUntyped(spelledType(t)) && !erased(t, k)) || (ret !== ownRet && !isUntyped(spelledType(ret))) || want.every((t, k) => t === have[k])) return false;
			if (have.some(erased)) {
				// The witness and the method erase to one JVM signature: the method takes another JVM name, which an open one can't.
				if (this.extended.has(cls.name?.text ?? '') || (ts.isClassDeclaration(cls) && this.extendedDecls.has(cls)) || hasModifier(cls, ts.SyntaxKind.AbstractKeyword) || (ts.isClassDeclaration(cls) && this.literalClasses().has(cls))) throw this.error(m, "a method of a generic class that is extended, met as a generic interface's method");
				this.erasedSignatureMethods.add(m);
			}
			const args = req.parameters.map((p, k) => (ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`));
			const call = `${ident(name)}(${args.map((a, k) => (have[k] === want[k] ? a : erased(have[k], k) ? `${RT.jsUnchecked}<${have[k]}>(${a})` : `${a} as Any?`)).join(', ')})`;
			added.push(`    override fun ${ident(name)}(${want.map((t, k) => `${args[k]}: ${t}`).join(', ')})${ret === 'Unit' ? '' : `: ${ret}`} { ${ret === 'Unit' ? call : ownRet === 'Unit' ? `${call}; return null` : `return ${call}`} }`);
			skipped.push(name);
		}
		out.push(...added);
		for (const n of skipped) notOverrides.add(n);
		return true;
	},

	classDecl(this: Translator, cls: ts.ClassDeclaration): string {
		const at = this.translating;
		this.translating = cls;
		try {
			const code = this.suppressingDeprecations(() => (HELD_LOSS ? atLossSite('kotlin', this, cls, () => this.classDeclCode(cls)) : this.classDeclCode(cls)), false);
			return code ? this.docOf(cls) + this.threadAnnotation(cls) + code : code;
		} finally {
			this.translating = at;
		}
	},
};
