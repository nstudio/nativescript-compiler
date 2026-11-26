// TypeScript types as Swift types: representations, held and optional forms, shapes.
import ts from 'typescript';
import { DESCRIPTORS } from './library.ts';
import { WEB_DICTIONARIES, isWebClass } from '../semantics/globals.ts';
import { SPELLING, spell, functionParts, heldType, isFunctionLiteral, isFunctionType, isMethodValue, isOptional, nullishType, optionalElementsType, optionalType, returningAny, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { literalOverArray, membersOverTypeParameter, readByKey, definedField, untypedResultBinding, untypedResultField } from '../semantics/shapes.ts';
import { ambientAddedMemberOf, ambientBase, augmentedPropertyRead, evolvingArrayRead, evolvingArrayType, isAmbientClass, isRegExpProtocol, mergedInterfaceMemberOf, statementLevel, tokenClassBase, undeclaredMemberOf, isArguments, nullableTypeNode } from '../semantics/lang.ts';
import { nullishSignalType } from '../semantics/signals.ts';
import { hasModifier, isLibDeclaration, isSymbolIterator, isWriteTarget, implementationOf, declaresThis } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { coreTypeKind, eventDataTypeLiteral, isJsDocConstructorFunction, isKit, isLibObjectType, isUntyped, libraryNativeType, libraryType, mappedOrErasedType, nonNullableInner, nonOptionalSpelling, parseNativeType, spelledType } from '../semantics/types.ts';
import { keepsIdentity } from '../semantics/conversion.ts';
import { extendedClass, isEventData } from '../semantics/classes.ts';
import { otherPlatformTypings } from '../semantics/platform-globals.ts';

export const typesMethods = {
	/**
	 * A plugin's class or interface the build does not declare: one in a file the build leaves out (`TextMetrics` named
	 * only in a cast), or a component class of a plugin's framework entry, whose instances only the framework's runtime makes.
	 * Any value.
	 */
	uncompiledType(this: Translator, t: ts.Type): boolean {
		const sym = t.aliasSymbol ?? t.getSymbol();
		const decl = sym && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface) ? sym.declarations?.[0] : undefined;
		const file = decl?.getSourceFile().fileName;
		if (!file || !this.pluginFiles.has(file)) return false;
		if (ts.isClassDeclaration(decl!) && this.isComponentClass(decl)) return true;
		if (!this.compiledFiles || this.compiledFiles.has(file)) return false;
		// An interface extending a class (`MenuView extends View`) is that class.
		return !(t.isClassOrInterface() && t.symbol.flags & ts.SymbolFlags.Interface && this.checker.getBaseTypes(t as ts.InterfaceType).some((b) => b.symbol?.flags & ts.SymbolFlags.Class));
	},

	/** `TypeView.leading`: an uncompiled class, an enum, a namespace or enum held as a value, `typeof globalThis`, `keyof T`. */
	leadingType(this: Translator, t: ts.Type, where?: ts.Node): string | null {
		const c = this.checker;
		const F = ts.TypeFlags;
		if (this.uncompiledType(t)) return 'Any?';
		if (t.flags & F.EnumLike) {
			// One member of a program's or core's enum (`AndroidDirectory.DOWNLOADS`, as a literal's field narrows it): its value's type.
			const member = !t.isUnion() ? t.getSymbol()?.valueDeclaration : undefined;
			if (member && ts.isEnumMember(member) && (isCoreDeclaration(member) || !member.getSourceFile().isDeclarationFile)) {
				const v = c.getConstantValue(member);
				return typeof v === 'string' ? 'String' : typeof v === 'number' ? 'Double' : 'Any?';
			}
			const native = this.native.type(t);
			if (native) return native;
		}
		// A native enum that may be missing (`hinge?.status`): the optional enum.
		if (t.isUnion() && t.types.some((u) => u.flags & (F.Undefined | F.Null))) {
			const present = c.getNonNullableType(t);
			const native = present !== t && present.flags & F.EnumLike ? this.native.type(present) : null;
			if (native) return optionalType(native);
		}
		// A namespace as a value (`{ Accuracy: CoreTypes.Accuracy }`): its enum's metatype.
		const nsDecl = t.flags & F.Object && t.getSymbol()?.flags! & ts.SymbolFlags.ValueModule ? t.getSymbol()!.valueDeclaration : undefined;
		if (nsDecl && ts.isModuleDeclaration(nsDecl) && !nsDecl.getSourceFile().isDeclarationFile) return `${this.namespacePath(nsDecl)}.Type`;
		// An enum as a value (`typeof AccessibilityRole`): the object JavaScript makes of it.
		// Not the enum's own name, through which its members are read (`Status.Denied`).
		const enumObject = t.flags & F.Object && (t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.RegularEnum ? t.getSymbol()!.valueDeclaration : undefined;
		const named = where && (ts.isIdentifier(where) || ts.isPropertyAccessExpression(where)) && this.resolve(ts.isPropertyAccessExpression(where) ? where.name : where)?.valueDeclaration === enumObject;
		if (enumObject && !named && ts.isEnumDeclaration(enumObject) && (!enumObject.getSourceFile().isDeclarationFile || isCoreDeclaration(enumObject))) return 'JSObject';
		// `typeof globalThis`: the global object, untyped.
		if (t.flags & F.Object && t.getSymbol()?.name === 'globalThis' && t.getSymbol()!.flags & ts.SymbolFlags.ValueModule) return 'Any?';
		if (t.flags & F.Index) return 'Any?';
		return null;
	},

	typeParameterType(this: Translator, t: ts.Type, where?: ts.Node): string {
		// A method's `this` is its class.
		const constraint = (t as ts.TypeParameter & { isThisType?: boolean }).isThisType ? t.getConstraint() : undefined;
		if (constraint) return this.type(constraint, where);
		const decl = t.symbol?.declarations?.[0];
		if (decl && this.pluginFiles.has(decl.getSourceFile().fileName) && !(ts.isTypeParameterDeclaration(decl) && this.keepsGenerics(decl.parent))) return 'Any?';
		// A library's generic signature (`ClassDecorator`'s `TFunction`) in library mode: erased as the program's own are.
		if (decl && this.library && decl.getSourceFile().isDeclarationFile) return 'Any?';
		if (decl && ts.isTypeParameterDeclaration(decl) && this.erasesTypeParameter(decl)) return 'Any?';
		// Inside an object shape, a class of its own outside every generic scope: any value.
		if (this.shaping.size) return 'Any?';
		return t.symbol?.name ?? 'Any?';
	},

	/** `UIView & { nsView?: … }`, `ScrollView & { … }`: the class; the members the literal adds are read by name. */
	intersectionType(this: Translator, t: ts.IntersectionType, where?: ts.Node): string | null {
		const c = this.checker;
		const F = ts.TypeFlags;
		if (literalOverArray(t, c)) return 'Any?';
		// `typeof globalThis & { … }`: the global object, untyped as `typeof globalThis` is, its added members read by name.
		if (t.types.some((u) => u.flags & F.Object && u.getSymbol()?.name === 'globalThis' && u.getSymbol()!.flags & ts.SymbolFlags.ValueModule)) return 'Any?';
		// `UIApplicationDelegate & { prototype: UIApplicationDelegate }`: a native class object, as the iOS typings write one.
		const prototype = (u: ts.Type) => {
			const p = !this.native.type(u) && u.getProperty('prototype');
			return !!p && !!this.native.type(c.getTypeOfSymbol(p));
		};
		if (t.types.some(prototype) && t.types.some((u) => this.native.type(u))) return 'AnyClass';
		// Whichever of unrelated native classes an object is (`NSDictionary & NSData & NSArray`): NativeAPI.either.
		if (this.native.either(t)) return 'NSObject';
		// Two classes (`value: UIColor` narrowed by `instanceof Color`): the one the test found, which comes last.
		const cls = [...t.types].reverse().find((u) => this.native.type(u) || (u.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class);
		if (cls) return this.type(cls, where);
		// `T & string`, a type parameter narrowed by typeof: the primitive.
		const primitive = t.types.find((u) => u.flags & (F.StringLike | F.NumberLike | F.BooleanLike));
		if (primitive && t.types.every((u) => u === primitive || u.flags & (F.TypeParameter | F.Index))) return this.type(primitive, where);
		// `T & Record<K, unknown>`, a type parameter narrowed by `key in owner`: the type parameter, its key read by name.
		const param = t.types.find((u) => u.flags & F.TypeParameter);
		const inNarrowing = (u: ts.Type) => !!(u.flags & F.Object) && !u.getCallSignatures().length && u.getProperties().every((p) => c.getTypeOfSymbol(p).flags & F.Unknown);
		if (param && (isUntyped(spelledType(this.type(param, where))) || t.types.every((u) => u === param || inNarrowing(u)))) return this.type(param, where);
		if (membersOverTypeParameter(t, c)) return 'Any?';
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
		// Lenient code: an object in a tuple may be missing (a shorthand's converter probed with `unsetValue` pairs each longhand with it).
		const args = c.getTypeArguments(t as ts.TypeReference).map((a) => {
			const at = this.type(a, where);
			return this.lenient && this.lenientRef(at) !== at ? optionalType(at) : at;
		});
		const rest = ((t as ts.TypeReference).target as ts.TupleType).hasRestElement || (where && ((ts.isParameter(where) && !!where.dotDotDotToken) || (ts.isIdentifier(where) && ts.isParameter(where.parent) && !!where.parent.dotDotDotToken)));
		if (args.length < 2 || rest) return `JSArray<${args.length && args.every((a) => a === args[0]) ? args[0] : 'Any?'}>`;
		return `(${args.join(', ')})`;
	},

	namedType(this: Translator, t: ts.Type, where?: ts.Node): string {
		const c = this.checker;
		const F = ts.TypeFlags;
		// An alias of a class's type (`type UntypedFormGroup = FormGroup<any>`) is that class.
		const sym = t.aliasSymbol && !((t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class && t.aliasSymbol.flags & ts.SymbolFlags.TypeAlias && !(t.aliasSymbol.flags & ts.SymbolFlags.Class)) ? t.aliasSymbol : t.getSymbol();
		if (isRegExpProtocol(t)) return 'JSRegExp';
		// `Awaited<T>` of a type parameter (what `await` of a `T` gives): the value a promise of it settles with, else `T` itself.
		if (t.aliasSymbol?.name === 'Awaited' && isLibDeclaration(t.aliasSymbol.declarations?.[0]) && t.aliasTypeArguments?.length === 1) {
			return this.type(t.aliasTypeArguments[0], where).replace(/^JSPromise<(.*)>([?!]?)$/, (_, v: string, o: string) => (o ? optionalType(v) : v));
		}
		// A component class as a value (`typeof SheetComponent`) is what creating and rendering it gives.
		const classDecl = sym?.valueDeclaration;
		if (classDecl && ts.isClassDeclaration(classDecl) && t.getConstructSignatures().length && this.framework.componentClass(classDecl, true)) return this.framework.hooks.componentValueType!;
		// An Android type in an iOS build names a value only Android code holds: here it is always undefined.
		if (sym?.declarations?.[0] && otherPlatformTypings(this.ledger).test(sym.declarations[0].getSourceFile().fileName)) return 'Any?';
		const declName = sym?.declarations?.[0] && (ts.isClassDeclaration(sym.declarations[0]) || ts.isInterfaceDeclaration(sym.declarations[0])) ? sym.declarations[0].name?.text : undefined;
		// A default-exported class is known by its declared name.
		const name = sym?.getName() === 'default' ? (declName ?? 'default') : sym?.getName();
		const args = () => t.aliasTypeArguments ?? c.getTypeArguments(t as ts.TypeReference);
		const arg = (k: number) => {
			const a = args()[k];
			return a ? this.type(a, where) : 'Any?';
		};
		// Core's own code (library mode) is typed by the DOM's library, whose web classes are the runtime's too.
		if (name && (sym?.declarations?.[0]?.getSourceFile().fileName === '/__shims__/globals.d.ts' || (this.library && isLibDeclaration(sym?.declarations?.[0])))) {
			if (isWebClass(this.ledger, name)) return `JS${name}`;
			if (WEB_DICTIONARIES.includes(name)) return 'Any?';
		}
		const kind = name === undefined ? undefined : this.framework.signalKind(name);
		if (kind === 'writable' || kind === 'input' || kind === 'model') {
			if (!this.lenient && !this.library && nullishSignalType(c, t, (n) => this.framework.signalKind(n))) return `Signal<${nullishType(arg(0))}>`;
			return `Signal<${arg(0)}>`;
		}
		if (kind === 'computed') return where && this.isComputedProperty(where) ? arg(0) : `Signal<${arg(0)}>`;
		if (kind) return `Signal<${arg(0)}>`;
		const mapped = name === undefined ? undefined : this.framework.typeMapping(name);
		if (mapped && (!mapped.shim || sym?.declarations?.[0]?.getSourceFile().fileName.startsWith('/__shims__/'))) {
			// `typeof ErrorHandler` (a provider's `provide`): the class itself.
			if (mapped.metatype && sym!.flags & ts.SymbolFlags.Class && t !== c.getDeclaredTypeOfSymbol(sym!) && t.getConstructSignatures().length) return `${mapped.type}.Type`;
			return mapped.type.includes('$0') ? mapped.type.replace('$0', () => arg(0)) : mapped.type;
		}
		// Swift's generated kit holds core's own animation promises untyped, and its Animation classes are written against that.
		const coreType = name === undefined ? null : coreTypeKind(name, sym?.declarations?.[0], false);
		if (coreType) return coreType === 'void-promise' ? 'JSPromise<Void>' : 'Any?';
		const library = name === undefined ? null : libraryType(name, sym, this.ledger);
		if (library) return spell(libraryNativeType(library, (k) => parseNativeType(arg(k)), SPELLING, this.ledger));
		const nn = nonNullableInner(t, name, args());
		if (nn) return nonOptionalSpelling(this.type(nn, where));
		if (isLibObjectType(name, sym)) return 'Any?';
		// `typeof UIGestureRecognizer`: the native class as a value.
		if (sym && sym.flags & ts.SymbolFlags.Class && t.getConstructSignatures().length && !t.getCallSignatures().length && sym.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) {
			const instance = this.native.type(c.getDeclaredTypeOfSymbol(sym));
			if (instance) return `${instance}.Type`;
		}
		const native = this.native.type(t);
		if (native) return native;
		// An Android class (`android.view.View`) is only ever held, never made, on iOS.
		if (sym?.declarations?.[0] && otherPlatformTypings(this.ledger).test(sym.declarations[0].getSourceFile().fileName)) return 'Any?';
		const index = t.getStringIndexType() ?? t.getNumberIndexType();
		// Library mode: what a constructor typed `new (): { [k: string]: T }` makes is a plain object, whatever script writes into it.
		const made = sym?.declarations?.[0];
		if (index && !t.getProperties().length && this.library && made && ts.isTypeLiteralNode(made) && ts.isConstructSignatureDeclaration(made.parent)) return 'JSRecord<Any?>';
		if (index && !t.getProperties().length) return `JSRecord<${heldType(this.type(index, where))}>`;
		// A literal with computed keys beside named ones (`{ [k]: 1, a: 2 }`): its keys are known only when it runs.
		if (index && sym?.getName() === '__object') return 'Any?';
		const erasedType = mappedOrErasedType(t, name, sym);
		if (erasedType) return erasedType === 'any' ? 'Any?' : this.type(erasedType, where);
		// Library mode: a constructor held as a value (`PropertyBag: { new (): Bag }`) is constructed untyped.
		if (this.library && t.getConstructSignatures().length && !t.getCallSignatures().length && !((sym?.flags ?? 0) & ts.SymbolFlags.Class)) return 'Any?';
		const calls = t.getCallSignatures();
		// A function declaration given properties (`handler.tag = 'T'`) is its function: they are its function object's.
		const expando = !!sym && !!(sym.flags & ts.SymbolFlags.Function) && !!sym.valueDeclaration && ts.isFunctionDeclaration(sym.valueDeclaration) && !sym.valueDeclaration.getSourceFile().isDeclarationFile;
		if (calls.length && (!t.getProperties().length || expando)) {
			// An overloaded function or method as a value (`store.dispatch.bind(store)`) is its implementation, which every call reaches.
			const over = calls.length > 1 ? t.getSymbol()?.valueDeclaration : undefined;
			const impl = over && (ts.isFunctionDeclaration(over) || ts.isMethodDeclaration(over)) ? implementationOf(over) : null;
			if (impl && (ts.isFunctionDeclaration(impl) || ts.isMethodDeclaration(impl))) return this.functionValueType(impl);
			const s = calls[0];
			// A function type reading the receiver it is called with (`(this: Action, state) => void`): a script function, as
			// `call`/`apply` pass that receiver and a Swift closure has none.
			const sd = s.getDeclaration() as ts.SignatureDeclaration | undefined;
			if (sd && (ts.isFunctionTypeNode(sd) || ts.isFunctionExpression(sd)) && declaresThis(sd)) return 'Any?';
			// A generic function as a value (`obj.notify`) is no Swift closure's type: its own type parameters are their constraints.
			const own = (x: ts.Type) => (x.flags & F.TypeParameter && s.typeParameters?.includes(x as ts.TypeParameter) ? (c.getBaseConstraintOfType(x) ?? c.getAnyType()) : x);
			const params = s
				.getParameters()
				.filter((p) => p.name !== 'this')
				.map((p) => {
					if (p.valueDeclaration && this.states.nullish().held.has(p.valueDeclaration)) return 'Any?';
					const plain = this.type(own(c.getTypeOfSymbolAtLocation(p, where ?? p.valueDeclaration!)), where);
					const pt = p.valueDeclaration && ts.isParameter(p.valueDeclaration) && !p.valueDeclaration.dotDotDotToken && this.states.optionalElements(p.valueDeclaration) ? optionalElementsType(plain) : plain;
					if (p.valueDeclaration && this.states.nullishHeld(p.valueDeclaration)) return nullishType(pt);
					if (p.valueDeclaration && ts.isParameter(p.valueDeclaration) && (p.valueDeclaration.questionToken || p.valueDeclaration.initializer || nullableTypeNode(p.valueDeclaration.type) || this.states.scriptCalledParameter(p.valueDeclaration) || this.states.widened(p.valueDeclaration))) return optionalType(pt);
					// Lenient code may pass null for an object: the parameter is optional, as a closure's implicitly unwrapped one is.
					if ((this.lenientRef(pt) !== pt || this.lenientAppParameter(p.valueDeclaration, pt)) && !(p.valueDeclaration && ts.isParameter(p.valueDeclaration) && p.valueDeclaration.dotDotDotToken)) return optionalType(pt);
					// A rest parameter is spelled `JSRest` (an array, to Swift): a script function called as this type takes the array's elements as its arguments.
					if (p.valueDeclaration && ts.isParameter(p.valueDeclaration) && p.valueDeclaration.dotDotDotToken && isKit(spelledType(pt), 'JSArray')) return `JSRest<${pt.slice(8)}`;
					return isFunctionType(pt) ? `@escaping ${pt}` : pt;
				});
			// One parameter of no value is spelled `(())`: Swift reads `(Void) -> T` as taking no arguments.
			return `(${params.length === 1 && params[0] === 'Void' ? '()' : params.join(', ')}) throws -> ${sd && this.states.nullish().held.has(sd) ? 'Any?' : sd && this.states.nullishHeld(sd) ? nullishType(this.type(own(s.getReturnType()), where)) : this.widenedResultType(sd, this.type(own(s.getReturnType()), where))}`;
		}
		// An interface extending one class is that class; one merged into a class of its name is the class.
		const extended = sym && sym.flags & ts.SymbolFlags.Interface && !(sym.flags & ts.SymbolFlags.Class) ? extendedClass(t, this.checker) : null;
		if (extended) return this.type(extended, where);
		if (isAmbientClass(sym)) {
			const base = ambientBase(sym!, this.checker);
			return base ? this.type(base, where) : 'Any?';
		}
		if (sym && this.isDynamicShape(sym)) return 'Any?';
		if (isEventData(t, this.checker)) return 'EventData';
		// A generic type the kit declares (`ListItem<Recipe>`) keeps its arguments.
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
		const compiled = this.compiledCounterpart(sym);
		if (compiled) return this.type(this.checker.getDeclaredTypeOfSymbol(compiled), where);
		// `typeof Cls`: the class itself.
		if (!this.ledger.appClassValuesUntyped && sym && sym.flags & ts.SymbolFlags.Class && t.getConstructSignatures().length && classDecl && !classDecl.getSourceFile().isDeclarationFile) return `${this.topNames().get(classDecl) ?? (classDecl as ts.ClassDeclaration).name?.text ?? name}.Type`;
		const tokenBase = tokenClassBase(t, c, this.pluginFiles);
		if (tokenBase) return this.type(c.getTypeAtLocation(tokenBase), where);
		if (isJsDocConstructorFunction(sym)) return 'Any?';
		const renamed = sym && this.topNames().get(sym.valueDeclaration ?? sym.declarations?.[0]!);
		if (renamed) {
			if (sym.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) this.used.add(renamed);
			return `${renamed}${this.classTypeArguments(t, classDecl, where)}`;
		}
		// A mixin's class is the core class it is applied to.
		const mixin = this.mixinOf(sym);
		if (mixin) return mixin;
		if (name && name !== '__type' && name !== '__object' && this.inNativeClassBody && this.appModule && sym?.flags! & ts.SymbolFlags.Class && sym?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) {
			return `${this.appModule}.${this.topNames().get(sym!.valueDeclaration ?? sym!.declarations![0]) ?? name}`;
		}
		if (name && name !== '__type' && name !== '__object') {
			// Library mode: an interface only a declaration file has (the DOM's `MediaQueryListEvent`, core's `AddChildFromBuilder`) has no Swift type.
			if (this.library && sym && sym.flags & ts.SymbolFlags.Interface && !(sym.flags & ts.SymbolFlags.Class) && sym.declarations?.every((d) => d.getSourceFile().isDeclarationFile && ((isLibDeclaration(d) && (/lib\.dom/.test(d.getSourceFile().fileName) || DESCRIPTORS.has(name))) || isCoreDeclaration(d)))) return 'Any?';
			if (sym?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) this.used.add(name);
			// A core class its declarations name as the platform file's (`Font` of `font.ios.ts`), which the kit names apart from the common one.
			if (!this.library && sym && sym.flags & ts.SymbolFlags.Class && isCoreDeclaration(sym.declarations?.[0])) {
				// A class of core's the kit has nothing of (Android's `AndroidApplication` on iOS): any value, undefined here.
				const kit = this.core.platformClass(name);
				return this.core.has(kit) ? kit : 'Any?';
			}
			return `${name}${this.classTypeArguments(t, classDecl, where)}`;
		}
		if (eventDataTypeLiteral(t, this.checker)) return 'EventData';
		return this.shape(t, where);
	},

	/** A generic class of the app's keeps its arguments (`UITest<View>`); one Swift has erased is named without them. */
	classTypeArguments(this: Translator, t: ts.Type, classDecl: ts.Declaration | undefined, where?: ts.Node): string {
		const generic = classDecl && ts.isClassDeclaration(classDecl) && !classDecl.getSourceFile().isDeclarationFile && !this.erasesGenerics(classDecl) ? (classDecl.typeParameters ?? []) : [];
		const args = generic.length && t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? this.checker.getTypeArguments(t as ts.TypeReference).slice(0, generic.length) : [];
		return args.length === generic.length && args.length ? `<${args.map((a, k) => heldType(this.typeArgumentOf(generic[k], a, where))).join(', ')}>` : '';
	},

	/** A member script adds to a native object (`nativeView.nsView`): declared by the code itself, not by the SDK. */
	isExpando(this: Translator, e: ts.PropertyAccessExpression): boolean {
		if (readByKey(e, (o, k) => !!definedField(this.states, () => this.shapeFacts(), o, k))) return true;
		if (this.declaredOnly(e)) return true;
		if (!this.library && undeclaredMemberOf(e, this.checker)) return true;
		if (mergedInterfaceMemberOf(e, this.checker)) return true;
		// What an interface adds to a native class is read and written as the native object's expando without this.
		const held = ambientAddedMemberOf(e, this.checker);
		if (held && (!this.native.type(held) || !this.checker.getSymbolAtLocation(e.name)?.declarations?.every((d) => ts.isInterfaceDeclaration(d.parent)))) return true;
		if (!this.library && this.core.eventMember(e)) return true;
		const decl = this.checker.getSymbolAtLocation(e.name)?.declarations?.[0];
		if (decl && hasModifier(decl, ts.SyntaxKind.AbstractKeyword) && ts.isClassDeclaration(decl.parent) && this.pluginFiles.has(decl.parent.getSourceFile().fileName) && decl.parent.members.every((m) => hasModifier(m, ts.SyntaxKind.AbstractKeyword))) return true;
		const target = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression));
		if (!decl || !(ts.isPropertySignature(decl) && ts.isTypeLiteralNode(decl.parent))) return false;
		return [target, ...(target.isIntersection() ? target.types : [])].some((t) => !!this.native.type(t));
	},

	/** An `augmentedMember` read as `Any?`. */
	augmentedRead(this: Translator, e: ts.PropertyAccessExpression): string | null {
		return augmentedPropertyRead(e, this.checker) ? `${RT.jsGet}(${this.expr(e.expression)}, ${swiftString(e.name.text)})` : this.core.augmentedRead(e);
	},

	/** `type ItemView = View & ViewItemIndex` or `RxDatabaseBase & { heroes: RxCollection }`: what an intersection adds to a class's objects, kept as script adds it. */
	isAddedMember(this: Translator, e: ts.PropertyAccessExpression): boolean {
		const decl = this.checker.getSymbolAtLocation(e.name)?.declarations?.[0];
		const target = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression));
		if (!decl || !ts.isPropertySignature(decl) || !(ts.isInterfaceDeclaration(decl.parent) || ts.isTypeLiteralNode(decl.parent)) || decl.getSourceFile().isDeclarationFile || !target.isIntersection()) return false;
		return target.types.some((t) => !!(t.getSymbol()?.flags! & ts.SymbolFlags.Class) && !t.getProperty(e.name.text));
	},
	/**
	 * Library mode: a member a core declaration file declares on a class whose
	 * compiled implementation does not (`Transition.sharedElements`): what script
	 * keeps on the instance, read by name.
	 */
	declaredOnly(this: Translator, e: ts.PropertyAccessExpression): boolean {
		if (!this.library) return false;
		const decl = this.checker.getSymbolAtLocation(e.name)?.declarations?.[0];
		let name: string | undefined;
		if (!decl)
			name = this.typeOf(e.expression)
				.replace(/[?!]$/, '')
				.replace(/^\w+\./, '');
		else {
			const cls = decl.parent;
			if (!ts.isClassDeclaration(cls) || !cls.name || !decl.getSourceFile().isDeclarationFile || isLibDeclaration(decl) || /[\\/]objc![^\\/]+\.d\.ts$/.test(decl.getSourceFile().fileName)) return false;
			name = cls.name.text;
		}
		if (!this.compiledClasses) {
			this.compiledClasses = new Map();
			for (const f of this.sourceFiles) for (const st of f.statements) if (ts.isClassDeclaration(st) && st.name) this.compiledClasses.set(st.name.text, [...(this.compiledClasses.get(st.name.text) ?? []), st]);
		}
		const impls = this.compiledClasses.get(name);
		if (!impls?.length) return false;
		return impls.every((c) => !this.checker.getTypeAtLocation(c).getProperty(e.name.text));
	},

	/**
	 * `let cell;` read as `cell.index` where the checker narrows `cell` to a class without that member: code checked without
	 * noImplicitAny (a plugin's) declares an untyped variable, read by name.
	 */
	untypedLetReceiver(this: Translator, n: ts.Identifier): boolean {
		const access = n.parent;
		if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== n || this.checker.getSymbolAtLocation(access.name)) return false;
		const d = this.resolve(n)?.valueDeclaration;
		return !!d && ts.isVariableDeclaration(d) && !d.type && !d.initializer;
	},

	/** An element or value read out of a collection whose Swift type holds functions as function objects (`heldType`). */
	heldRead(this: Translator, n: ts.Node): boolean {
		if (ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n)) return this.heldRead(n.expression);
		if (ts.isIdentifier(n)) return this.heldParameter(this.resolve(n)?.valueDeclaration);
		const reads = ['find', 'findLast', 'at', 'pop', 'shift', 'get'];
		const target = ts.isElementAccessExpression(n) ? n.expression : ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && reads.includes(n.expression.name.text) ? n.expression.expression : null;
		if (target) return /^JS(Array<Any\?>|Record<Any\?>|Map<.*, Any\?>)[?!]?$/.test(this.typeOf(target));
		// A result or field the program types by a bare type parameter, bound here to a function type: Swift binds the parameter to the function object.
		const decl = ts.isCallExpression(n) ? this.checker.getResolvedSignature(n)?.getDeclaration() : ts.isPropertyAccessExpression(n) ? this.resolve(n.name)?.valueDeclaration : undefined;
		const typed = decl && !ts.isJSDocSignature(decl) && (ts.isCallExpression(n) ? ts.isFunctionLike(decl) : ts.isPropertyDeclaration(decl) || ts.isParameter(decl)) ? (decl as ts.SignatureDeclaration | ts.PropertyDeclaration | ts.ParameterDeclaration).type : undefined;
		return (!!typed && !decl!.getSourceFile().isDeclarationFile && this.isBareTypeParameter(typed)) || (ts.isPropertyAccessExpression(n) && this.heldParameter(decl)) || (ts.isCallExpression(n) && this.heldReturn(decl));
	},

	/**
	 * A parameter of the program's generic class, method or function typed as a function of its type parameters
	 * (`on(fn: (v: T) => void)`): held as the function object (`heldType`), since Swift reabstracts a closure passed to a
	 * generic parameter at each call, and `off(fn)` would never find what `on(fn)` stored. A parameter of a function type
	 * (`set: (done: (v: T) => void) => void`) is not: Swift spells the type with the closure type it names.
	 */
	heldParameter(this: Translator, d: ts.Node | undefined): boolean {
		return !this.library && !!d && ts.isParameter(d) && !!d.type && !d.dotDotDotToken && !d.getSourceFile().isDeclarationFile && !ts.isFunctionTypeNode(d.parent) && !ts.isConstructorTypeNode(d.parent) && !ts.isCallSignatureDeclaration(d.parent) && this.genericFunctionType(d.type) && keepsIdentity('function', d);
	},

	/** A function or method of the program returning a held parameter (`heldParameter`) as a function of its type parameters: the function object. */
	heldReturn(this: Translator, d: ts.Node | undefined): boolean {
		if (this.library || !d || !(ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) || !d.type || !d.body || d.getSourceFile().isDeclarationFile || !this.genericFunctionType(d.type)) return false;
		let held = false;
		const visit = (n: ts.Node): void => {
			if (held || (ts.isFunctionLike(n) && n !== d)) return;
			if (ts.isReturnStatement(n) && n.expression && this.heldParameter(this.resolve(n.expression)?.valueDeclaration)) held = true;
			ts.forEachChild(n, visit);
		};
		visit(d.body);
		return held;
	},

	/** Library code's parameter typed as a function of a type parameter is a closure Swift reabstracts at each call: no identity to compare. */
	refuseUnheldIdentity(this: Translator, e: ts.Expression): void {
		while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
		const d = ts.isIdentifier(e) ? this.resolve(e)?.valueDeclaration : undefined;
		if (this.library && d && ts.isParameter(d) && d.type && !d.getSourceFile().isDeclarationFile && this.genericFunctionType(d.type)) {
			throw this.error(e, 'comparing a function passed to a generic parameter typed with its type parameter (its identity, in library code)');
		}
	},

	genericFunctionType(this: Translator, type: ts.TypeNode): boolean {
		let t = type;
		while (ts.isParenthesizedTypeNode(t)) t = t.type;
		if (ts.isUnionTypeNode(t)) {
			const present = t.types.filter((u) => u.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(u) && u.literal.kind === ts.SyntaxKind.NullKeyword));
			if (present.length !== 1) return false;
			t = present[0];
			while (ts.isParenthesizedTypeNode(t)) t = t.type;
		}
		if (!ts.isFunctionTypeNode(t)) return false;
		const generic = (n: ts.Node): boolean => {
			if (ts.isTypeReferenceNode(n)) {
				const tp = this.checker.getSymbolAtLocation(n.typeName)?.declarations?.find(ts.isTypeParameterDeclaration);
				const owner = tp?.parent;
				if (tp && owner && (ts.isClassDeclaration(owner) || ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner)) && !this.erasesGenerics(owner) && !this.erasesTypeParameter(tp)) return true;
			}
			return !!ts.forEachChild(n, (c) => generic(c) || undefined);
		};
		return generic(t);
	},

	isBareTypeParameter(this: Translator, t: ts.TypeNode): boolean {
		return ts.isTypeReferenceNode(t) && !t.typeArguments && !!(this.checker.getTypeFromTypeNode(t).flags & ts.TypeFlags.TypeParameter);
	},

	plainTypeOf(this: Translator, n: ts.Node): string {
		if (ts.isParenthesizedExpression(n)) return this.typeOf(n.expression);
		if (isArguments(n, this.checker)) return 'JSArray<Any?>';
		const evolving = evolvingArrayRead(n, this.checker);
		if (evolving) return this.typeOf(evolving.name);
		const evolvingDecl = ts.isVariableDeclaration(n) ? n : (ts.isIdentifier(n) || ts.isArrayLiteralExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && (n.parent.name === n || n.parent.initializer === n) ? n.parent : undefined;
		const stated = evolvingDecl && evolvingArrayType(evolvingDecl, this.checker, this.holeless);
		if (stated) return this.type(stated, n);
		const evolvingRead = ts.isElementAccessExpression(n) && evolvingArrayRead(ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses), this.checker);
		const statedElement = evolvingRead && evolvingArrayType(evolvingRead, this.checker, this.holeless);
		if (statedElement) return this.type(this.checker.getTypeArguments(statedElement as ts.TypeReference)[0]!, n);
		if (ts.isCallExpression(n) && this.lenientApp && this.states.lenientAsyncCall(n)) return this.returnTypeOf(this.checker.getResolvedSignature(n)!.getDeclaration() as ts.SignatureDeclaration);
		const widened = ts.isExpression(n) && this.lenientApp ? this.states.widenedPromise(n) : null;
		if (widened) return this.returnTypeOf(widened);
		const stored = this.storedLiteralType(n);
		if (stored) return stored;
		if (ts.isIdentifier(n) && this.untypedLetReceiver(n)) return 'Any?';
		// What a class extending Array, Set or Map inherits is read as the kit's collection, which its Swift class subclasses.
		const inherited = n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n ? this.inheritedCollection(n as ts.Expression) : null;
		if (inherited) return inherited;
		if (this.isPrototypeRef(n) || this.isPrototypeMember(n) || (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) || this.declaredNullable(n) || this.states.heldNullish(n) || this.states.nullishReadUntyped(n)) return 'Any?';
		// `value.constructor` (library mode) is read as its class, whatever the receiver.
		if (this.library && ts.isPropertyAccessExpression(n) && n.name.text === 'constructor' && !isWriteTarget(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.name.text === 'name')) return 'Any?';
		if (this.untypedThis.has(n) || (ts.isIdentifier(n) && n.text === 'globalThis' && this.isGlobalThis(n)) || this.isAmbientGlobal(n) || this.holdsFunctionObject(n) || this.isAugmentedLibMember(n)) return 'Any?';
		// A function reading the `this` it is called with, as a value: the function object calling it so.
		if (!this.library && ts.isIdentifier(n) && this.thisFunction(n)) return 'Any?';
		if ((this.library && this.holdsMethods(n)) || ((ts.isIdentifier(n) || ts.isVariableDeclaration(n) || ts.isCallExpression(n) || ts.isFunctionExpression(n)) && this.carriesMethod(n))) return 'Any?';
		if (this.library && (ts.isIdentifier(n) || ts.isVariableDeclaration(n))) {
			const own = ts.isVariableDeclaration(n) ? n : ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent : this.resolve(n)?.valueDeclaration;
			const init = own && ts.isVariableDeclaration(own) && !own.type ? own.initializer : undefined;
			if (init && (ts.isArrowFunction(init) || (ts.isFunctionExpression(init) && !isMethodValue(init))) && this.returnsMethod(init)) return returningAny(this.type(this.checker.getTypeAtLocation(init), init));
		}
		if ((ts.isIdentifier(n) || ts.isVariableDeclaration(n)) && this.untypedRecord(n)) return 'JSRecord<Any?>';
		// `x[Symbol.iterator]()` of a collection whose method is a generator: the iterator the runtime adapts, not a generator of its own.
		{
			const own = ts.isVariableDeclaration(n) ? n : ts.isIdentifier(n) ? (ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent : this.resolve(n)?.valueDeclaration) : undefined;
			const init = own && ts.isVariableDeclaration(own) && !own.type ? own.initializer : ts.isCallExpression(n) ? n : undefined;
			if (init && ts.isCallExpression(init) && !init.arguments.length && ts.isElementAccessExpression(init.expression) && isSymbolIterator(init.expression.argumentExpression, this.checker)) {
				const t = this.type(this.checker.getTypeAtLocation(init), init);
				if (isKit(spelledType(t), 'JSGenerator')) return t.replace(/^JSGenerator</, 'JSIterator<');
			}
		}
		if (ts.isIdentifier(n) && this.widenedParameter(n)) return 'Any?';
		if (ts.isIdentifier(n) && this.appModuleOf(n)) return 'Any?';
		const keyed = ts.isIdentifier(n) || ts.isVariableDeclaration(n) ? this.numberKeyedArray(n) : null;
		if (keyed) return `JSRecord<${keyed}>`;
		// A choice between functions is the function type they are written for: each branch takes its slot's signature.
		if (ts.isConditionalExpression(n) && [n.whenTrue, n.whenFalse].some(isFunctionLiteral) && [n.whenTrue, n.whenFalse].every((x) => isFunctionLiteral(x) || !!this.checker.getTypeAtLocation(x).getCallSignatures().length)) {
			const context = this.checker.getContextualType(n);
			const present = context && this.checker.getNonNullableType(context);
			if (present?.getCallSignatures().length) {
				const t = this.type(present, n),
					parts = functionParts(t);
				const empty = [n.whenTrue, n.whenFalse].some((x) => {
					x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
					return (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) && this.states.givesEmptyDefault(x);
				});
				return empty && parts && !isOptional(parts.result) ? `(${parts.params.join(', ')}) throws -> ${optionalType(parts.result)}` : t;
			}
		}
		if ((ts.isPropertyAccessExpression(n) && untypedResultField(this, this.checker.getSymbolAtLocation(n.name))) || untypedResultBinding(this, n)) return 'Any?';
		const t = this.type(this.checker.getTypeAtLocation(n), n);
		if (!isUntyped(spelledType(t)) && isUntyped(spelledType(heldType(t))) && this.heldRead(n)) return 'Any?';
		if (t === 'Void' && ts.isCallExpression(n)) {
			const decl = this.checker.getResolvedSignature(n)?.getDeclaration();
			const impl = decl && !ts.isJSDocSignature(decl) ? implementationOf(decl) : null;
			if (impl) return this.returnTypeOf(impl);
		}
		// `var loaded;` assigned only in a callback: TypeScript reads it as undefined where the code reads it; Swift holds any value.
		if (t === 'Void' && ts.isIdentifier(n) && !isWriteTarget(n)) {
			const d = this.resolve(n)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && !d.type && !d.initializer && this.isAny(d.name)) return 'Any?';
		}
		// A getter declared to give undefined (`get namespace(): string | undefined`) gives the optional its Swift property holds.
		if (ts.isPropertyAccessExpression(n) && !isWriteTarget(n) && ['String', 'Double', 'Bool'].includes(t)) {
			const getter = this.checker.getSymbolAtLocation(n.name)?.declarations?.find(ts.isGetAccessorDeclaration);
			if (getter && this.mayReturnUndefined(getter)) return `${t}?`;
		}
		// An untyped value a guard narrows to a record (`isObject(v): v is Record<string, any>`): any object passes, so it stays untyped.
		if (isKit(spelledType(t), 'JSRecord') && (ts.isIdentifier(n) || ts.isElementAccessExpression(n) || ts.isPropertyAccessExpression(n)) && !(ts.isIdentifier(n) && n.parent && (ts.isParameter(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertySignature(n.parent) || ts.isBindingElement(n.parent)) && n.parent.name === n)) {
			const declared = ts.isElementAccessExpression(n) && /^JSArray<Any\?>[?!]?$/.test(this.typeOf(n.expression)) ? 'Any?' : this.declaredTypeOf(n as ts.Expression);
			if (isUntyped(spelledType(declared))) return 'Any?';
		}
		// An untyped value `instanceof Map` or `Set` narrows: Swift's map or set of any values is not one of other types, so it stays untyped.
		if (/^JS(Map<Any\?, Any\?>|Set<Any\?>)[?!]?$/.test(t) && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && !(ts.isIdentifier(n) && n.parent && (ts.isParameter(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isBindingElement(n.parent)) && n.parent.name === n)) {
			if (isUntyped(spelledType(this.declaredTypeOf(n as ts.Expression)))) return 'Any?';
		}
		if ((t === 'Bool' || t === 'String' || t === 'Double') && (this.holdsUndefined(n) || this.givenNullSignalValue(n) || this.states.lenientNullField(n))) return `${t}?`;
		if (t === 'JSArray<String>' && this.unsetGroups(n)) return 'JSArray<String?>';
		if (this.looseObjectDeclaration(n, t) || (isFunctionType(t) && (this.lenientAppOptional(n) || this.widenedFunctionField(n)))) return optionalType(t);
		// An element of an array literal typed `never[]` (`callbacks = []` under strict checks), which Swift holds as any value.
		if (t === 'Never' && (ts.isIdentifier(n) || ts.isVariableDeclaration(n)) && this.resolve(n)?.valueDeclaration && ts.isVariableDeclaration(this.resolve(n)!.valueDeclaration!)) return 'Any?';
		return this.holdingNull(t, n);
	},

	/**
	 * `(map[k] = [])` as a value: the array or object stored, as its target holds it. Typed as the literal (`never[]`),
	 * the value would be converted, and a conversion copies.
	 */
	storedLiteralType(this: Translator, n: ts.Node): string | null {
		while (ts.isParenthesizedExpression(n)) n = n.expression;
		if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken || statementLevel(n) || !(ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))) return null;
		let bare: ts.Expression = n.right;
		while (ts.isParenthesizedExpression(bare) || ts.isAsExpression(bare)) bare = bare.expression;
		if (!ts.isArrayLiteralExpression(bare) && !ts.isObjectLiteralExpression(bare)) return null;
		const container = ts.isElementAccessExpression(n.left) ? /^JS(?:Array|Record)<(.*)>[?!]?$/.exec(this.typeOf(n.left.expression))?.[1] : undefined;
		if (ts.isElementAccessExpression(n.left) && !container) return null;
		if (isUntyped(spelledType(container))) return 'Any?';
		const held = (container ?? this.declaredTypeOf(n.left) ?? this.typeOf(n.left)).replace(/[?!]$/, '');
		return /^(JSArray|JSRecord)<.*>$/.test(held) || /^Object_\w+$/.test(held) ? held : null;
	},
};
