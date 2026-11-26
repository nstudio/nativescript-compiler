// TypeScript types as Kotlin types: representations, held and optional forms, shapes.
import ts from 'typescript';
import { KIT_NAMES_ANDROID } from './library.ts';
import { BUFFER_TYPES, WEB_DICTIONARIES, isWebClass } from '../semantics/globals.ts';
import { SPELLING, spell, destructuringSource, functionTypeParts, kotlinString, nullishType, optionalElementsType, optionalType, presentConst, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { ambientBase, evolvingArrayRead, evolvingArrayType, isAmbientClass, isRegExpProtocol, memberOwner, namesOwnTypeParameter, tokenClassBase, isArguments } from '../semantics/lang.ts';
import { nullishSignalType } from '../semantics/signals.ts';
import { hasModifier, isLibDeclaration, thisNodes, isWriteTarget, implementationOf, takesOwnThis } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { coreTypeKind, eventDataTypeLiteral, hasMappedIntersection, isJsDocConstructorFunction, isKit, isLibObjectType, isNamed, isUntyped, libraryNativeType, libraryType, mappedOrErasedType, nonNullableInner, nonOptionalSpelling, parseNativeType, spelledType, valueModuleKind } from '../semantics/types.ts';
import { isStatic } from '../semantics/throws.ts';
import { literalOverArray, membersOverTypeParameter, untypedResultBinding, untypedResultField } from '../semantics/shapes.ts';
import { extendedClass, isEventData } from '../semantics/classes.ts';
import { symbolField } from '../semantics/spelled.ts';
import { otherPlatformTypings } from '../semantics/platform-globals.ts';

export const typesMethods = {
	// ---- Types -----------------------------------------------------------------------------

	/** `TypeView.leading`: a native enum, a collection alias, an iOS type, a component class, a namespace or enum held as a value, a package's `keyof T`. */
	leadingType(this: Translator, t: ts.Type, where?: ts.Node): string | null {
		const F = ts.TypeFlags;
		if (t.flags & F.EnumLike) {
			const native = this.native?.type(t);
			if (native) return native;
		}
		const alias = !this.library && t.getSymbol()?.flags! & ts.SymbolFlags.Class ? this.collectionAlias(t.getSymbol()?.valueDeclaration) : null;
		if (alias) return alias;
		// An iOS class (`page.ios as UIViewController` in code shared by both platforms): what this platform's code holds is no such thing.
		const iosDecls = t.getSymbol()?.declarations;
		if (iosDecls?.length && iosDecls.every((d) => otherPlatformTypings(this.ledger).test(d.getSourceFile().fileName))) return 'Any?';
		// A component class of a plugin's framework entry: only the framework's runtime makes its instances, and the build declares no such class.
		const component = t.getSymbol()?.flags! & ts.SymbolFlags.Class ? t.getSymbol()!.declarations?.[0] : undefined;
		if (component && ts.isClassDeclaration(component) && this.pluginFiles.has(component.getSourceFile().fileName) && this.framework.componentClass(component)) return 'Any?';
		// A namespace as a value (`{ Kinds: Trace.Kinds }`) or an ES module namespace (`typeof import('...')`).
		const ns = valueModuleKind(t);
		if (ns) return ns === 'module' ? 'Any?' : this.namespacePath(ns)!;
		// An enum as a value (`typeof Color`) in app code: the object JavaScript makes of it. Not the enum's own name, through
		// which its members are read (`Color.Red`).
		const enumObject = !this.library && t.flags & F.Object && (t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.RegularEnum ? t.getSymbol()!.valueDeclaration : undefined;
		const named = where && (ts.isIdentifier(where) || ts.isPropertyAccessExpression(where)) && this.resolve(ts.isPropertyAccessExpression(where) ? where.name : where)?.valueDeclaration === enumObject;
		if (enumObject && !named && ts.isEnumDeclaration(enumObject) && !enumObject.getSourceFile().isDeclarationFile && !hasModifier(enumObject, ts.SyntaxKind.ConstKeyword)) return 'JSObject';
		// A package's `keyof T` over a type parameter (its generics erased): any key.
		if (t.flags & F.Index && where && this.pluginFiles.has(where.getSourceFile().fileName)) return 'Any?';
		return null;
	},

	typeParameterType(this: Translator, t: ts.Type, where?: ts.Node): string {
		const F = ts.TypeFlags;
		const name = t.symbol?.name;
		const constraint = (t as ts.TypeParameter & { isThisType?: boolean }).isThisType ? t.getConstraint() : undefined;
		if (constraint) return this.type(constraint, where);
		if (name === 'this') {
			const cls = where && ts.findAncestor(where, ts.isClassLike);
			if (cls?.name) return this.className(cls);
		}
		const decl = t.symbol?.declarations?.[0];
		if (decl && this.pluginFiles.has(decl.getSourceFile().fileName)) return 'Any?';
		// A parameter of a lambda (Kotlin's take none) or of an interface the translation erases: its constraint.
		if (decl && !this.library && (ts.isArrowFunction(decl.parent) || ts.isFunctionExpression(decl.parent) || ts.isInterfaceDeclaration(decl.parent) || ts.isTypeAliasDeclaration(decl.parent))) {
			const base = this.checker.getBaseConstraintOfType(t);
			return base && base !== t && !(base.flags & F.Unknown) ? optionalType(this.type(base, where)) : 'Any?';
		}
		// Library mode: a type parameter of the library's own signatures (ClassDecorator's `TFunction`), which no Kotlin declaration has.
		if (this.library && decl?.getSourceFile().isDeclarationFile) return 'Any?';
		if (!this.library && decl && ts.isTypeParameterDeclaration(decl) && this.erasesTypeParameter(decl)) return 'Any?';
		// Inside an object shape, a class of its own outside every generic scope: any value.
		if (!this.library && this.shaping.size) return 'Any?';
		return name ?? 'Any?';
	},

	/** `UIView & { nsView?: … }`, `View & { … }`: the class; the members the literal adds are read by name. */
	intersectionType(this: Translator, t: ts.IntersectionType, where?: ts.Node): string | null {
		const F = ts.TypeFlags;
		if (literalOverArray(t, this.checker)) return 'Any?';
		// `typeof globalThis & { … }`: the global object, untyped as `typeof globalThis` is, its added members read by name.
		if (t.types.some((u) => u.flags & F.Object && u.getSymbol()?.name === 'globalThis' && u.getSymbol()!.flags & ts.SymbolFlags.ValueModule)) return 'Any?';
		// Library mode: `Color & number`, a value declared a class that `typeof` found a number: the number.
		const sym = this.library && where && ts.isIdentifier(where) ? this.checker.getSymbolAtLocation(where) : undefined;
		const declared = sym?.valueDeclaration ? this.checker.getTypeOfSymbolAtLocation(sym, sym.valueDeclaration) : undefined;
		const tested = declared && !(declared.flags & (F.StringLike | F.NumberLike | F.BooleanLike)) ? t.types.find((u) => u.flags & (F.StringLike | F.NumberLike | F.BooleanLike)) : undefined;
		if (tested) return this.type(tested, where);
		const cls = t.types.find((u) => this.native?.type(u) || (u.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class);
		if (cls) return this.type(cls, where);
		// `T & string`, a type parameter narrowed by typeof, `keyof T & string`: the primitive.
		const primitive = t.types.find((u) => u.flags & (F.StringLike | F.NumberLike | F.BooleanLike));
		if (primitive && t.types.every((u) => u === primitive || u.flags & F.TypeParameter || (u.flags & F.Index && where && this.pluginFiles.has(where.getSourceFile().fileName)))) return this.type(primitive, where);
		// `Source & StringLiteralCheck<Source, 'source'>` of `Source extends string`: checks only TypeScript resolves, over the primitive.
		const bound = t.types.map((u) => (u.flags & F.TypeParameter ? this.checker.getBaseConstraintOfType(u) : undefined)).find((u) => u && u.flags & (F.String | F.Number | F.Boolean));
		if (bound && t.types.every((u) => u.flags & (F.TypeParameter | F.Conditional))) return this.type(bound, where);
		if (membersOverTypeParameter(t, this.checker) || hasMappedIntersection(t)) return 'Any?';
		// A function carrying properties (`((p: P) => R) & { type: string }`): an untyped value, called as script calls it.
		if (t.types.some((u) => u.getCallSignatures().length) && t.types.some((u) => !u.getCallSignatures().length && u.getProperties().length) && !t.types.some((u) => isLibDeclaration(u.getSymbol()?.declarations?.[0]))) return 'Any?';
		// Interfaces each held untyped (core's `BackstackEntry & ExpandedEntry`): untyped too. A shape would be a copy, so
		// the caller's object would not see the writes and `===` would not find it.
		if (
			t.types.every((u) => {
				const s = u.getSymbol();
				return !!s && this.isDynamicShape(s);
			})
		)
			return 'Any?';
		return null;
	},

	tupleType(this: Translator, t: ts.TypeReference, where?: ts.Node): string {
		const c = this.checker;
		const args = c.getTypeArguments(t as ts.TypeReference).map((a) => this.type(a, where));
		const variadic = ((t as ts.TypeReference).target as ts.TupleType).hasRestElement;
		if (args.length === 2 && !variadic) return `Pair<${args.join(', ')}>`;
		if (args.length === 3 && !variadic) return `Triple<${args.join(', ')}>`;
		const same = args.every((a) => a === args[0]);
		return `JSArray<${same && args.length ? args[0] : 'Any?'}>`;
	},

	namedType(this: Translator, t: ts.Type, where?: ts.Node): string {
		const c = this.checker;
		// A class as a value (`typeof Style`, `new () => T`): its Java class, untyped.
		if (this.library && t.getConstructSignatures().length && !t.getCallSignatures().length && (!((t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) || !this.namesClass(where))) return 'Any?';
		if (this.library && t.getProperties().length === 1 && t.getProperties()[0].name === 'prototype') return 'Any?';
		if (isRegExpProtocol(t)) return 'JSRegExp';
		// An alias of a class's type (`type UntypedFormGroup = FormGroup<any>`) is that class.
		const sym = t.aliasSymbol && !((t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class && t.aliasSymbol.flags & ts.SymbolFlags.TypeAlias && !(t.aliasSymbol.flags & ts.SymbolFlags.Class)) ? t.aliasSymbol : t.getSymbol();
		if (sym?.declarations?.some((d) => otherPlatformTypings(this.ledger).test(d.getSourceFile().fileName))) return 'Any?';
		// A component class as a value (`typeof SheetComponent`) is what creating and rendering it gives.
		const classDecl = sym?.valueDeclaration;
		if (classDecl && ts.isClassDeclaration(classDecl) && t.getConstructSignatures().length && this.framework.componentClass(classDecl, true)) return this.framework.hooks.componentValueType!;
		// An app or plugin class as a value (`[Plain]`, a package's `schedulerActionCtor: typeof Action`): its Java class, untyped.
		if (this.ledger.appClassValuesUntyped && !this.library && classDecl && ts.isClassLike(classDecl) && !classDecl.getSourceFile().isDeclarationFile && t.getConstructSignatures().length && !t.getCallSignatures().length && !this.namesClass(where) && where?.kind !== ts.SyntaxKind.ThisKeyword) return 'Any?';
		// Library mode: a class a module declares for what it makes at run time (`declare class NativeScriptLifecycleCallbacks extends …`): the class it extends.
		if (this.library && sym && sym.flags & ts.SymbolFlags.Class && sym.declarations?.length && sym.declarations.every((d) => ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile && hasModifier(d, ts.SyntaxKind.DeclareKeyword))) {
			const base = (t as ts.InterfaceType).isClassOrInterface?.() ? c.getBaseTypes(t as ts.InterfaceType)[0] : undefined;
			return base ? this.type(base, where) : 'Any?';
		}
		// Library mode: a class expression's instances are of the class it extends.
		if (this.library && sym && sym.flags & ts.SymbolFlags.Class && sym.valueDeclaration && ts.isClassExpression(sym.valueDeclaration) && (t as ts.InterfaceType).isClassOrInterface?.()) {
			const base = c.getBaseTypes(t as ts.InterfaceType)[0];
			return base ? this.type(base, where) : 'Any?';
		}
		// Library mode: a class of fields alone that nothing constructs (`UnparsedKeyframe`), the type of plain objects: untyped.
		if (this.library && sym && sym.flags & ts.SymbolFlags.Class && this.plainObjectClasses().has(sym.valueDeclaration as ts.Node)) return 'Any?';
		// Library mode: a class only core's declarations describe (`NativeScriptLifecycleCallbacks`, made at run time), untyped.
		if (this.library && sym && sym.flags & ts.SymbolFlags.Class && sym.declarations?.length && sym.declarations.every((d) => d.getSourceFile().isDeclarationFile && !isLibDeclaration(d) && !this.native?.isNativeDeclaration(d)) && !this.core?.type(t) && !this.sourceClassNames().has(sym.name)) return 'Any?';
		// Library mode: a class a module declares ambiently for the runtime to provide (`com.tns.NativeScriptApplication`), untyped.
		if (this.library && sym?.declarations?.length && sym.declarations.every((d) => !d.getSourceFile().isDeclarationFile && !!ts.findAncestor(d, (a) => ts.isModuleDeclaration(a) && hasModifier(a, ts.SyntaxKind.DeclareKeyword)))) return 'Any?';
		// Library mode: an interface core declares over Java interfaces alone (`EditTextListeners`): what implements them, untyped.
		const ifaces = this.library && sym && sym.flags & ts.SymbolFlags.Interface ? (sym.declarations ?? []).filter(ts.isInterfaceDeclaration) : [];
		if (ifaces.length && ifaces.every((d) => !d.getSourceFile().isDeclarationFile && !d.members.length && !!d.heritageClauses?.length && d.heritageClauses.every((h) => h.types.every((x) => (this.checker.getTypeAtLocation(x).getSymbol()?.declarations ?? []).some((b) => !!this.native?.isNativeDeclaration(b)))))) return 'Any?';
		// Library mode: what only the DOM's typings declare (`MediaQueryList`) is no class of the kit's.
		if (this.library && sym?.declarations?.length && sym.declarations.every((d) => /[\\/]lib\.dom[\w.]*\.d\.ts$/.test(d.getSourceFile().fileName))) return 'Any?';
		const declName = sym?.declarations?.[0] && (ts.isClassDeclaration(sym.declarations[0]) || ts.isInterfaceDeclaration(sym.declarations[0])) ? sym.declarations[0].name?.text : undefined;
		// A default-exported class is known by its declared name.
		const name = sym?.getName() === 'default' ? (declName ?? 'default') : sym?.getName();
		const args = () => t.aliasTypeArguments ?? c.getTypeArguments(t as ts.TypeReference);
		const arg = (k: number) => {
			const a = args()[k];
			return a ? this.type(a, where) : 'Any?';
		};
		if (name && sym?.declarations?.[0]?.getSourceFile().fileName === '/__shims__/globals.d.ts') {
			if (isWebClass(this.ledger, name)) return `JS${name}`;
			if (WEB_DICTIONARIES.includes(name)) return 'Any?';
		}
		// Library mode: a Java class named as a library type (`java.util.Map`, `java.util.Iterator`) is the Java class.
		const javaClass = this.library && !!sym?.declarations?.length && sym.declarations.every((d) => this.native?.isNativeDeclaration(d)) ? this.native?.type(t) : null;
		if (javaClass) return javaClass;
		// A program type renamed for a name Kotlin has already (`Iterator`, `Pair`) is not the library's type of that name.
		const clashing = !this.library && sym?.valueDeclaration && this.nativeClash(sym.name) ? this.topNames().get(sym.valueDeclaration) : undefined;
		if (clashing) return `${clashing}${this.declaredTypeArguments(t, sym!.valueDeclaration!, where)}`;
		const kind = name === undefined ? undefined : this.framework.signalKind(name);
		if (kind === 'writable' || kind === 'input' || kind === 'model') {
			if (!this.lenient && !this.library && nullishSignalType(c, t, (n) => this.framework.signalKind(n))) return `Signal<${nullishType(arg(0))}>`;
			return `Signal<${arg(0)}>`;
		}
		if (kind === 'computed') return where && this.isComputedProperty(where) ? arg(0) : `Signal<${arg(0)}>`;
		if (kind) return `Signal<${arg(0)}>`;
		const mapped = name === undefined ? undefined : this.framework.typeMapping(name);
		if (mapped && (!mapped.shim || sym?.declarations?.[0]?.getSourceFile().fileName.startsWith('/__shims__/'))) return mapped.type.includes('$0') ? mapped.type.replace('$0', () => arg(0)) : mapped.type;
		const coreType = name === undefined ? null : coreTypeKind(name, sym?.declarations?.[0], !!this.library);
		if (coreType) return coreType === 'void-promise' ? 'JSPromise<Unit>' : 'Any?';
		const library = name === undefined ? null : libraryType(name, sym, this.ledger);
		if (library) return spell(libraryNativeType(library, (k) => parseNativeType(arg(k)), SPELLING, this.ledger));
		const nonNull = nonNullableInner(t, name, args());
		if (nonNull) return nonOptionalSpelling(this.type(nonNull, where));
		if (isLibObjectType(name, sym)) return 'Any?';
		const native = this.native?.type(t);
		if (native) return native;
		// Library mode: a native type no class file has, untyped.
		if (this.library && sym?.declarations?.length && sym.declarations.every((d) => this.native?.isNativeDeclaration(d)) && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) return 'Any?';
		const core = this.core?.type(t);
		if (core) return core;
		const index = t.getStringIndexType() ?? t.getNumberIndexType();
		if (index && !t.getProperties().length) return `JSRecord<${this.type(index, where)}>`;
		// A literal with computed keys beside named ones (`{ [k]: 1, a: 2 }`): its keys are known only when it runs.
		if (index && sym?.getName() === '__object') return 'Any?';
		const erased = mappedOrErasedType(t, name, sym);
		if (erased) return erased === 'any' ? 'Any?' : this.type(erased, where);
		// `{}` (what `unknown` narrows to once tested truthy) is any value but null and undefined, a native object included.
		const appClass = !!sym && !!(sym.flags & ts.SymbolFlags.Class) && !!sym.valueDeclaration && ts.isClassLike(sym.valueDeclaration) && !sym.valueDeclaration.getSourceFile().isDeclarationFile;
		if (!t.getProperties().length && !t.getCallSignatures().length && !t.getConstructSignatures().length && !index && !appClass) return 'Any?';
		const calls = t.getCallSignatures();
		// Properties script assigns a function (`fn.tag = …`) are the function value's own, not its type's.
		if (calls.length && t.getProperties().every((p) => p.declarations?.every((d) => ts.isPropertyAccessExpression(d) || ts.isBinaryExpression(d)))) {
			// App mode: an overloaded function or method as a value (`store.dispatch.bind(store)`) is its implementation, which every
			// call reaches; the kit's shapes keep the first overload, as code assigning them a typed function value has it.
			const over = calls.length > 1 && !this.library ? t.getSymbol()?.valueDeclaration : undefined;
			const impl = over && (ts.isFunctionDeclaration(over) || ts.isMethodDeclaration(over)) ? implementationOf(over) : null;
			const s = (impl && c.getSignatureFromDeclaration(impl)) || calls[0];
			// App mode: a function type reading the receiver it is called with (`(this: Action, state) => void`) is a script
			// function (a JSMethod), as `call`/`apply` pass that receiver.
			if (!this.library && takesOwnThis(s.getDeclaration())) return 'Any?';
			const sDecl = s.getDeclaration();
			if (sDecl && ts.isFunctionExpression(sDecl) && this.readsArguments(sDecl)) {
				const ret = this.widenedResultType(sDecl, this.type(s.getReturnType(), where));
				return `(JSArray<Any?>) -> ${ret}`;
			}
			const self = this.library ? (s as ts.Signature & { thisParameter?: ts.Symbol }).thisParameter : undefined;
			const selfType = self && this.type(c.getTypeOfSymbolAtLocation(self, where ?? self.valueDeclaration!), where);
			const params = [...(selfType && selfType !== 'Unit' ? [self!] : []), ...s.getParameters()].map((p) => {
				if (p.valueDeclaration && this.states.nullish().held.has(p.valueDeclaration)) return 'Any?';
				const plain = this.type(c.getTypeOfSymbolAtLocation(p, where ?? p.valueDeclaration!), where);
				const pt = p.valueDeclaration && ts.isParameter(p.valueDeclaration) && !p.valueDeclaration.dotDotDotToken && this.states.optionalElements(p.valueDeclaration) ? optionalElementsType(plain) : plain;
				if (p.valueDeclaration && this.states.nullishHeld(p.valueDeclaration)) return nullishType(pt);
				if (p.valueDeclaration && ts.isParameter(p.valueDeclaration) && (p.valueDeclaration.questionToken || p.valueDeclaration.initializer || this.states.widened(p.valueDeclaration))) return optionalType(pt);
				if (p.valueDeclaration && ts.isParameter(p.valueDeclaration) && ['String', 'Double', 'Boolean'].includes(pt) && this.states.undefinedParameter(p.valueDeclaration)) return optionalType(pt);
				// A plugin's function literal takes its parameters as `paramType` holds them.
				const literal = p.valueDeclaration?.parent;
				if (!this.library && p.valueDeclaration && ts.isParameter(p.valueDeclaration) && literal && (ts.isArrowFunction(literal) || ts.isFunctionExpression(literal)) && this.pluginFiles.has(p.valueDeclaration.getSourceFile().fileName) && this.states.mayBeNull(p.valueDeclaration)) return optionalType(pt);
				return pt;
			});
			// A generic signature held as a value (`assertEqual<T>` of a module object): its type parameters are whatever script passes.
			const generic = (s.typeParameters ?? []).map((p) => p.symbol.name);
			const erase = (x: string) => generic.reduce((acc, n) => acc.replace(new RegExp(`\\b${n}\\b`, 'g'), 'Any?'), x).replace(/\?\?/g, '?');
			const sd = s.getDeclaration() as ts.Declaration | undefined;
			const mapped = erase(`(${params.join(', ')}) -> ${sd && this.states.nullish().held.has(sd) ? 'Any?' : sd && this.states.nullishHeld(sd) ? nullishType(this.type(s.getReturnType(), where)) : this.widenedResultType(sd, this.type(s.getReturnType(), where))}`);
			if (/^JSArray</.test(functionTypeParts(mapped)?.params.at(-1) ?? '')) {
				const kind = !!sd && ts.isFunctionLike(sd) && !!sd.parameters.at(-1)?.dotDotDotToken ? 'rest' : 'array';
				const seen = this.restFunctionTypes.get(mapped);
				this.restFunctionTypes.set(mapped, !seen || seen === kind ? kind : 'both');
			}
			return mapped;
		}
		// An interface extending a class; one merged into a class (`interface ListViewBase { on(…) }`) is the class.
		// An interface typing a variable of its name a lazily defined class is assigned to (`interface PagerAdapter` with
		// `let PagerAdapter: PagerAdapter`): that class.
		const lazyHolder = !this.library && sym && sym.flags & ts.SymbolFlags.Interface ? sym.declarations?.find(ts.isVariableDeclaration) : undefined;
		const lazyClass = lazyHolder ? this.assignedClass(lazyHolder) : null;
		if (lazyClass) return this.className(lazyClass);
		const extended = sym && sym.flags & ts.SymbolFlags.Interface && !(sym.flags & ts.SymbolFlags.Class) ? extendedClass(t, this.checker) : null;
		if (extended) return this.type(extended, where);
		if (isAmbientClass(sym)) {
			const base = ambientBase(sym!, this.checker);
			return base ? this.type(base, where) : 'Any?';
		}
		if (sym && this.isDynamicShape(sym)) return 'Any?';
		if (isEventData(t, this.checker)) return 'EventData';
		const shim = sym?.declarations?.[0]?.getSourceFile().fileName.startsWith('/__shims__/');
		// A shimmed module's classes the kit has under a prefix (core has an Observable of its own).
		const prefix = name && sym?.declarations?.[0] ? this.framework.classPrefix(sym.declarations[0].getSourceFile().fileName) : undefined;
		if (name && prefix !== undefined)
			return `${prefix}${name}${
				(t as ts.TypeReference).typeArguments?.length
					? `<${c
							.getTypeArguments(t as ts.TypeReference)
							.map((a) => this.type(a, where))
							.join(', ')}>`
					: ''
			}`;
		if (name && shim && (t as ts.TypeReference).typeArguments?.length)
			return `${name}<${c
				.getTypeArguments(t as ts.TypeReference)
				.map((a) => this.type(a, where))
				.join(', ')}>`;
		if (name && Object.hasOwn(KIT_NAMES_ANDROID, name) && isCoreDeclaration(sym?.declarations?.[0])) return KIT_NAMES_ANDROID[name];
		const tokenBase = tokenClassBase(t, c, this.pluginFiles);
		if (tokenBase) return this.type(c.getTypeAtLocation(tokenBase), where);
		if (isJsDocConstructorFunction(sym)) return 'Any?';
		const renamed = sym?.valueDeclaration && this.topNames().get(sym.valueDeclaration);
		if (renamed) return `${renamed}${this.declaredTypeArguments(t, sym!.valueDeclaration!, where)}`;
		if (sym?.valueDeclaration && ts.isClassExpression(sym.valueDeclaration) && !sym.valueDeclaration.getSourceFile().isDeclarationFile) return `${this.classExprs.name(sym.valueDeclaration)}${this.declaredTypeArguments(t, sym.valueDeclaration, where)}`;
		const renamedType = sym && !sym.valueDeclaration && sym.declarations?.[0] ? this.topNames().get(sym.declarations[0]) : undefined;
		if (renamedType) {
			this.used.add(renamedType);
			return renamedType;
		}
		// A mixin's class is the core class it is applied to.
		const mixin = this.mixinOf(sym);
		if (mixin) return mixin;
		// An object rest's type (`const { a, ...rest } = x`) is named by the binding: a shape like a literal's.
		const restType = !!sym?.declarations?.length && sym.declarations.every((d) => ts.isBindingElement(d) || ts.isVariableDeclaration(d) || ts.isParameter(d));
		if (name && name !== '__type' && name !== '__object' && !restType) {
			if (sym?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) this.used.add(name);
			const classDecl = sym?.declarations?.find((d): d is ts.ClassDeclaration => ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile);
			// A plugin's generic class is untyped in its parameters, as its code treats them.
			return classDecl ? `${name}${this.declaredTypeArguments(t, classDecl, where)}` : name;
		}
		if (eventDataTypeLiteral(t, this.checker)) return 'EventData';
		return this.shape(t, where);
	},

	/** The Kotlin type of a member whose type names a type parameter of its plugin generic class (`data: T` as `Any?`); null for any other. */
	erasedMemberType(this: Translator, decl: ts.Declaration | undefined): string | null {
		const owner = decl && !this.library ? memberOwner(decl) : null;
		if (!owner || !this.pluginFiles.has(owner.getSourceFile().fileName) || !namesOwnTypeParameter(decl!, this.checker)) return null;
		const sym = this.checker.getSymbolAtLocation((decl as ts.NamedDeclaration).name!);
		return sym ? this.type(this.checker.getTypeOfSymbolAtLocation(sym, decl!), decl) : null;
	},
	widerAsserted(this: Translator, d: ts.VariableDeclaration): string | null {
		if (!this.widenedVars.has(d)) this.widenedVars.set(d, this.native?.assertedWiderClass?.(d) ?? null);
		return this.widenedVars.get(d)!;
	},

	plainTypeOf(this: Translator, n: ts.Node): string {
		// A static field a symbol names, with no initializer (`static [native_];`), is held optional.
		if (ts.isElementAccessExpression(n) && !isWriteTarget(n)) {
			const d = symbolField(this, n)?.valueDeclaration;
			if (d && ts.isPropertyDeclaration(d) && isStatic(d) && !d.initializer) return optionalType(this.typeOf(d.name));
		}
		if (ts.isParenthesizedExpression(n)) return this.typeOf(n.expression);
		// A tuple literal where an array is held (a rest tuple, one on a recursive alias's cycle) is built as that array by `array`.
		if (ts.isArrayLiteralExpression(n) && this.checker.isTupleType(this.checker.getTypeAtLocation(n))) {
			const destructured = (ts.isVariableDeclaration(n.parent) && n.parent.initializer === n && ts.isArrayBindingPattern(n.parent.name)) || destructuringSource(n);
			const context = destructured ? undefined : this.checker.getContextualType(n);
			const held = context && !(context.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) && !(this.checker.isTupleType(context) && n.elements.some(ts.isSpreadElement)) ? this.heldElements(n, this.type(context, n)).replace(/\?$/, '') : '';
			if (isKit(spelledType(held), 'JSArray')) return held;
		}
		if (isArguments(n, this.checker)) return 'JSArray<Any?>';
		if (this.isAugmentedLibMember(n)) return 'Any?';
		const evolving = evolvingArrayRead(n, this.checker);
		if (evolving) return this.typeOf(evolving.name);
		const evolvingDecl = ts.isVariableDeclaration(n) ? n : (ts.isIdentifier(n) || ts.isArrayLiteralExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && (n.parent.name === n || n.parent.initializer === n) ? n.parent : undefined;
		const stated = evolvingDecl && evolvingArrayType(evolvingDecl, this.checker);
		if (stated) return this.type(stated, n);
		const evolvingRead = ts.isElementAccessExpression(n) && evolvingArrayRead(ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses), this.checker);
		const statedElement = evolvingRead && evolvingArrayType(evolvingRead, this.checker);
		if (statedElement) return this.type(this.checker.getTypeArguments(statedElement as ts.TypeReference)[0]!, n);
		if (ts.isCallExpression(n) && this.states.lenientAsyncCall(n)) return this.returnTypeOf(this.checker.getResolvedSignature(n)!.getDeclaration() as ts.SignatureDeclaration);
		const widened = ts.isExpression(n) ? this.states.widenedPromise(n) : null;
		if (widened) return this.returnTypeOf(widened);
		if (this.states.heldNullish(n) || this.states.nullishReadUntyped(n) || (ts.isPropertyAccessExpression(n) && untypedResultField(this, this.checker.getSymbolAtLocation(n.name))) || untypedResultBinding(this, n)) return 'Any?';
		const held = this.heldSignal(n);
		if (held) return held;
		if (!this.library && ts.isIdentifier(n)) {
			const d = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
			const wider = d && ts.isVariableDeclaration(d) && d.initializer && (ts.isAsExpression(ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses)) || ts.isTypeAssertionExpression(ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses))) ? this.widerAsserted(d) : null;
			if (wider) return wider;
		}
		if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) return 'Any?';
		if (this.library && this.isThisValue(n)) return 'Any?';
		if (this.library && ts.isIdentifier(n) && this.passedParams.size) {
			const d = ts.isShorthandPropertyAssignment(n.parent) ? this.checker.getShorthandAssignmentValueSymbol(n.parent)?.valueDeclaration : this.checker.getSymbolAtLocation(n)?.valueDeclaration;
			if (d && ts.isParameter(d) && this.passedParams.has(d)) return 'Any?';
		}
		if (this.library && this.widenedAccessors.size) {
			// A read of such a getter, or a variable it initializes (`const nativeView = this.nativeTextViewProtected`).
			const d = ts.isIdentifier(n) ? this.checker.getSymbolAtLocation(n)?.valueDeclaration : undefined;
			if (d && ts.isParameter(d) && this.widenedAccessors.has(d)) return this.widenedAccessors.get(d)!;
			const read = ts.isPropertyAccessExpression(n) ? n : d && ts.isVariableDeclaration(d) && !d.type && d.initializer && ts.isPropertyAccessExpression(d.initializer) ? d.initializer : undefined;
			const widened = read ? (this.checker.getSymbolAtLocation(read.name)?.declarations ?? []).map((x) => this.widenedAccessors.get(x)).find(Boolean) : undefined;
			if (widened) return widened;
		}
		// Library mode: a parameter destructuring an object (`({ property, value }: KeyframeDeclaration)`, `({ x, y }) => …`), which script
		// gives plain objects as well as typed ones: read by name.
		if (this.library && ts.isObjectBindingPattern(n) && ts.isParameter(n.parent)) {
			const sym = this.checker.getTypeAtLocation(n).getSymbol();
			const decl = sym?.valueDeclaration;
			const fieldsOnly = !!decl && ts.isClassDeclaration(decl) && !decl.getSourceFile().isDeclarationFile && decl.members.every((m) => ts.isPropertyDeclaration(m));
			if (fieldsOnly || !sym || sym.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral | ts.SymbolFlags.Interface)) return 'Any?';
		}
		if (this.library && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && this.untypedJavaFields().size) {
			const d = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n)?.valueDeclaration;
			if (d && this.untypedJavaFields().has(d)) return 'Any?';
		}
		const call = this.library ? (ts.isCallExpression(n) ? n : ts.isIdentifier(n) ? this.untypedInitializer(n) : undefined) : undefined;
		if (call) {
			const d = this.checker.getResolvedSignature(call)?.getDeclaration();
			if (d && !ts.isJSDocSignature(d) && this.returnsNullApart(implementationOf(d) ?? d)) return 'Any?';
		}
		if (this.library && (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && this.checker.getTypeAtLocation(n).flags & ts.TypeFlags.Never) return 'Any?';
		// Library mode: a class's prototype is the runtime's object for it, whatever the class's type says.
		if (this.library && ts.isPropertyAccessExpression(n) && n.name.text === 'prototype' && !(ts.isIdentifier(n.expression) && BUFFER_TYPES.has(n.expression.text))) return 'Any?';
		if (this.isPrototypeRef(n) || (ts.isPropertyAccessExpression(n) && this.isPrototypeRef(n.expression)) || this.isAmbient(n)) return 'Any?';
		if (this.library && ts.isIdentifier(n) && n.text === 'Reflect' && isLibDeclaration(this.resolve(n)?.declarations?.[0])) return 'Any?';
		// A Java package read on through `?.` (`org.nativescript?.Bootstrap`), untyped.
		if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && this.isJavaPackage(this.resolve(ts.isPropertyAccessExpression(n) ? n.name : n)) && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.questionDotToken) return 'Any?';
		// Library mode: a variable holding a Java package (`const androidxGraphics = androidx.core.graphics`), read untyped.
		if (this.library && ts.isIdentifier(n)) {
			const d = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
			const init = d && ts.isVariableDeclaration(d) && d.initializer;
			if (init && ts.isPropertyAccessExpression(init) && this.isJavaPackage(this.resolve(init.name))) return 'Any?';
		}
		if (this.untypedThis.has(n) || this.holdsFunctionObject(n)) return 'Any?';
		if (!this.library && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n))) {
			const named = ts.isPropertyAccessExpression(n) ? n.name : n;
			const own = n.parent && (ts.isPropertyDeclaration(n.parent) || ts.isParameter(n.parent)) && n.parent.name === n ? n.parent : this.checker.getSymbolAtLocation(named)?.valueDeclaration;
			if (own && this.overUntypedField(own)) return 'Any?';
		}
		// A value declared `unknown` stays untyped where checks narrow it (`value !== null` makes it `{}`, which is no object shape).
		if (ts.isIdentifier(n)) {
			const decl = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
			if (decl && (ts.isParameter(decl) || ts.isVariableDeclaration(decl)) && decl.type?.kind === ts.SyntaxKind.UnknownKeyword) return 'Any?';
			// App mode: a variable a function it declares sets (`let page: Page` set by a page factory), which the checker's flow
			// reads as unset after the call: its declared type.
			if (!this.library && decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && (n.parent as ts.NamedDeclaration | undefined)?.name !== n && this.checker.getTypeAtLocation(n).flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never) && this.setInClosure(decl)) {
				const declared = this.checker.getTypeOfSymbolAtLocation(this.checker.getSymbolAtLocation(n)!, decl);
				if (!(declared.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never))) return this.type(declared, decl.name);
			}
		}
		// Library mode: a read checks narrow to nothing (`value` past `typeof value === 'string'` of a string): untyped, as unchecked code may reach it.
		if (this.library && ts.isIdentifier(n) && this.checker.getTypeAtLocation(n).flags & ts.TypeFlags.Never && (n.parent as ts.NamedDeclaration | undefined)?.name !== n) return 'Any?';
		const declared = this.type(this.checker.getTypeAtLocation(n), n);
		const own = ts.isPropertySignature(n) || ts.isPropertyDeclaration(n) ? n : (n.parent as ts.NamedDeclaration | undefined)?.name === n ? n.parent : undefined;
		const t = this.isLenientDecl(own) ? this.lenientRef(declared) : this.states.looseDeclaration(own) ? optionalType(declared) : declared;
		if (this.holdingNull(t, n)) return t.replace(/>$/, '?>');
		if (['String', 'Double', 'Boolean'].includes(t) && this.givenNullSignalValue(n)) return `${t}?`;
		if (/^JSArray<String>\??$/.test(t) && this.unsetGroups(n)) return t.replace('JSArray<String>', 'JSArray<String?>');
		if (t === 'String' && ts.isIdentifier(n) && this.unset.element(n)) return 'String?';
		if (!t.includes('.')) return t;
		const sym = ts.isIdentifier(n) ? this.checker.getSymbolAtLocation(n) : undefined;
		const decl = sym?.valueDeclaration;
		const init = decl && ts.isVariableDeclaration(decl) && !decl.type ? decl.initializer : ts.isAsExpression(n) ? n : undefined;
		return (init && this.uncheckedCast(init)) ?? t;
	},

	/**
	 * A script cast of a core view's native view to a Java class that view is
	 * not (`scrollView.android as android.widget.ScrollView`, a NestedScrollView):
	 * unchecked in script, here a cast to the nearest class both extend.
	 */
	uncheckedCast(this: Translator, e: ts.Expression): string | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!ts.isAsExpression(e) || !this.core || !this.native) return null;
		let inner = e.expression;
		while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
		const made = this.core.nativeClassOf(inner);
		const to = this.type(this.checker.getTypeAtLocation(e), e);
		return made ? this.native.sharedClass(made, to.replace(/\?$/, '')) : null;
	},

	/** An element of an array Kotlin holds untyped (`views[1]` of a tuple of more than three), whatever TypeScript types it. */
	untypedElement(this: Translator, e: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		return ts.isElementAccessExpression(e) && isNamed(spelledType(this.typeOf(e.expression)), 'JSArray<Any?>', false) && !this.isAny(e);
	},

	/** The module `{ a: __import0_a, … }` reads the names of (the build's rewrite of `await import(…)`), or null. */
	dynamicImport(this: Translator, arg: ts.Expression | undefined): string | null {
		if (!arg || !ts.isObjectLiteralExpression(arg) || !arg.properties.length) return null;
		const files = arg.properties.map((p) => {
			if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.initializer) || !/^__import\d+_/.test(p.initializer.text)) return null;
			const sym = this.checker.getSymbolAtLocation(p.initializer);
			const target = sym && sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
			return target?.declarations?.[0]?.getSourceFile().fileName ?? null;
		});
		return files.every((f) => f && f === files[0]) ? files[0] : null;
	},

	/** A call of the program's function declared to give its type parameter, which returns undefined or null. */
	givesNothing(this: Translator, e: ts.Expression): boolean {
		if (!ts.isCallExpression(e)) return false;
		const fn = this.checker.getResolvedSignature(e)?.getDeclaration();
		if (!fn || ts.isJSDocSignature(fn) || !ts.isFunctionDeclaration(fn) || !fn.body || !fn.type || !ts.isTypeReferenceNode(fn.type) || !ts.isIdentifier(fn.type.typeName)) return false;
		const param = (fn.type.typeName as ts.Identifier).text;
		if (!fn.typeParameters?.some((p) => p.name.text === param)) return false;
		let found = false;
		const visit = (n: ts.Node): void => {
			if (found || (n !== fn && ts.isFunctionLike(n))) return;
			if (ts.isReturnStatement(n) && n.expression && (n.expression.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'undefined'))) found = true;
			ts.forEachChild(n, visit);
		};
		ts.forEachChild(fn.body, visit);
		return found;
	},

	/** A call of a Java method whose result is an object (Kotlin's null for Java's null). */
	javaObjectResult(this: Translator, e: ts.CallExpression): boolean {
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		if (!decl || ts.isJSDocSignature(decl) || !this.native?.isNativeDeclaration(decl)) return false;
		const t = this.typeOf(e);
		return !isUntyped(spelledType(t)) && t !== 'Unit' && !['Double', 'Boolean'].includes(t.replace(/\?$/, ''));
	},

	/** Whether a function inside a variable's scope assigns it. */
	setInClosure(this: Translator, decl: ts.VariableDeclaration): boolean {
		const scope = ts.findAncestor(decl, (x) => ts.isFunctionLike(x) || ts.isSourceFile(x));
		const sym = this.checker.getSymbolAtLocation(decl.name);
		if (!scope || !sym) return false;
		let found = false;
		const visit = (x: ts.Node, inner: boolean): void => {
			if (found) return;
			if (inner && ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(x.left) && this.checker.getSymbolAtLocation(x.left) === sym) {
				found = true;
				return;
			}
			ts.forEachChild(x, (c) => visit(c, inner || (ts.isFunctionLike(c) && c !== scope)));
		};
		visit(scope, false);
		return found;
	},

	/**
	 * Lenient code: a declaration of an object type holds null and undefined as well, as Swift's implicitly unwrapped
	 * declarations do. Kotlin declares it nullable, and a read unwraps it unless it only tests or passes the value on.
	 */
	lenientRef(this: Translator, t: string): string {
		return this.lenient && !t.endsWith('?') && !['Nothing', 'JSSymbol', 'JSBigInt'].includes(t) && this.isObjectType(t) ? optionalType(t) : t;
	},

	/** A variable, parameter or field the program declares, in lenient code. */
	isLenientDecl(this: Translator, d: ts.Node | undefined): boolean {
		return this.lenient && !!d && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && !d.getSourceFile().isDeclarationFile && !(ts.isParameter(d) && d.dotDotDotToken) && !presentConst(d);
	},

	/** A call of a lenient function declared to give an object: unwrapped unless the value is only tested or passed on. */
	lenientResult(this: Translator, e: ts.CallExpression, code: string): string {
		if (this.rawResults.has(e) || !this.unwrapsResult(e)) return code;
		// A string, number or boolean that may be missing reads as what undefined converts to; an object is required present.
		const site = this.typeOf(e);
		// A non-strict app's null-only result: its null is carried as the app's other nulls are (`jsUncheckedNull`).
		if (this.lenientApp && this.isObjectType(site) && this.states.nullResult(e)) return `(${code} ?: ${RT.jsUncheckedNull}<${site}>())`;
		const field = this.states.placedField(e);
		if (field) return `${RT.jsRequired}(${code}, ${kotlinString(field.name)})`;
		return ['String', 'Double', 'Boolean'].includes(site) ? this.undefinedAs(code, site) : this.asserted(code);
	},

	/** Whether a call's result Kotlin holds nullable, though its type says present, is unwrapped where it is read (see `lenientResult`). */
	unwrapsResult(this: Translator, e: ts.CallExpression): boolean {
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		if (!this.lenient && !(decl && !ts.isJSDocSignature(decl) && (this.states.looseDeclaration(decl) || this.states.widenedResult(decl)))) return false;
		if (!decl || ts.isJSDocSignature(decl) || decl.getSourceFile().isDeclarationFile || !(ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl))) return false;
		// A result nothing reads, or an optional chain's (undefined where it stops), is not unwrapped.
		const chainGoesOn = (ts.isPropertyAccessExpression(e.parent) || ts.isElementAccessExpression(e.parent) || ts.isCallExpression(e.parent)) && e.parent.expression === e && !!(e.parent.flags & ts.NodeFlags.OptionalChain);
		if (ts.isExpressionStatement(e.parent) || (e.flags & ts.NodeFlags.OptionalChain && !chainGoesOn)) return false;
		const site = this.typeOf(e);
		return this.returnTypeOf(decl) === optionalType(site) && site !== optionalType(site) && !this.nullTolerant(e);
	},

	/** Runs `body` with `this` in `fn` (and in the arrow functions inside it) read as `name`. */
	withThis<T>(this: Translator, fn: ts.Node, name: string, untyped: boolean, body: () => T): T {
		const nodes = thisNodes(fn);
		for (const n of nodes) {
			this.subst.set(n, name);
			if (untyped) this.untypedThis.add(n);
		}
		try {
			return body();
		} finally {
			for (const n of nodes) {
				this.subst.delete(n);
				this.untypedThis.delete(n);
			}
		}
	},
};
