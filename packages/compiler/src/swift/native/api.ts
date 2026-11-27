import ts from 'typescript';
import { DEPLOYMENT, RENAMED, inStaticMember, optional, tableDeclares } from './bridging.ts';
import { categoryModule, conformsToSwift, isSubframework, lookupClass, lookupEnum, lookupMember, lookupStruct, lookupTypealias, moduleOfDeclaration, nativeTable, unavailableReason, type NativeMethod, type NativeProperty, type SwiftType } from './sdk.ts';
import type { Translator } from '../translator.ts';
import { isStatic } from '../../semantics/throws.ts';
import { nativeCallsMethods } from './calls.ts';
import { nativeConversionsMethods } from './conversions.ts';
import { nativeSubclassesMethods } from './subclasses.ts';
import { nativeMembersMethods } from './members.ts';

/**
 * Direct calls to iOS APIs, as NativeScript apps write them in TypeScript
 * (`UIImage.systemImageNamed('star')`, `view.layer.cornerRadius = 8`), in
 * their Swift spelling from the module's symbol table (swift/native/sdk.ts):
 * selectors become Swift names and labels, factories become initializers,
 * enum members become cases, and numbers convert to the CGFloat, Int or
 * enum the Swift API takes.
 */
export class NativeAPI {
	readonly t: Translator;

	constructor(t: Translator) {
		this.t = t;
		this.internalTypes = t.config.kitNative?.internalTypes ?? new Set();
		this.counterpartModules = t.config.kitNative?.counterpartModules ?? new Set();
	}

	/** The module a native declaration comes from ('UIKit'), or null for anything else. */
	module(decl: ts.Declaration | undefined): string | null {
		if (!decl) return null;
		const known = moduleOfDeclaration(decl.getSourceFile().fileName);
		if (known) return /[\\/]objc![^\\/]*\.d\.ts$/.test(decl.getSourceFile().fileName) || tableDeclares(known, decl) ? known : null;
		// An app's own declaration of an SDK type newer than the published typings (`declare class UIArrangementViewController`
		// in a .d.ts of its own): the SDK module whose table has a type of that name (only when the Apple SDK is present).
		if (process.platform !== 'darwin') return null;
		const file = decl.getSourceFile();
		if (!file.isDeclarationFile || /[\\/]node_modules[\\/]/.test(file.fileName)) return null;
		const named = (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isEnumDeclaration(decl)) && decl.name ? decl.name.text : null;
		if (!named) return null;
		for (const m of new Set(['UIKit', 'Foundation', ...this.modules])) {
			if (lookupClass(m, named) || lookupEnum(m, named)) return m;
		}
		return null;
	}

	symbolModule(sym: ts.Symbol | undefined): { module: string; name: string } | null {
		const decl = sym?.declarations?.[0];
		const module = this.module(decl);
		if (module) this.uses(module);
		return module && sym ? { module, name: RENAMED[sym.name] ?? sym.name } : null;
	}

	uses(module: string) {
		this.modules.add(module);
		this.used.add(module);
	}

	/** Why a name of `module` has no Swift spelling: Swift leaves it out, the module has none, or the build has no such module at all (a pod no Podfile names). */
	noCounterpart(module: string, name?: string): string {
		const unavailable = name && unavailableReason(module, name);
		if (unavailable) return `${unavailable}, in ${module}`;
		const t = nativeTable(module);
		const empty = ![t.classes, t.enums, t.functions, t.constants, t.structs].some((x) => Object.keys(x).length);
		return empty ? `${module} is a module of neither the SDK nor the Swift packages and pods the app and its plugins build` : `no Swift counterpart in ${module}`;
	}

	/** A member found in a table: the module of a category adding it is used too. */
	found<T extends NativeMethod | NativeProperty | null>(m: T): T {
		const category = m && categoryModule(m);
		if (category) this.uses(category);
		return m;
	}

	/** Modules the program's native declarations come from: where enum types are looked up by their Swift name. */
	modules = new Set<string>();

	/** The modules used since this was last cleared: those a file of the translation imports. */
	readonly used = new Set<string>();

	/** The SDK frameworks among them, as Swift imports them. */
	sdkModules(): string[] {
		return [...this.modules].filter((m) => /^[A-Z]\w*$/.test(m) && !m.startsWith('NSPlugin_') && !isSubframework(m)).sort();
	}

	/** Whether a type is an Objective-C class (not a protocol, struct or enum) of the native declarations. */
	isClassType(t: ts.Type): boolean {
		const native = this.symbolModule(t.getSymbol());
		const cls = native && lookupClass(native.module, native.name);
		return !!cls && cls.kind === 'class';
	}

	/** The Swift type for a native TypeScript type (a class, protocol, struct or enum), or null. */
	type(t: ts.Type): string | null {
		const sym = t.aliasSymbol ?? t.getSymbol();
		// A member's own type (`UIHingeStatus.Closed`): its enum's, found through the declaration where the symbol has no parent (a `declare const enum` of the app's).
		const enumDecl = sym && sym.flags & ts.SymbolFlags.EnumMember && sym.valueDeclaration && ts.isEnumDeclaration(sym.valueDeclaration.parent) ? sym.valueDeclaration.parent : null;
		const enumOfLiteral = sym && sym.flags & ts.SymbolFlags.EnumMember ? this.symbolModule((sym as any).parent ?? (enumDecl && this.t.checker.getSymbolAtLocation(enumDecl.name))) : null;
		const native = enumOfLiteral ?? this.symbolModule(sym);
		if (!native) return null;
		const en = enumOfLiteral ? lookupEnum(enumOfLiteral.module, enumOfLiteral.name) : t.flags & ts.TypeFlags.EnumLike || sym!.flags & ts.SymbolFlags.Enum ? lookupEnum(native.module, native.name) : undefined;
		if (en !== undefined) {
			this.typeAvailable(en);
			return en?.swift ?? null;
		}
		// Mutable ones stay classes: script mutates them in place.
		if (native.name === 'NSArray') return '[Any]';
		if (native.name === 'NSDictionary') return '[AnyHashable: Any]';
		const cls = lookupClass(native.module, native.name);
		if (cls) return cls.kind === 'protocol' ? `any ${this.className(cls)}` : this.className(cls);
		const struct = lookupStruct(native.module, native.name);
		if (struct) return struct.swift;
		return null;
	}

	/** A native type newer than the deployment target, named in a function: the function's body runs only where the OS has it. */
	typeAvailable(t: { introduced?: string; swift?: string } | null | undefined) {
		if (t?.introduced && parseFloat(t.introduced) > DEPLOYMENT) this.t.requireTypeAvailability(parseFloat(t.introduced), t.swift);
	}

	/**
	 * A native class's Swift name, qualified by its module where the kit declares a type of that name (`Foundation.Progress`).
	 * A program type of a native module's name takes another (`nativeClash`), so the native one is spelled bare.
	 */
	className(cls: { swift: string; module?: string; introduced?: string; generics?: string[] }): string {
		this.typeAvailable(cls);
		const name = cls.module && !this.counterpartModules.has(cls.module) && (this.t.isKitType(cls.swift) || this.internalTypes.has(cls.swift)) ? `${cls.module}.${cls.swift}` : cls.swift;
		return cls.generics?.length ? `${name}<${cls.generics.map(() => 'AnyObject').join(', ')}>` : name;
	}

	/** The kit's internal types, which shadow native types of their names in code compiled into the kit. */
	readonly internalTypes: ReadonlySet<string>;
	/** Modules the kit does not import: their classes the code calls are the kit's internal types of their names. */
	readonly counterpartModules: ReadonlySet<string>;

	/** The kit's types among `names` that a module the app's code imports also declares: the app's module names them as the kit's. */
	kitClashes(names: Iterable<string>): string[] {
		const declared = new Set<string>();
		for (const m of new Set(['Foundation', 'UIKit', ...this.searchModules()])) {
			const t = nativeTable(m);
			for (const x of [...Object.values(t.classes), ...Object.values(t.structs), ...Object.values(t.enums)]) if (x.swift) declared.add(x.swift);
			for (const x of Object.keys(t.typealiases ?? {})) declared.add(x);
		}
		return [...names].filter((n) => declared.has(n));
	}

	/** The class or struct a native-typed expression is: its module and JS name. */
	receiver(e: ts.Expression): { module: string; name: string; isStatic: boolean } | null {
		const c = this.t.checker;
		const sym = this.t.resolve(e);
		// `super` resolves to the base class, and is it only in a static member.
		if (sym && sym.flags & ts.SymbolFlags.Class && (e.kind !== ts.SyntaxKind.SuperKeyword || inStaticMember(e))) {
			const native = this.symbolModule(sym);
			if (native) return { ...native, isStatic: true };
		}
		// Typings declaring a native class's class methods as a namespace's functions (`declare namespace UIDrawingText { function measureText…(…) }`).
		if (sym && sym.flags & ts.SymbolFlags.ValueModule && !(sym.flags & ts.SymbolFlags.Class)) {
			const native = this.symbolModule(sym);
			if (native && lookupClass(native.module, native.name)) return { ...native, isStatic: true };
		}
		// `this` in an app class extending a native one is the class.
		let type = c.getApparentType(c.getNonNullableType(c.getTypeAtLocation(e)));
		// A class narrowed by instanceof to another it does not extend (`UISearchBar & UIControl`): the first native one.
		if (type.isIntersection()) type = type.types.find((u) => this.symbolModule(u.getSymbol()) || this.nativeBase(u)) ?? type;
		const native = this.symbolModule(type.getSymbol()) ?? this.nativeBase(type);
		return native ? { ...native, isStatic: false } : null;
	}

	/** Whether a program class extends a native class, directly or through others. */
	classExtendsNative(cls: ts.ClassLikeDeclaration): boolean {
		const sym = cls.name && this.t.checker.getSymbolAtLocation(cls.name);
		return !!sym && !!this.nativeBase(this.t.checker.getDeclaredTypeOfSymbol(sym));
	}

	/** Whether a type is an app class extending a native one. */
	extendsNative(type: ts.Type): boolean {
		const c = this.t.checker;
		if (typeof type.isTypeParameter !== 'function') return false;
		return !!this.nativeBase(type.isTypeParameter() ? (c.getBaseConstraintOfType(type) ?? type) : c.getApparentType(type));
	}

	/** The nearest native class an app class extends (`class Sparkline extends UIView`). */
	nativeBase(of: ts.Type): { module: string; name: string } | null {
		// A class's own `this` is a reference to the class.
		const type = (of as ts.TypeReference).target ?? of;
		if (typeof type.isClassOrInterface !== 'function' || !type.isClassOrInterface()) return null;
		for (const b of this.t.checker.getBaseTypes(type)) {
			const found = this.symbolModule(b.getSymbol()) ?? this.nativeBase(b);
			if (found) return found;
		}
		return null;
	}

	/**
	 * Whether a value of a type conforms to a protocol (`any URLSessionDelegate`) as Swift declares it: its native
	 * class does, or its program class names the protocol (`ObjCProtocols`, `implements`), or extends a class that does.
	 */
	declaredConformance(of: ts.Type, protocol: string): boolean {
		const want = protocol.replace(/^any /, '');
		const decl = of.getSymbol()?.valueDeclaration;
		if (decl && ts.isClassLike(decl) && !decl.getSourceFile().isDeclarationFile) {
			const named: ts.Expression[] = [...(decl.heritageClauses ?? []).filter((h) => h.token === ts.SyntaxKind.ImplementsKeyword).flatMap((h) => h.types.map((x) => x.expression))];
			for (const m of decl.members) {
				if (isStatic(m) && ts.isPropertyDeclaration(m) && m.name.getText() === 'ObjCProtocols' && m.initializer && ts.isArrayLiteralExpression(m.initializer)) named.push(...m.initializer.elements);
			}
			for (const x of named) {
				const p = this.symbolModule(this.t.checker.getSymbolAtLocation(x));
				if (p && conformsToSwift(p.module, p.name, want)) return true;
			}
			const base = this.t.checker.getBaseTypes(of as ts.InterfaceType)[0];
			return !!base && this.declaredConformance(base, protocol);
		}
		const n = this.symbolModule(of.getSymbol());
		return !!n && conformsToSwift(n.module, n.name, want);
	}

	/** A program value where Swift takes a protocol: as it is where its class declares the conformance, else cast as Objective-C asks the object. */
	asProtocol(e: ts.Expression, source: string, target: SwiftType, b: string, otherwise: string): string {
		const t = this.t;
		const type = t.checker.getNonNullableType(t.checker.getTypeAtLocation(e));
		if (!this.declaredConformance(type, b)) return otherwise;
		return optional(target) || !source.endsWith('?') ? t.expr(e) : this.t.marks.unwrappedCode(t.expr(e));
	}

	/** An API newer than the deployment target: the function using it runs it only where the OS has it. */
	checkAvailable(m: { introduced?: string; selector?: string }, _e: ts.Node, _what: string) {
		if (m.introduced && parseFloat(m.introduced) > DEPLOYMENT) this.t.requireAvailability(parseFloat(m.introduced));
	}

	/** A Swift typealias the SDK declares (`UIActivityViewController.CompletionWithItemsHandler`), as the type it names. */
	unalias(type: SwiftType): SwiftType {
		const optionalType = /[?!]$/.test(type);
		const name = type.replace(/[?!]$/, '');
		// Darwin's last: its C typedefs (`OSStatus`, `OSErr` of MacTypes) are what SDK functions return, and no framework's table has them.
		for (const m of [...this.modules, 'Darwin']) {
			const found = lookupTypealias(m, name);
			if (found) return optionalType ? `(${found})?` : found;
		}
		return type;
	}

	/** The iOS version a native class was introduced in, when newer than the deployment target. */
	introducedAfterDeployment(e: ts.Expression): number | null {
		const r = this.receiver(e);
		const cls = r?.isStatic ? lookupClass(r.module, r.name) : null;
		const v = cls && (cls as { introduced?: string }).introduced ? parseFloat((cls as { introduced?: string }).introduced!) : null;
		return v && v > DEPLOYMENT ? v : null;
	}

	/** `x.prop` of a native property newer than the deployment target (`preferredInspectorColumnWidthFraction`): its iOS version. */
	propertyIntroducedAfterDeployment(e: ts.Expression): number | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!ts.isPropertyAccessExpression(e)) return null;
		const r = this.receiver(e.expression);
		if (!r) return null;
		const m = this.found(lookupMember(r.module, r.name, e.name.text, r.isStatic));
		const v = m && m.kind === 'property' && m.introduced ? parseFloat(m.introduced) : null;
		return v && v > DEPLOYMENT ? v : null;
	}

	/** Native calls whose optional Swift result an optional chain reads. */
	keepOptional = new Set<ts.Node>();

	/** Exposed method name → its parameter count, from every `static ObjCExposedMethods` in the program. */
	exposed: Map<string, number> | null = null;

	enumTypes = new Map<string, { raw: string; options: boolean } | null>();
}
type Mixins = typeof nativeCallsMethods & typeof nativeMembersMethods & typeof nativeConversionsMethods & typeof nativeSubclassesMethods;
export interface NativeAPI extends Mixins {}
for (const methods of [nativeCallsMethods, nativeMembersMethods, nativeConversionsMethods, nativeSubclassesMethods]) Object.defineProperties(NativeAPI.prototype, Object.getOwnPropertyDescriptors(methods));

export type { NativeMethod, NativeProperty };
