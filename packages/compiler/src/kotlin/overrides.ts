// Kit and app overrides as Kotlin: overload bridges, compiled members, top-level names.
import ts from 'typescript';
import { readByKey, replaceableMethod, definedField } from '../semantics/shapes.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { OBJECT_TO_STRING, functionTypeParts, ident, isFunctionType, isNullable, kotlinString, optionalType, splitTopLevel, substituteTypes, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { KOTLIN_NATIVE_TYPES } from './syntax.ts';
import { ambientAddedMemberOf, augmentedPropertyRead, isDomGlobalDeclaration, mergedInterfaceMemberOf, runtimeTypeName, tokenClassBase, undeclaredMemberOf, isArguments } from '../semantics/lang.ts';
import { THREAD_ANNOTATIONS } from '../semantics/threading.ts';
import { boundNames, hasModifier, isLibDeclaration, moduleBlockVars, withoutDefault } from '../semantics/ast.ts';
import { isCoreDeclaration, isShimDeclaration } from '../program/core-facts.ts';
import { isStatic } from '../semantics/throws.ts';
import { runtimeKitIndex } from './core-index.ts';
import { usedBefore } from '../semantics/async.ts';
import { declarationsNamedWith, keptDeclaration, moduleSuffixedName, namedObjectType } from '../semantics/top-names.ts';
import { COLLECTION_OVERRIDE_METHODS, programBase, prototypeDecorated, spellCollectionBase, toStringGivesNonString } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const overridesMethods = {
	/** App mode on the generated kit: a field declared without a value under the name of a property the kit class it extends has. */
	kitRedeclared(this: Translator, d: ts.Node | undefined): boolean {
		if (!this.generatedKit || !d || !ts.isPropertyDeclaration(d) || d.initializer || isStatic(d) || !ts.isIdentifier(d.name) || !ts.isClassLike(d.parent) || d.getSourceFile().isDeclarationFile) return false;
		const root = this.kitRootOf(d.parent);
		return !!root && this.core?.kitMember(root, d.name.text)?.kind === 'var';
	},

	/** The core class at the root of a class's chain of app and plugin classes, when kit-android has it. */
	kitRootOf(this: Translator, cls: ts.ClassLikeDeclaration): string | null {
		for (let b: ts.ClassLikeDeclaration | undefined = cls; b;) {
			const h: ts.ExpressionWithTypeArguments | undefined = b.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			if (!h) return null;
			const d: ts.Declaration | undefined = this.checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
			if (d && isCoreDeclaration(d) && ts.isClassLike(d) && d.name) {
				const kit = this.core?.kitClass(d.name.text);
				if (kit && this.core?.has(kit)) return kit;
			}
			if (d && isShimDeclaration(d) && ts.isClassLike(d) && d.name && (this.core ? this.core.subclassable(d.name.text) : runtimeKitIndex(this.config.adapter.kit).get(d.name.text)?.open)) return d.name.text;
			b = d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
		}
		return null;
	},

	/** `<A, B>` for a program class's type `t` with the type arguments its declaration takes; a plugin's generic class is untyped in them. */
	declaredTypeArguments(this: Translator, t: ts.Type, decl: ts.Declaration, where?: ts.Node): string {
		if (!ts.isClassDeclaration(decl) || decl.getSourceFile().isDeclarationFile || this.pluginFiles.has(decl.getSourceFile().fileName)) return '';
		const declared = decl.typeParameters?.length ?? 0;
		return declared
			? `<${this.checker
					.getTypeArguments(t as ts.TypeReference)
					.slice(0, declared)
					.map((a) => this.type(a, where))
					.join(', ')}>`
			: '';
	},

	/** An app class's name as script knows it, where its Kotlin name is another (it took its module's): null where they are one. */
	scriptClassName(this: Translator, cls: ts.ClassLikeDeclaration): string | null {
		const renamed = this.library || !cls.name ? undefined : this.topNames().get(cls);
		return renamed && !renamed.includes('.') ? cls.name!.text : null;
	},

	/** The Kotlin name of a class the program declares. */
	className(this: Translator, decl: ts.ClassLikeDeclaration): string {
		if (ts.isClassExpression(decl)) return this.classExprs.name(decl);
		return decl.name ? this.topName(decl, decl.name.text).split('.').map(ident).join('.') : 'AnonymousClass';
	},

	/**
	 * A class extending Array or Set that adds no instance state (`class TouchList extends Array { static empty() … }`):
	 * its instances are the kit's collection, its static members an object of its name.
	 */
	collectionAlias(this: Translator, decl: ts.Node | undefined): string | null {
		if (!decl || !ts.isClassDeclaration(decl) || decl.getSourceFile().isDeclarationFile) return null;
		const heritage = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		if (!heritage || !ts.isIdentifier(heritage.expression) || !['Array', 'Set'].includes(heritage.expression.text) || !isLibGlobal(this, heritage.expression)) return null;
		const kind = heritage.expression.text as 'Array' | 'Set';
		// A subclass overriding open collection methods (`add`/`has`/`delete`/`clear`) must be a real Kotlin subclass.
		if (decl.members.some((m) => !isStatic(m) && ts.isMethodDeclaration(m) && COLLECTION_OVERRIDE_METHODS[kind].includes(m.name.getText()))) return null;
		// Instance methods are extensions of the collection; a getter it has already (`length`) is its own.
		const instance = decl.members.filter((m) => !isStatic(m) && !(m.name && ts.isComputedPropertyName(m.name) && /Symbol\.toStringTag/.test(m.name.getText())) && !ts.isMethodDeclaration(m) && !(ts.isGetAccessorDeclaration(m) && ['length', 'size'].includes(m.name.getText())));
		if (instance.length) return null;
		const arg = heritage.typeArguments?.[0];
		const el = arg ? this.type(this.checker.getTypeFromTypeNode(arg), arg) : 'Any?';
		return kind === 'Array' ? `JSArray<${el}>` : `JSSet<${el}>`;
	},

	/** Kotlin kit collection supertype for a class extending `Map`, `Set`, or `Array` directly or through a program base. */
	collectionSuperType(this: Translator, cls: ts.ClassLikeDeclaration): string | null {
		return spellCollectionBase(cls, this.checker, (t, n) => this.type(t, n));
	},

	/** `global` or `globalThis` as declarations give them: the program's global object. */
	isGlobalObject(this: Translator, e: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
		return ts.isIdentifier(e) && (e.text === 'global' || e.text === 'globalThis') && (this.resolve(e)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile);
	},

	/** `fooProperty.setNative`: the registered name of the property it belongs to. */
	setNativeOf(this: Translator, e: ts.Expression): string | null {
		if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'setNative') return null;
		return this.properties?.name(this.resolve(e.expression)) ?? null;
	},

	/** The kit class a mixin class (`applyMixins(View, [Extended])`) is applied to. */
	mixinOf(this: Translator, sym: ts.Symbol | undefined): string | null {
		const d = sym?.valueDeclaration;
		return d && ts.isClassDeclaration(d) ? this.patterns.mixinTarget(d) : null;
	},

	/**
	 * A method overriding kit-android's: the kit's Kotlin signature, the
	 * TypeScript body seeing its own types; what it throws is reported, as an
	 * error escaping a native callback is.
	 */
	kitOverride(this: Translator, m: ts.MethodDeclaration, kit: { type: string; params?: string }): string {
		return this.suppressingDeprecations(() => this.kitOverrideCode(m, kit));
	},

	kitOverrideCode(this: Translator, m: ts.MethodDeclaration, kit: { type: string; params?: string }): string {
		const kitParams = (kit.params ?? '').trim() ? splitTopLevel(kit.params!) : [];
		const parsed = kitParams.map((p) => {
			const colon = p.indexOf(':');
			const type = withoutDefault(p.slice(colon + 1)).trim();
			return { name: p.slice(0, colon).trim().replace(/^`|`$/g, ''), type };
		});
		const sig = this.signatureNames(
			m,
			parsed.map((p) => p.name),
			(k) => `__k${k}`,
		);
		const tsRet = this.returnTypeOf(m);
		const ret = kit.type.trim();
		const binds = m.parameters
			.map((p, k) => {
				const tsType = this.typeOf(p.name);
				const value = parsed[k] ? this.convert(sig[k], parsed[k].type, tsType) : (this.zero(tsType) ?? 'null');
				return ts.isIdentifier(p.name) && !(value === ident(p.name.text) && tsType === parsed[k]?.type) ? `        val ${ident(p.name.text)}: ${tsType} = ${value}` : '';
			})
			.filter(Boolean);
		const body = this.inFunction(tsRet, () => this.functionBody(m, tsRet, '        '));
		const call = `(fun(): ${tsRet} ${body})()`;
		const result = ret === 'Unit' ? `        ${RT.jsReport} { ${call} }` : `        val __result: ${tsRet} = ${call}\n        return ${this.convert('__result', tsRet, ret)}`;
		return [`    override fun ${ident(m.name.getText())}(${parsed.map((p, k) => `${sig[k]}: ${p.type}`).join(', ')})${ret === 'Unit' ? '' : `: ${ret}`} {`, ...binds, result, '    }'].join('\n');
	},

	/** Kotlin code of type `from` where Kotlin needs `to`. */
	convert(this: Translator, code: string, from: string, to: string): string {
		if (from === to || isUntyped(spelledType(to))) return code;
		// A function of other parameter or result types (`(EventData) -> Unit` where `(Any?) -> Unit` is declared): adapted, each value converted.
		const f = isFunctionType(from) ? functionTypeParts(from) : null,
			g = isFunctionType(to) ? functionTypeParts(to) : null;
		if (this.library && f && g && f.params.length === g.params.length) {
			const names = g.params.map((_, k) => this.marks.pureCode(`__c${k}`));
			const call = `__f(${f.params.map((p, k) => this.convert(names[k], g.params[k], p)).join(', ')})`;
			const result = g.ret !== 'Unit' ? this.convert(call, f.ret, g.ret) : f.ret === 'Unit' ? call : `${call}; Unit`;
			return `${code}.let { __f -> { ${g.params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> ${result} } }`;
		}
		if (isUntyped(spelledType(from))) return this.fromAny(code, to);
		if (to === optionalType(from)) return code;
		// An array of one element type where another is declared (`string[]` given as `any[]`): the same array, as script shares it.
		if (/^JSArray<.*>$/.test(from.replace(/\?$/, '')) && /^JSArray<.*>$/.test(to.replace(/\?$/, '')) && from.replace(/\?$/, '') !== to.replace(/\?$/, '')) return this.unchecked(to, code);
		// A tuple where an array is declared: its elements.
		const tuple = /^(Pair|Triple)<.*>$/.exec(from),
			array = /^JSArray<(.*)>\??$/.exec(to);
		if (tuple && array) return `${code}.let { __t -> ${RT.jsArrayOf}<${array[1]}>(${(tuple[1] === 'Triple' ? ['first', 'second', 'third'] : ['first', 'second']).map((m) => `__t.${m}`).join(', ')}) }`;
		if (from === optionalType(to)) return this.asserted(code);
		const numeric = /^(Int|Long|Float|Short|Byte)\??$/.exec(from);
		if (numeric && to.startsWith('Double')) return from.endsWith('?') ? `${code}?.toDouble()` : `${code}.toDouble()`;
		// An object of a known shape where a dictionary is wanted: a dictionary of its entries.
		const record = /^JSRecord<(.+)>$/.exec(to.replace(/\?$/, ''));
		const fromShape = from.replace(/\?$/, '');
		if (record && (this.interfaces.has(fromShape) || !!this.shapes.named(fromShape))) {
			const entries = `JSRecord<${record[1]}>(__s.jsKeys.map { __k -> Pair(__k, ${this.fromAny('__s.jsGet(__k)', record[1])}) })`;
			return from.endsWith('?') ? `${code}?.let { __s -> ${entries} }` : `${code}.let { __s -> ${entries} }`;
		}
		// One object shape where another is declared (a wider shape an override returns): not a subclass, read by its keys.
		const shape = to.replace(/\?$/, '');
		if (from.replace(/\?$/, '') !== shape && (this.interfaces.has(shape) || !!this.shapes.named(shape))) return this.fromAny(code, to);
		if (this.isObjectType(from) && this.isObjectType(to) && from.replace(/\?$/, '') !== to.replace(/\?$/, '')) return this.classCast(code, from, to);
		return code;
	},

	/** A field of this name the program's class declares on a type or a type it extends (an interface's method may stand for it). */
	fieldIn(this: Translator, t: ts.Type, name: string, seen = new Set<ts.Type>()): ts.PropertyDeclaration | undefined {
		if (seen.has(t)) return undefined;
		seen.add(t);
		const own = t.getProperty(name)?.declarations?.find((d): d is ts.PropertyDeclaration => ts.isPropertyDeclaration(d) && !d.getSourceFile().isDeclarationFile);
		if (own) return own;
		const target = (t as ts.TypeReference).target ?? t;
		for (const b of target.isClassOrInterface() ? this.checker.getBaseTypes(target as ts.InterfaceType) : []) {
			const found = this.fieldIn(b, name, seen);
			if (found) return found;
		}
		return undefined;
	},

	/** The field of this name the compiled class of a type core's declarations describe (by its name) or one it extends declares. */
	compiledField(this: Translator, t: ts.Type, name: string): ts.PropertyDeclaration | undefined {
		const cls = this.compiledClasses().get(t.getSymbol()?.name ?? '');
		for (let b: ts.ClassLikeDeclaration | undefined = cls; b; b = programBase(b, this.checker)) {
			const m = b.members.find((x): x is ts.PropertyDeclaration => ts.isPropertyDeclaration(x) && x.name.getText() === name);
			if (m) return m;
		}
		return undefined;
	},
	/**
	 * Library mode: a name imported from a module a compiled app has no use for (an npm package, the debugger): the kit's
	 * counterpart where it has one, else undefined.
	 */
	mootImport(this: Translator, e: ts.Identifier): string | null {
		if (!this.library) return null;
		const decl = this.checker.getSymbolAtLocation(e)?.declarations?.[0];
		const imported = decl && ts.findAncestor(decl, ts.isImportDeclaration);
		const module = imported && this.checker.getSymbolAtLocation(imported.moduleSpecifier)?.valueDeclaration;
		const file = module?.getSourceFile().fileName;
		if (!decl || !file?.startsWith('/__moot__/')) return null;
		const name = ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text : ts.isNamespaceImport(decl) ? '*' : 'default';
		return this.library.counterpart(file, name) ?? 'null';
	},

	/** Whether a compiled class or one it extends declares a member of this name. */
	compiledMember(this: Translator, cls: ts.ClassLikeDeclaration, name: string): boolean {
		for (let b: ts.ClassLikeDeclaration | undefined = cls; b; b = programBase(b, this.checker)) if (b.members.some((m) => m.name?.getText() === name) || this.facts.prototypeKeys().data.has(name) || this.facts.prototypeKeys().accessors.has(name)) return true;
		return false;
	},
	compiledClasses(this: Translator): Map<string, ts.ClassDeclaration> {
		if (this.compiledByName) return this.compiledByName;
		this.compiledByName = new Map();
		for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) for (const st of sf.statements) if (ts.isClassDeclaration(st) && st.name && !hasModifier(st, ts.SyntaxKind.DeclareKeyword)) this.compiledByName.set(st.name.text, st);
		return this.compiledByName;
	},

	/**
	 * Library mode: a method's Kotlin name. One named as a property's JVM accessor (`setNativeView` beside `nativeView`,
	 * `setAutoSystemAppearanceChanged`) clashes with it on the JVM, and takes a suffix wherever it is declared or called.
	 */
	methodIdent(this: Translator, name: string): string {
		if (!this.library) return ident(name);
		if (!this.clashNames) {
			const props = new Set<string>();
			const methods: string[] = [];
			for (const sf of this.sourceFiles) {
				if (sf.isDeclarationFile) continue;
				const visit = (n: ts.Node): void => {
					if (ts.isClassLike(n)) {
						for (const m of n.members) {
							if (!m.name || !ts.isIdentifier(m.name) || isStatic(m)) continue;
							if (ts.isPropertyDeclaration(m) || ts.isAccessor(m)) props.add(m.name.text);
							else if (ts.isMethodDeclaration(m)) methods.push(m.name.text);
							else if (ts.isConstructorDeclaration(m)) for (const p of m.parameters) if (ts.isIdentifier(p.name) && ts.getModifiers(p)?.length) props.add(p.name.text);
						}
					}
					ts.forEachChild(n, visit);
				};
				visit(sf);
			}
			this.clashNames = new Set(
				methods.filter((m) => {
					const a = /^(get|set)([A-Z]\w*)$/.exec(m);
					return (a && props.has(a[2][0].toLowerCase() + a[2].slice(1))) || (/^is[A-Z]/.test(m) && props.has(m));
				}),
			);
		}
		return ident(this.clashNames.has(name) ? `${name}_` : name);
	},

	/** The Kotlin name of the compiled method `sym` names as `name`: a toString that may give no string is apart from Any's. */
	compiledMethodIdent(this: Translator, sym: ts.Symbol, name: string): string {
		const d = sym.valueDeclaration ?? sym.declarations?.[0];
		return d && ts.isMethodDeclaration(d) && toStringGivesNonString(d, this.checker) ? OBJECT_TO_STRING : this.methodIdent(name);
	},

	/** Whether a method is the compiled kit's (the program's, or core's declarations of it), not a Java or library one. */
	isCompiledMethod(this: Translator, sym: ts.Symbol): boolean {
		const d = sym.valueDeclaration ?? sym.declarations?.[0];
		return !!d && (ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) && !isLibDeclaration(d) && !this.native?.isNativeDeclaration(d);
	},

	/** Library mode: a class leaving an abstract method of its base unimplemented (`TextFieldBase` over `EditableTextBase`), abstract in Kotlin. */
	leavesAbstract(this: Translator, cls: ts.ClassLikeDeclaration): boolean {
		const implemented = new Set<string>();
		for (let b: ts.ClassLikeDeclaration | undefined = cls; b; b = programBase(b, this.checker)) {
			for (const m of b.members) {
				if (!m.name || !(ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isAccessor(m))) continue;
				const n = m.name.getText();
				if (hasModifier(m, ts.SyntaxKind.AbstractKeyword) && !implemented.has(n)) return true;
				implemented.add(n);
			}
		}
		return false;
	},

	/** An override taking the overridden method's Kotlin parameters, bound to its own as TypeScript types them. */
	appOverride(this: Translator, m: ts.MethodDeclaration, base: ts.MethodDeclaration, name?: string): string {
		if (name === undefined) name = this.methodIdent(m.name.getText());
		return this.suppressingDeprecations(() => this.appOverrideCode(m, base, name));
	},

	appOverrideCode(this: Translator, m: ts.MethodDeclaration, base: ts.MethodDeclaration, name: string): string {
		// The base's signature as the subclass instantiates it (`create(): T` of `Test<Label>` is `create(): Label`).
		const args = ts.isClassLike(m.parent) && ts.isClassLike(base.parent) ? this.baseTypeArgs(m.parent, base.parent) : new Map<string, string>();
		const baseTypes = base.parameters.map((p) => substituteTypes(this.paramType(p), args));
		const baseRet = substituteTypes(this.returnTypeOf(base), args);
		// A number, string or boolean where the base gives an object (`getDefault(): number { return null }` over a Drawable): the base's.
		const ret = ['Double', 'String', 'Boolean'].includes(this.returnTypeOf(m)) && isNullable(baseRet) && !isUntyped(spelledType(baseRet)) && !['Double?', 'String?', 'Boolean?'].includes(baseRet) ? baseRet : this.returnTypeOf(m);
		const sig = this.signatureNames(m, this.paramNames(base), (k) => `__o${k}`);
		const binds = m.parameters
			.map((p, k) => {
				if (!ts.isIdentifier(p.name)) return '';
				const own = this.paramType(p);
				const sym = this.checker.getSymbolAtLocation(p.name);
				if (sym && this.states.mayBeNull(p)) this.nullableDecls.add(sym);
				if (this.library && k < baseTypes.length && this.unreadParameter(m, p)) return '';
				// A rest parameter over the base's fixed ones (`showModal(...args)`): the arguments from here on, as many as script
				// passed, which code reads through `args.length`.
				if (p.dotDotDotToken) {
					const rest = baseTypes.slice(k).map((_, j) => sig[k + j] ?? `__o${k + j}`);
					return `        val ${ident(p.name.text)}: ${own} = (JSArray<Any?>(listOf<Any?>(${rest.join(', ')}).dropLastWhile { it == null }) as ${own.replace(/\?$/, '')})`;
				}
				// Library mode: a class narrower than the base's (`child: View` where core passes any ViewBase, a NavigationButton):
				// held as the base's, cast only where code needs the narrower class, as script trusts it.
				if (this.library && k < baseTypes.length && this.isObjectType(own) && this.isObjectType(baseTypes[k]) && own.replace(/\?$/, '') !== baseTypes[k].replace(/\?$/, '') && /^[A-Z]\w*\??$/.test(own) && /^[A-Z]\w*\??$/.test(baseTypes[k])) {
					this.widenedAccessors.set(p, optionalType(baseTypes[k]));
					this.widenedParams.set(p, { base: this.checker.getTypeAtLocation(base.parameters[k].name), own: optionalType(own) });
					return sig[k] === ident(p.name.text) && optionalType(baseTypes[k]) === baseTypes[k] ? '' : `        val ${ident(p.name.text)}: ${optionalType(baseTypes[k])} = ${sig[k]}`;
				}
				const value = k < baseTypes.length ? this.convert(sig[k], baseTypes[k], own) : (this.zero(own) ?? 'null');
				return value === ident(p.name.text) && own === baseTypes[k] ? '' : `        val ${ident(p.name.text)}: ${own} = ${value}`;
			})
			.filter(Boolean);
		const head = `    override fun ${name}(${baseTypes.map((t, k) => `${sig[k] ?? `__o${k}`}: ${t}`).join(', ')})${baseRet === 'Unit' ? '' : `: ${baseRet}`} {`;
		// A result the base's signature takes as it is: the body is the override's own.
		if ((ret === baseRet || (ret !== 'Unit' && baseRet !== 'Unit' && this.convert('__r', ret, baseRet) === '__r')) && !(binds.length && this.paramPrelude(m).length)) {
			const body = this.functionBody(m, ret, '    ');
			return [head, ...binds, body.slice(2)].join('\n');
		}
		const body = this.inFunction(ret, () => this.functionBody(m, ret, '        '));
		const call = `(fun()${ret === 'Unit' ? '' : `: ${ret}`} ${body})()`;
		const result = baseRet === 'Unit' ? `        ${call}` : `        return ${this.convert(call, ret, baseRet)}`;
		return [head, ...binds, result, '    }'].join('\n');
	},

	/** Whether a class (or a class it extends) names the interface in its `implements` or `extends`, which its Kotlin class then implements. */
	declaresInterface(this: Translator, type: ts.Type, name: string): boolean {
		const decl = this.checker.getNonNullableType(type).getSymbol()?.valueDeclaration;
		if (!decl || !ts.isClassLike(decl)) return false;
		if ([...(this.structural.get(decl) ?? [])].some((d) => d.name.text === name && this.protocolWitnesses(decl, d, name, [], new Set()))) return true;
		for (const h of decl.heritageClauses ?? []) {
			for (const x of h.types) {
				if (x.expression.getText() === name) return true;
				if (h.token === ts.SyntaxKind.ExtendsKeyword && this.declaresInterface(this.checker.getTypeAtLocation(x), name)) return true;
			}
		}
		return false;
	},

	/** A generic base class's type parameters as a subclass extends it (`Test<Label>`: T is Label), in Kotlin. */
	baseTypeArgs(this: Translator, sub: ts.ClassLikeDeclaration, base: ts.ClassLikeDeclaration): Map<string, string> {
		const out = new Map<string, string>();
		if (!base.typeParameters?.length || sub === base) return out;
		const target = this.checker.getSymbolAtLocation(base.name!) ?? (base as unknown as { symbol?: ts.Symbol }).symbol;
		const find = (t: ts.Type): ts.TypeReference | undefined => {
			for (const b of this.checker.getBaseTypes(t as ts.InterfaceType) ?? []) {
				if (b.getSymbol() === target) return b as ts.TypeReference;
				const up = find(b);
				if (up) return up;
			}
			return undefined;
		};
		const ref = find(this.checker.getTypeAtLocation(sub.name ?? sub));
		const typeArgs = ref ? this.checker.getTypeArguments(ref) : [];
		base.typeParameters.forEach((p, k) => {
			const a = typeArgs[k];
			if (!a) return;
			// `any` for a bounded parameter is its bound, as the class's Kotlin heritage gives it.
			out.set(p.name.text, a.flags & ts.TypeFlags.Any && p.constraint && !this.library ? this.type(this.checker.getTypeFromTypeNode(p.constraint), p).replace(/\?$/, '') : this.type(a, sub));
		});
		return out;
	},

	/** The overridden signature of a method taking more parameters: its overload, the parameters script leaves out undefined. */
	overloadBridge(this: Translator, m: ts.MethodDeclaration, base: ts.MethodDeclaration): string {
		return this.suppressingDeprecations(() => this.overloadBridgeCode(m, base));
	},

	overloadBridgeCode(this: Translator, m: ts.MethodDeclaration, base: ts.MethodDeclaration): string {
		const name = this.methodIdent(m.name.getText());
		const baseTypes = base.parameters.map((p) => this.paramType(p));
		const baseRet = this.returnTypeOf(base);
		const ret = this.returnTypeOf(m);
		const names = base.parameters.map((p, k) => (ts.isIdentifier(p.name) ? ident(p.name.text) : `__o${k}`));
		const args = m.parameters.map((p, k) => {
			const t = this.paramType(p);
			if (k < baseTypes.length) return this.convert(names[k], baseTypes[k], t);
			if (this.constantDefault(p)) return this.stored(p.initializer!, p, t);
			return isNullable(t) || isUntyped(spelledType(t)) ? 'null' : (this.zero(t) ?? 'null');
		});
		const call = `this.${name}(${args.join(', ')})`;
		const body = baseRet === 'Unit' ? `        ${call}` : `        return ${this.convert(call, ret, baseRet)}`;
		return [`    override fun ${name}(${baseTypes.map((t, k) => `${names[k]}: ${t}`).join(', ')})${baseRet === 'Unit' ? '' : `: ${baseRet}`} {`, body, '    }'].join('\n');
	},

	/** An app class's field over a field a source base class declares untyped: the one property, which script may give any value through the base. */
	overUntypedField(this: Translator, d: ts.Declaration): boolean {
		if (this.library || !(ts.isPropertyDeclaration(d) || (ts.isParameter(d) && ts.isParameterPropertyDeclaration(d, d.parent))) || this.pluginFiles.has(d.getSourceFile().fileName)) return false;
		let found = this.overUntypedFields.get(d);
		if (found !== undefined) return found;
		this.overUntypedFields.set(d, false);
		const root = this.redeclaredField(d);
		found = !!root && !ts.isAccessor(root) && this.isAny(root.name);
		this.overUntypedFields.set(d, found);
		return found;
	},

	/**
	 * Library mode: what a module declares ambiently for the runtime to provide (`declare namespace com.tns { class NativeScriptApplication }`),
	 * read from the global object, undefined where nothing provides it.
	 */
	isAmbient(this: Translator, e: ts.Node): boolean {
		if (!this.library) return false;
		if (ts.isPropertyAccessExpression(e)) return this.isAmbient(e.expression);
		if (!ts.isIdentifier(e)) return false;
		const decls = this.resolve(e)?.declarations ?? [];
		return decls.length > 0 && decls.every((d) => !d.getSourceFile().isDeclarationFile && ((ts.isModuleDeclaration(d) && hasModifier(d, ts.SyntaxKind.DeclareKeyword)) || (ts.isVariableDeclaration(d) && ts.isVariableStatement(d.parent.parent) && hasModifier(d.parent.parent, ts.SyntaxKind.DeclareKeyword))));
	},

	/**
	 * An interface no Kotlin type is written for, so a class implementing it only meets it, as script does: one the program has no
	 * declaration of (a plugin's `import { IOptions } from '.'`, which a platform suffix resolves to the importing file itself), or
	 * one only a package's own declaration file has (its `index.d.ts`), as Swift leaves it out.
	 */
	declaredOnlyInterface(this: Translator, i: ts.ExpressionWithTypeArguments): boolean {
		const decls = this.checker.getTypeAtLocation(i).getSymbol()?.declarations ?? [];
		return decls.every((d) => d.getSourceFile().isDeclarationFile && !isLibDeclaration(d) && !isCoreDeclaration(d) && !d.getSourceFile().fileName.startsWith('/__shims__/') && !this.native?.isNativeDeclaration(d));
	},

	untranslatedInterface(this: Translator, i: ts.ExpressionWithTypeArguments): boolean {
		const decls = this.checker.getTypeAtLocation(i).getSymbol()?.declarations ?? [];
		return decls.length > 0 && decls.every((d) => ts.isInterfaceDeclaration(d) && !d.getSourceFile().isDeclarationFile && !this.translatedFile(d.getSourceFile()));
	},

	/** Whether a module is translated: the app's, or a plugin's with a statement the app reaches. */
	translatedFile(this: Translator, sf: ts.SourceFile): boolean {
		const reach = this.reach;
		return !reach || !this.pluginFiles.has(sf.fileName) || (reach.modules.has(sf.fileName) && sf.statements.some((st) => reach.keeps(st) && !ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)));
	},

	/** A browser global (`requestAnimationFrame`, `performance`), or a name nothing declares in a plugin's source: the global object's. */
	isDomGlobal(this: Translator, e: ts.Identifier): boolean {
		if (this.library || (ts.isPropertyAccessExpression(e.parent) && e.parent.name === e) || ts.isTypeNode(e.parent)) return false;
		const decls = this.resolve(e)?.declarations ?? [];
		if (!decls.length) return this.pluginFiles.has(e.getSourceFile().fileName) && !isArguments(e, this.checker) && !['undefined', 'NaN', 'Infinity'].includes(e.text);
		// The animation-frame functions held as values: kit-android's runtime has none.
		if (['requestAnimationFrame', 'cancelAnimationFrame'].includes(e.text) && decls.every((d) => d.getSourceFile().fileName === '/__shims__/globals.d.ts') && !(ts.isCallExpression(e.parent) && e.parent.expression === e)) return true;
		return isDomGlobalDeclaration(e.text, decls);
	},

	isJavaPackage(this: Translator, sym: ts.Symbol | undefined): boolean {
		return !!sym && !!(sym.flags & ts.SymbolFlags.Namespace) && !(sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) && !!sym.declarations?.length && sym.declarations.every((d) => !!this.native?.isNativeDeclaration(d));
	},

	/** Library mode: a place read and written by key (`info.runCount` of an untyped object, a Java object's expando), for `+=` and `++`. */
	untypedPlace(this: Translator, e: ts.Expression): { obj: string; key: string } | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		// App mode: a member of an untyped object (`(<any>args.object).returnPress++`).
		if (!this.library) {
			if (ts.isPropertyAccessExpression(e) && (this.isAny(e.expression) || undeclaredMemberOf(e, this.checker) || readByKey(e, (o, k) => !!definedField(this.states, () => this.shapeFacts(), o, k)))) return { obj: this.expr(e.expression), key: kotlinString(e.name.text) };
			// A key the object's type does not declare (`obj['count']++` of an Observable): the object's by name.
			const undeclared = ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression) && !this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression)).getProperty(e.argumentExpression.text);
			return ts.isElementAccessExpression(e) && (this.isAny(e.expression) || undeclared) ? { obj: this.expr(e.expression), key: this.propertyKey(e.argumentExpression) } : null;
		}
		if (ts.isPropertyAccessExpression(e) && (this.isAny(e.expression) || this.isExpando(e))) return { obj: this.expr(e.expression), key: kotlinString(e.name.text) };
		if (ts.isElementAccessExpression(e) && this.isAny(e.expression)) return { obj: this.expr(e.expression), key: this.propertyKey(e.argumentExpression) };
		return null;
	},

	/** A class whose objects script gives members it doesn't declare, or whose fields' decorators put accessors on its prototype, which keep what they like on the instance. */
	keepsAdded(this: Translator, cls: ts.ClassLikeDeclaration): boolean {
		return this.givenUndeclared().has(cls) || cls.members.some((m) => prototypeDecorated(this, m));
	},

	/** The program class's method `obj.m = …` writes over. */
	replacedMethod(this: Translator, left: ts.PropertyAccessExpression): ts.MethodDeclaration | undefined {
		if (this.library || this.isPrototypeRef(left.expression) || left.expression.kind === ts.SyntaxKind.SuperKeyword) return undefined;
		return this.checker.getSymbolAtLocation(left.name)?.declarations?.find((d): d is ts.MethodDeclaration => ts.isMethodDeclaration(d) && !!d.body && ts.isClassLike(d.parent) && !d.getSourceFile().isDeclarationFile);
	},

	/** A method an instance may hold its own value for (see `instanceKeys`), or one overriding such a method. */
	isInstanceKey(this: Translator, name: ts.MemberName): boolean {
		const decls = this.resolve(name)?.declarations?.filter((d): d is ts.MethodDeclaration => ts.isMethodDeclaration(d) && ts.isClassLike(d.parent)) ?? [];
		return replaceableMethod(decls.find((x) => !!x.body) ?? decls[0], this.instanceKeys(), this.checker);
	},
	/** `recv.m(…)` of an instance key: the instance's own value, with `recv` as its `this`, else the class's method. */
	ownValueCall(this: Translator, e: ts.CallExpression, callee: ts.PropertyAccessExpression): string {
		const recv = callee.expression;
		const self = recv.kind === ts.SyntaxKind.ThisKeyword;
		const recvCode = this.expr(recv);
		const o = self ? recvCode : this.fresh('__o'),
			own = this.fresh('__own');
		const args = e.arguments.some(ts.isSpreadElement) ? [`*${this.packed(e.arguments, 'JSArray<Any?>', this.restSlot(e, 'Any?'))}.storage.toTypedArray()`] : e.arguments.map((a) => this.restArgument(e, a, 'Any?'));
		this.ownCalls.add(e);
		if (!self) this.subst.set(recv, o);
		let plain: string;
		try {
			plain = this.call(e);
		} finally {
			this.ownCalls.delete(e);
			if (!self) this.subst.delete(recv);
		}
		const value = this.fromAnyCode(`${RT.jsCallValue}(${[`${own}.value`, o, String(!!e.questionDotToken), ...args].join(', ')})`, this.typeOf(e), true);
		return `run { ${self ? '' : `val ${o} = ${recvCode}; `}val ${own} = ${RT.jsOwnProperty}(${o}, ${kotlinString(callee.name.text)}); if (${own} != null) ${value} else ${plain} }`;
	},

	/** An `augmentedMember` read as `Any?`. */
	augmentedRead(this: Translator, e: ts.PropertyAccessExpression): string | null {
		return augmentedPropertyRead(e, this.checker) ? `${RT.jsGet}(${this.expr(e.expression)}, ${kotlinString(e.name.text)})` : (this.core?.augmentedRead(e) ?? null);
	},

	/** A member script adds to a native object (`nativeView.nsView`): declared by the code itself, not by the SDK. */
	isExpando(this: Translator, e: ts.PropertyAccessExpression): boolean {
		if (readByKey(e, (o, k) => !!definedField(this.states, () => this.shapeFacts(), o, k))) return true;
		if (!this.library && undeclaredMemberOf(e, this.checker)) return true;
		if (mergedInterfaceMemberOf(e, this.checker)) return true;
		if (ambientAddedMemberOf(e, this.checker) !== null) return true;
		const decl = this.checker.getSymbolAtLocation(e.name)?.declarations?.[0];
		// A member of a class typed as its base (`tokenClassBase`), which only the object read has.
		if (decl && ts.isClassDeclaration(decl.parent) && decl.parent.name && tokenClassBase(this.checker.getTypeAtLocation(decl.parent.name), this.checker, this.pluginFiles)) return true;
		// A property script adds to a function it declares (`fn.tag = …`), which TypeScript declares by that assignment.
		if (decl && (ts.isPropertyAccessExpression(decl) || ts.isBinaryExpression(decl)) && this.checker.getTypeAtLocation(e.expression).getCallSignatures().length) return true;
		// A field an interface of the program adds to a native class (`interface ExpandedAnimator extends android.animation.Animator { entry }`).
		if (decl && ts.isPropertySignature(decl) && ts.isInterfaceDeclaration(decl.parent) && !decl.getSourceFile().isDeclarationFile) {
			return (decl.parent.heritageClauses ?? []).some((h) => h.types.some((x) => !!this.native?.type(this.checker.getTypeAtLocation(x))));
		}
		if (!decl || !ts.isPropertySignature(decl) || !(ts.isTypeLiteralNode(decl.parent) || ts.isInterfaceDeclaration(decl.parent))) return false;
		const target = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression));
		if (target.isIntersection() && !decl.getSourceFile().isDeclarationFile && target.types.some((t) => !!(t.getSymbol()?.flags! & ts.SymbolFlags.Class) && !t.getProperty(e.name.text))) return true;
		return [target, ...(target.isIntersection() ? target.types : [])].some((t) => !!this.native?.type(t));
	},

	/**
	 * The name a translated declaration has: an import renamed (`install as
	 * installGestureHandler`) names its export, and a module-level name that
	 * several modules declare is the module's own (`topName`).
	 */
	declaredName(this: Translator, e: ts.Identifier): string {
		const local = this.checker.getSymbolAtLocation(e);
		if (!local) return e.text;
		const alias = !!(local.flags & ts.SymbolFlags.Alias);
		const target = alias ? this.checker.getAliasedSymbol(local) : local;
		const decl = target.valueDeclaration;
		if (decl && this.topNames().has(decl)) return this.topNames().get(decl)!;
		if (!alias || !decl || decl.getSourceFile().isDeclarationFile || target.name === 'default' || target.flags & ts.SymbolFlags.ValueModule) return e.text;
		return target.name;
	},

	/** A module-level function, class or variable's Kotlin name. */
	topName(this: Translator, decl: ts.Node, name: string): string {
		return this.topNames().get(decl) ?? name;
	},
	/**
	 * App mode: a type name Kotlin code already has unqualified (a default import's, the runtime's, a thread annotation's,
	 * whose import outranks the app's package). Java classes are spelled qualified, so their names hide nothing.
	 */
	nativeClash(this: Translator, name: string): boolean {
		return !this.library && (KOTLIN_NATIVE_TYPES.has(name) || runtimeTypeName(name) || THREAD_ANNOTATIONS.includes(name));
	},

	/**
	 * Module-level functions, classes and variables of the same name in several
	 * modules (a plugin's `install` in its common and Android files): all but
	 * one take the module's name as a suffix, as the app's Kotlin is one package.
	 */
	topNames(this: Translator): Map<ts.Node, string> {
		if (this.renamedTop) return this.renamedTop;
		const byName = new Map<string, { decl: ts.Node; file: ts.SourceFile }[]>();
		for (const sf of this.sourceFiles) {
			if (sf.isDeclarationFile) continue;
			const add = (name: string, decl: ts.Node) => {
				const list = byName.get(name) ?? [];
				// An interface beside a variable of its name (`let TabChangeListener: TabChangeListener`): the interface's class takes another.
				const same = list.find((x) => x.file === sf);
				const isType = (d: ts.Node) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d);
				if (this.library && same && isType(same.decl) !== isType(decl)) {
					this.typeRenames.set(isType(decl) ? decl : same.decl, `${name}Interface`);
					if (isType(same.decl)) same.decl = decl;
					return;
				}
				// App mode: Kotlin keeps a class and a value of one name apart, so the module's value is the one a rename must reach.
				if (same && isType(same.decl) && !isType(decl)) {
					same.decl = decl;
					return;
				}
				if (!list.some((x) => x.file === sf)) list.push({ decl, file: sf });
				else if (ts.isFunctionDeclaration(decl)) list.find((x) => x.file === sf)!.decl = decl.body ? decl : list.find((x) => x.file === sf)!.decl;
				byName.set(name, list);
			};
			for (const st of sf.statements) {
				if (ts.isClassDeclaration(st) && st.name) add(st.name.text, st);
				// An object type becomes a class of its name too, so it shares the namespace with the classes.
				if (this.library ? ts.isInterfaceDeclaration(st) || (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) : namedObjectType(st, this.checker)) add((st as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text, st);
				if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name) && !hasModifier(st, ts.SyntaxKind.DeclareKeyword)) add(st.name.text, st);
				if (ts.isEnumDeclaration(st) && !hasModifier(st, ts.SyntaxKind.DeclareKeyword)) add(st.name.text, st);
				// Library mode: a module's functions and variables are its object's, named by it.
				if (ts.isFunctionDeclaration(st) && st.name && !this.library) add(st.name.text, st);
				if (ts.isVariableStatement(st) && !this.library)
					for (const d of st.declarationList.declarations) {
						if (ts.isIdentifier(d.name)) add(d.name.text, d);
						else for (const n of boundNames(d.name)) add(n.text, n.parent);
					}
			}
			if (!this.library) for (const ds of moduleBlockVars(sf, this.checker)) add((ds[0].name as ts.Identifier).text, ds[0]);
			// Classes declared in functions are declared at the top level too.
			const local = (n: ts.Node): void => {
				if (ts.isClassDeclaration(n) && n.name && !ts.isSourceFile(n.parent) && ts.findAncestor(n.parent, ts.isFunctionLike)) add(n.name.text, n);
				ts.forEachChild(n, local);
			};
			if (this.library) ts.forEachChild(sf, local);
		}
		this.renamedTop = new Map(this.typeRenames);
		// Core's functions the program imports (`booleanConverter`), which kit-android declares at its top level: a program's
		// function or variable of that name would hide them from every file of the app's package.
		const coreFunctions = new Set<string>();
		if (!this.library) {
			for (const sf of this.sourceFiles) {
				if (sf.isDeclarationFile) continue;
				for (const st of sf.statements) {
					if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
					for (const el of st.importClause.namedBindings.elements) {
						const sym = this.resolve(el.name);
						if (sym && sym.flags & ts.SymbolFlags.Function && isCoreDeclaration(sym.declarations?.[0])) coreFunctions.add(sym.name);
					}
				}
			}
		}
		// A renamed declaration takes its module's name: the shortest end of its path no other name has taken
		// (`label__index`, else `label__two_index` for another folder's index.ts).
		const taken = new Set(byName.keys());
		const renamed = (name: string, file: ts.SourceFile) => moduleSuffixedName(name, file.fileName, taken);
		for (const [name, list] of byName) {
			// A plugin's or the app's type named as a kit-android type takes its module's name too: a class (one extending core's
			// `Observable`), and outside the kit a namespace, enum, interface or object type (ui-chart's `Utils`), since a declaration
			// of the app's package hides the kit's of its name, imported with `org.nativescript.kit.*`, from every file of the app.
			const typeLike = (d: ts.Node) => ts.isClassDeclaration(d) || (!this.library && (ts.isModuleDeclaration(d) || ts.isEnumDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)));
			const kitClash = (list.some((x) => typeLike(x.decl)) && !!this.core?.has(name) && !this.core.nested?.(name)) || (coreFunctions.has(name) && list.some((x) => ts.isFunctionDeclaration(x.decl) || ts.isVariableDeclaration(x.decl)));
			// A type the hand-written kit declares for itself, or an app's type named as one Kotlin has already (`Pair`): the
			// generated one takes its module's name.
			const internalClash = !!this.library?.internalTypes?.has(name) || (list.some((x) => typeLike(x.decl) || ts.isInterfaceDeclaration(x.decl)) && this.nativeClash(name));
			if (list.length < 2 && !kitClash && !internalClash) continue;
			// The app's declaration keeps its name (the first app module's, of several); the others take their module's.
			const keep = kitClash || internalClash ? undefined : keptDeclaration(list, this.pluginFiles, !!this.library);
			for (const x of list) {
				if (x === keep) continue;
				const to = renamed(name, x.file);
				for (const d of declarationsNamedWith(x.decl, x.file, name, this.checker)) this.renamedTop.set(d, to);
			}
		}
		// Library mode: names apart only in case (`ios`, `iOS`) are one class file on a case-insensitive disk: all but the first take their module's name.
		if (this.library) {
			const byLower = new Map<string, string>();
			for (const [name, list] of byName) {
				const first = byLower.get(name.toLowerCase());
				if (first === undefined) {
					byLower.set(name.toLowerCase(), name);
					continue;
				}
				if (first === name) continue;
				for (const x of list) {
					if (this.renamedTop.has(x.decl)) continue;
					this.renamedTop.set(x.decl, renamed(name, x.file));
				}
			}
		}
		// Library mode: `@JavaProxy('org.nativescript.NativeScriptLifecycleCallbacks')`, the Java name a class is declared under.
		if (this.library)
			for (const sf of this.sourceFiles) {
				if (sf.isDeclarationFile) continue;
				const visit = (n: ts.Node): void => {
					if (ts.isClassDeclaration(n)) {
						const proxy = (ts.getDecorators(n) ?? []).map((d) => d.expression).find((x): x is ts.CallExpression => ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'JavaProxy');
						if (proxy && ts.isStringLiteralLike(proxy.arguments[0])) this.renamedTop!.set(n, proxy.arguments[0].text);
					}
					ts.forEachChild(n, visit);
				};
				visit(sf);
			}
		// A class a namespace declares is the namespace's nested class.
		const nested = (md: ts.ModuleDeclaration) => {
			if (!md.body || !ts.isModuleBlock(md.body)) return;
			for (const st of md.body.statements) {
				if (ts.isClassDeclaration(st) && st.name) this.renamedTop!.set(st, `${this.namespacePath(md)}.${st.name.text}`);
				if (ts.isModuleDeclaration(st)) nested(st);
			}
		};
		for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) for (const st of sf.statements) if (ts.isModuleDeclaration(st)) nested(st);
		// A namespace's interface is a class of the app's package (see `namespaceDecl`): where another declaration of the package,
		// another namespace's interface or the kit has its name, it takes its namespace's.
		if (!this.library) {
			const hoisted = new Map<string, { decl: ts.Node; ns: ts.ModuleDeclaration }[]>();
			const collect = (md: ts.ModuleDeclaration) => {
				if (!md.body || !ts.isModuleBlock(md.body) || hasModifier(md, ts.SyntaxKind.DeclareKeyword)) return;
				for (const st of md.body.statements) {
					if (ts.isInterfaceDeclaration(st) || (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type))) hoisted.set(st.name.text, [...(hoisted.get(st.name.text) ?? []), { decl: st, ns: md }]);
					if (ts.isModuleDeclaration(st)) collect(st);
				}
			};
			for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) for (const st of sf.statements) if (ts.isModuleDeclaration(st)) collect(st);
			for (const [name, list] of hoisted) {
				if (!byName.has(name) && list.length < 2 && !this.core?.has(name)) continue;
				for (const x of list) this.renamedTop.set(x.decl, `${name}__${(this.namespacePath(x.ns) ?? '').replace(/\./g, '_')}`);
			}
		}
		return this.renamedTop;
	},

	/**
	 * A list's function declarations read before they are declared, first, as JavaScript hoists them: with the functions
	 * they read that are declared after them, each after the ones it reads, as a Kotlin local function cannot read a later one.
	 */
	hoistedFunctions(this: Translator, list: ts.Statement[]): ts.FunctionDeclaration[] {
		const fns = list.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.name);
		const named = (n: ts.Node, names: Set<string>, out: Set<string>) => {
			if (ts.isIdentifier(n) && names.has(n.text)) out.add(n.text);
			ts.forEachChild(n, (c) => named(c, names, out));
		};
		const names = new Set(fns.map((f) => f.name!.text));
		const reads = new Map(
			fns.map((f) => {
				const out = new Set<string>();
				if (f.body) named(f.body, names, out);
				out.delete(f.name!.text);
				return [f, out] as const;
			}),
		);
		const hoisted = new Set(list.filter((s, k): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && usedBefore(list, k)));
		for (let grew = hoisted.size > 0; grew;) {
			grew = false;
			for (const h of [...hoisted])
				for (const f of fns)
					if (!hoisted.has(f) && reads.get(h)!.has(f.name!.text) && list.indexOf(f) > list.indexOf(h)) {
						hoisted.add(f);
						grew = true;
					}
		}
		const out: ts.FunctionDeclaration[] = [];
		const visiting = new Set<ts.FunctionDeclaration>();
		const place = (f: ts.FunctionDeclaration) => {
			if (out.includes(f) || visiting.has(f)) return;
			visiting.add(f);
			for (const g of fns) if (hoisted.has(g) && reads.get(f)!.has(g.name!.text)) place(g);
			out.push(f);
		};
		for (const f of fns) if (hoisted.has(f)) place(f);
		return out;
	},
};
