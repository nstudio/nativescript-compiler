import ts from 'typescript';
import { heldLoss } from '../semantics/losses.ts';
import { KIT_APPLE_SOURCES } from '../driver/paths.ts';
import { KIT_GLOBALS, KitTypes, coreClass, kitExtends, kitIndex, kitMember, type KitMember } from '../kit/kit-index.ts';
import { NATIVE_MEMBERS, SCRIPT_OBJECTS, addedDeclarations, augmentedProperty, coreBarrels, coreSymbolName, isCoreDeclaration, ownPropertyOnly, packageOf, unappliedProperty } from '../program/core-facts.ts';
import { optionalType, splitTopLevel, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';
import { isMixinOwnMember } from '../semantics/classes.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const KIT = KIT_APPLE_SOURCES;

/**
 * @nativescript/core's API as NativeScriptKit offers it. A core class is the
 * kit class of the same name; a member the kit declares is used as it is
 * (numbers converted to Double), a view property the kit applies by name
 * (`text`, `color`) is set and read through `set`/`get`, and anything else
 * stops the build with the file and line.
 */
export class CoreAPI extends KitTypes {
	private directoryMembers = new Map<string, string | null>();
	private t: Translator;

	constructor(t: Translator) {
		super(kitIndex(KIT, t.config.adapter.kit.apple, t.kitExclude));
		this.t = t;
	}

	/** Whether NativeScriptKit declares a type of this name itself, not only extends one. */
	declares(name: string): boolean {
		return !!this.index.get(name)?.declared;
	}

	typeNames(): string[] {
		return [...this.index.values()].filter((t) => t.declared && !t.name.includes('.')).map((t) => t.name);
	}

	/** Whether NativeScriptKit has a top-level function or variable of this name (core's index exports it). */
	exportsTopLevel(name: string): boolean {
		return !!this.coreGlobal(name);
	}

	/** A top-level function or variable the kit generated from core's index exports (`getRootLayout`, `widthProperty`). */
	private coreGlobal(name: string, kind?: 'func' | 'var'): KitMember | null {
		return (
			this.index
				.get(KIT_GLOBALS)
				?.members.get(name)
				?.find((m) => m.exported && (!kind || m.kind === kind)) ?? null
		);
	}

	/** The kit's class of a core class name: the iOS file's where the kit names it apart (`Font__font_ios`), else the class of that name. */
	platformClass(name: string): string {
		const ios = `${name}__${name.replace(/[A-Z]/g, (c, k) => (k ? '_' : '') + c.toLowerCase())}_ios`;
		if (this.index.has(ios)) return ios;
		return coreClass(this.index, name);
	}

	/** The kit type of a core class, if the kit has one. */
	kitTypeName(name: string): string | null {
		const k = this.platformClass(name);
		return this.index.has(k) ? k : null;
	}

	/** `recv.method(…args)` of a kit method named apart from the call (`Observable.prototype.on.call(this, …)`), arguments as its parameters take them. */
	nonVirtualCall(e: ts.CallExpression, recv: string, owner: string, method: string, args: readonly ts.Expression[]): string {
		const m = kitMember(this.index, owner, method)!;
		const params = (m.params ?? '').trim() ? splitParams(m.params!) : [];
		const given = args.map((a, k) => this.t.coerce(a, params[k] ? kitParamType(params[k]).replace(/^@escaping /, '') : 'Any?'));
		while (given.length < params.length && !params[given.length].includes('=') && /[?!]\s*$/.test(params[given.length])) given.push('nil');
		return this.fromKit(`${recv}.${method}(${given.join(', ')})`, m.type, this.t.typeOf(e));
	}

	/** Whether a kit class's initializer taking no arguments throws. */
	initThrows(name: string): boolean {
		for (let t = this.index.get(name); t; t = t.base ? this.index.get(t.base) : undefined) {
			const plain = (t.members.get('init') ?? []).find((m) => !(m.params ?? '').trim());
			if (plain) return !!plain.throws;
		}
		return false;
	}

	/** Whether a kit type extends another (`View` extends `ViewBase`). */
	extendsKit(sub: string, base: string): boolean {
		return sub !== base && kitExtends(this.index, sub, base);
	}

	/** The kit type a core-typed expression is, and whether it is the type itself (`Device.model`, `Color.isValid`). */
	owner(e: ts.Expression): { name: string; isStatic: boolean } | null {
		const c = this.t.checker;
		// A namespace inside a core namespace (`Utils.layout`): the kit's nested type of that path.
		if (ts.isPropertyAccessExpression(e)) {
			const sym = this.t.resolve(e);
			if (sym && isCoreDeclaration(sym.declarations?.[0])) {
				const outer = this.owner(e.expression);
				const name = outer?.isStatic ? `${outer.name}.${e.name.text}` : null;
				if (name && this.index.has(name)) return { name, isStatic: true };
				// A class a core namespace exports (`Utils.Source`): the class itself, under the kit's name for it.
				const target = sym.flags & ts.SymbolFlags.Alias ? c.getAliasedSymbol(sym) : sym;
				if (outer?.isStatic && target.flags & ts.SymbolFlags.Class && this.index.has(this.platformClass(target.name))) return { name: this.platformClass(target.name), isStatic: true };
			}
		}
		if (ts.isIdentifier(e)) {
			const module = this.moduleOwner(e);
			if (module) return { name: module, isStatic: true };
			const sym = this.t.resolve(e);
			// `globalThis`: the program's global object, which core's global-types.d.ts augments with a namespace declaration.
			if (sym?.name === 'globalThis' && sym.flags & ts.SymbolFlags.ValueModule) return null;
			const decl = sym?.declarations?.[0];
			if (sym && isCoreDeclaration(decl) && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.ValueModule | ts.SymbolFlags.Variable) && !this.t.compiledCounterpart(sym)) {
				if (sym.flags & ts.SymbolFlags.ValueModule) return { name: e.text, isStatic: true };
				if (sym.flags & ts.SymbolFlags.Class) return { name: this.platformClass(sym.name), isStatic: true };
				// A constant core exports (`Device`): the kit has a type of that name with static members.
				if (this.index.has(sym.name)) return { name: sym.name, isStatic: true };
				const held = this.heldObject(e);
				if (held) return { name: held, isStatic: false };
			}
			if (sym && sym.flags & ts.SymbolFlags.Alias) return null;
		}
		// Library mode: core's own interfaces (`ModuleContext`, `NavigationTransition`) are shapes the generated code reads, not kit types.
		if (this.t.library) {
			const decl = c.getNonNullableType(c.getTypeAtLocation(e)).getSymbol()?.declarations?.[0];
			if (decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl)) && isCoreDeclaration(decl)) return null;
		}
		let type = c.getNonNullableType(c.getTypeAtLocation(e));
		// `View & { extra?: … }`: the core class.
		if (type.isIntersection()) type = type.types.find((u) => (u.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class && isCoreDeclaration(u.getSymbol()?.declarations?.[0])) ?? type;
		const sym = type.getSymbol();
		// `global`, typed as `typeof globalThis`: the program's global object, which core's typings only augment.
		if (sym?.name === 'globalThis' && sym.flags & ts.SymbolFlags.ValueModule) return null;
		const mixin = this.t.mixinOf(sym);
		if (mixin) return { name: mixin, isStatic: false };
		// An interface extending a core class (`interface MenuView extends View`): that class.
		if (sym && sym.flags & ts.SymbolFlags.Interface && !isCoreDeclaration(sym.declarations?.[0]) && type.isClassOrInterface()) {
			const base = c
				.getBaseTypes(type as ts.InterfaceType)
				.map((b) => b.getSymbol())
				.find((b) => b && b.flags & ts.SymbolFlags.Class && isCoreDeclaration(b.declarations?.[0]));
			if (base) return { name: this.platformClass(base.name), isStatic: false };
		}
		if (!sym || !isCoreDeclaration(sym.declarations?.[0]) || this.t.compiledCounterpart(sym)) return null;
		// Core's event data types are the kit's one EventData, whose members the translator reads directly.
		if (this.t.type(type, e) === 'EventData') return null;
		const name = sym.flags & ts.SymbolFlags.Class ? this.platformClass(coreSymbolName(sym)) : coreSymbolName(sym);
		// An interface core's typings declare (`Screen.mainScreen: ScreenMetrics`) where the kit's member holds its class (`MainScreen`).
		// Or a shape (`Utils.ios: { collections: {…} }`) where the kit's member holds an object of its class, or a type itself (`collections.Type`).
		if (!this.index.has(name) && sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeLiteral) && ts.isPropertyAccessExpression(e)) {
			const outer = this.owner(e.expression);
			const held =
				outer &&
				kitMember(this.index, outer.name, e.name.text)
					?.type.replace(/[?!]$/, '')
					.replace(/^NativeScriptKit\./, '');
			if (held && this.index.has(held)) return { name: held, isStatic: false };
			const meta = held && /^([\w.]+)\.Type$/.exec(held)?.[1];
			if (meta && this.index.has(meta)) return { name: meta, isStatic: true };
		}
		// A shape core's typings declare (`{ unit: 'dip'; value: number }`) that the kit has no type for: read as any object is.
		if (!this.index.has(name) && (sym.flags & ts.SymbolFlags.TypeLiteral || sym.flags & ts.SymbolFlags.Interface)) return null;
		return { name, isStatic: false };
	}

	/**
	 * The kit class of the object a constant core exports holds (`Dialogs = { alert, confirm, … }`, `Device`), the type of
	 * the kit's global of that name. Only where the class has every member the typings declare: one it lacks is
	 * the object's own, read by name.
	 */
	private heldObject(e: ts.Expression): string | null {
		if (!ts.isIdentifier(e)) return null;
		const sym = this.t.resolve(e);
		if (!sym || !(sym.flags & ts.SymbolFlags.Variable) || !isCoreDeclaration(sym.declarations?.[0]) || this.t.compiledCounterpart(sym)) return null;
		const held = this.coreGlobal(sym.name, 'var')?.type.trim().replace(/[?!]$/, '');
		return held &&
			this.index.has(held) &&
			this.t.checker
				.getTypeAtLocation(e)
				.getProperties()
				.every((p) => kitMember(this.index, held, p.name))
			? held
			: null;
	}

	/**
	 * A function such an object holds, other than called (`Dialogs.alert` as a value, assigned, or `?.()`): the kit's
	 * closure type is the function core implements, not the typings' overloads, so it is read and written by name.
	 */
	private heldFunction(target: ts.Expression, name: string): boolean {
		const held = this.heldObject(target);
		const m = held ? kitMember(this.index, held, name) : null;
		return m?.kind === 'var' && !!this.t.functionTypeParts(m.type.trim().replace(/^\((.*)\)[?!]$/, '$1'));
	}

	/**
	 * A function of a core module that core's index does not export (`resolveModuleName`, imported from
	 * `@nativescript/core/module-name-resolver`): the kit's module enum it was compiled into, which has no top-level forwarder for it.
	 */
	moduleFunction(decl: ts.Declaration): string | null {
		// Or a module's variable (`_rootModalViews` of view-common).
		const variable = ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && ts.isSourceFile(decl.parent.parent.parent);
		if (!(ts.isFunctionDeclaration(decl) || variable) || !(decl as ts.NamedDeclaration).name || !isCoreDeclaration(decl)) return null;
		const name = ((decl as ts.NamedDeclaration).name as ts.Identifier).text;
		if (this.coreGlobal(name)) return null;
		const file = decl.getSourceFile().fileName;
		const root = /^(.*[\\/]@nativescript[\\/]core)[\\/]/.exec(file)?.[1] ?? (packageOf(file)?.name === '@nativescript/core' ? packageOf(file)!.root : undefined);
		if (!root) return null;
		const rel = file
			.slice(root.length + 1)
			.replace(/\\/g, '/')
			.replace(/(\.(ios|android))?\.d\.ts$|(\.(ios|android))?\.ts$/, '');
		const kind = variable ? 'var' : 'func';
		const owner = `Core_${rel.replace(/[^A-Za-z0-9]+/g, '_')}`;
		if (kitMember(this.index, owner, name)?.kind === kind) return `${owner}.${name}`;
		// A directory's typings (`ui/core/view/index.d.ts`) declaring what one of its modules defines (view-common's `isEnabledProperty`).
		// Owner names flatten `/` and `-` alike, so a sibling directory (`view-base`) shares the prefix: only a single owner is taken.
		if (rel.endsWith('/index')) {
			const prefix = owner.slice(0, -'index'.length);
			const key = `${prefix} ${kind} ${name}`;
			if (!this.directoryMembers.has(key)) {
				const found = [...this.index.keys()].filter((k) => k.startsWith(prefix) && kitMember(this.index, k, name)?.kind === kind);
				this.directoryMembers.set(key, found.length === 1 ? `${found[0]}.${name}` : null);
			}
			const member = this.directoryMembers.get(key);
			if (member) return member;
		}
		// A module core's index exports as a namespace (`export * as Http from './http'`): the kit's type of that name.
		const barrel = rel.endsWith('/index') || !rel.includes('/') ? coreBarrels(root).get(rel.split('/')[0]) : undefined;
		return barrel && kitMember(this.index, barrel, name)?.kind === kind ? `${barrel}.${name}` : null;
	}

	/**
	 * A core module or namespace imported under any name (`import * as utils from
	 * '../utils'`, `import { ios as iosUtils } from './native-helper'`): the kit
	 * type of its public path, `Utils` or `Utils.ios`, as core's index exports it.
	 */
	private moduleOwner(e: ts.Identifier): string | null {
		const local = this.t.checker.getSymbolAtLocation(e);
		const target = local && local.flags & ts.SymbolFlags.Alias ? this.t.checker.getAliasedSymbol(local) : local;
		const decl = target?.valueDeclaration ?? target?.declarations?.[0];
		// A module or namespace, or a module's constant object of functions (`export const ios = { … }`).
		const constant = !!target && !!(target.flags & ts.SymbolFlags.Variable) && !!decl && ts.isVariableDeclaration(decl) && ts.isSourceFile(decl.parent.parent.parent);
		if (!target || !(target.flags & ts.SymbolFlags.ValueModule || constant) || !decl || !isCoreDeclaration(decl)) return null;
		const file = decl.getSourceFile().fileName;
		const root = /^(.*[\\/]@nativescript[\\/]core)[\\/]/.exec(file)?.[1] ?? (packageOf(file)?.name === '@nativescript/core' ? packageOf(file)!.root : undefined);
		const barrel = root ? coreBarrels(root).get(file.slice(root.length + 1).split(/[\\/]/)[0]) : undefined;
		const candidates = ts.isSourceFile(decl) ? [barrel] : [barrel && `${barrel}.${target.name}`, constant ? undefined : target.name];
		return candidates.find((c): c is string => !!c && this.index.has(c)) ?? null;
	}

	/** A member the kit's class lacks that the program's own declarations give a core type (`addedDeclarations`). */
	private addedMember(owner: string, e: ts.PropertyAccessExpression): boolean {
		if (kitMember(this.index, owner, e.name.text)) return false;
		return addedDeclarations(this.t.resolve(e.name)?.declarations ?? []);
	}

	/**
	 * A kit object's code as a receiver: a weak reference's target (`weakRef.get()`, typed present), or what a call Swift has
	 * as optional gives (`getColor().hex` of a helper returning null), is a TypeError's where it is gone.
	 */
	private receiver(e: ts.Expression, key?: string): string {
		const checked = key !== undefined ? this.t.presentTypedReceiver(e) : null;
		if (checked) return checked;
		const code = this.t.expr(e);
		// A value the kit holds optional that the read leaves so: JavaScript's TypeError for the member read of it where it is missing.
		const raw = this.t.marks.unwrapInner(code) ?? code,
			held = this.t.marks.markOf(raw);
		if (key !== undefined && this.optionalKitValue(e) && !(held?.op === 'helper' && held.name === 'jsUnwrap')) {
			return this.t.chainingLoose ? `${raw}?` : `${RT.jsUnwrap}(${raw}, ${JSON.stringify(key)})`;
		}
		const weak = ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['get', 'deref'].includes(e.expression.name.text) && isKit(spelledType(this.t.typeOf(e.expression.expression).replace(/[?!]$/, '')), 'JSWeakRef');
		return (weak && !this.t.typeOf(e).endsWith('?')) || this.t.givesUndefined(e) ? this.t.marks.unwrappedCode(code) : code;
	}

	/** The kit's method a call of `count` unlabeled arguments reaches, among overloads of its name (core's `bind(options)` beside the kit's own `bind(items:)`). */
	private callMember(owner: string, name: string, count: number): KitMember | null {
		const all: KitMember[] = [];
		for (let t = this.index.get(owner); t; t = t.base ? this.index.get(t.base) : undefined) all.push(...(t.members.get(name) ?? []));
		const fits = (m: KitMember) => {
			const params = (m.params ?? '').trim() ? splitParams(m.params!) : [];
			return params.every((p) => /^_\s/.test(p.trim())) && params.filter((p) => !/=/.test(p)).length <= count && (count <= params.length || params.some((p) => /JSArray|JSRest/.test(p)));
		};
		return all.find((m) => m.kind !== 'func' || fits(m)) ?? all[0] ?? null;
	}

	/**
	 * A property core's typings declare on a class whose implementation leaves it to each object (Transition's `name`,
	 * `presented`): the kit has no member for it, and the object's own property holds it, as script's does.
	 */
	ownPropertyOnly(owner: string, name: ts.MemberName): boolean {
		return ownPropertyOnly(this.index, owner, name, this.t.resolve(name));
	}

	private member(owner: string, name: string, e: ts.Node): KitMember {
		const m = kitMember(this.index, owner, name);
		if (!m) throw this.t.error(e, `${owner}.${name} (NativeScriptKit has no such member)`);
		return m;
	}

	/** Whether the kit applies `name` by name on this view class (a property in its setProperty). */
	private isViewProperty(owner: string, name: string): boolean {
		// A style property applies to any view; the kit's classes each apply their own.
		if (owner === 'Style') return [...this.index.values()].some((t) => kitExtends(this.index, t.name, 'View') && t.props.has(name));
		for (let t = this.index.get(owner); t; t = t.base ? this.index.get(t.base) : undefined) if (t.props.has(name)) return true;
		return false;
	}

	/** `object.name` of an `augmentedProperty` on a core-typed object, outside a chain: the read of its own property (`Any?`), or null. */
	augmentedRead(e: ts.PropertyAccessExpression): string | null {
		if (ts.isOptionalChain(e) || this.constant(e) !== null || this.mixinOwn(e.name)) return null;
		const owner = this.owner(e.expression) ?? this.inheritedOwner(e.expression, e.name);
		if (!owner || owner.isStatic || (this.isView(owner.name) && this.isViewProperty(owner.name, e.name.text))) return null;
		if (!augmentedProperty(this.index, owner.name, e.name, this.t.resolve(e.name))) return null;
		return `${this.receiver(e.expression, e.name.text)}[jsKey: ${JSON.stringify(e.name.text)}]`;
	}

	/** A read of `target.name` where target is core-typed, or null when it is not. */
	property(e: ts.PropertyAccessExpression): string | null {
		const constant = this.constant(e);
		if (constant !== null) return constant;
		if (this.heldFunction(e.expression, e.name.text)) return null;
		const owner = this.mixinOwn(e.name) ? null : (this.owner(e.expression) ?? this.inheritedOwner(e.expression, e.name));
		if (!owner) return null;
		const t = this.t;
		const name = e.name.text;
		// `a?.b`: Swift chains only on an optional, and lenient code types none; as optional, valid for an implicitly unwrapped one too.
		const tt = t.typeOf(e.expression);
		const chained = !owner.isStatic && !!e.questionDotToken;
		const recv = owner.isStatic ? owner.name : chained ? (tt.endsWith('?') ? `${t.expr(e.expression)}?` : `(${t.expr(e.expression)} as ${tt.replace(/!$/, '')}?)?`) : this.receiver(e.expression, name);
		// Swift's chain, as script's, goes on to what follows (`a?.b.c`), reading the optional.
		const continued = ts.isOptionalChain(e.parent) && (e.parent as ts.PropertyAccessExpression).expression === e;
		const inChain = chained || (ts.isOptionalChain(e) && !owner.isStatic);
		// A kit without the member (`ios` is a Page's controller where the kit has it from core).
		if (!owner.isStatic && NATIVE_MEMBERS.has(name) && this.isView(owner.name) && !kitMember(this.index, owner.name, name)) return `${recv}.nativeView`;
		if (!owner.isStatic && this.isView(owner.name) && !kitMember(this.index, owner.name, name)) {
			if (!this.isViewProperty(owner.name, name)) {
				const sym = t.resolve(e.name);
				const extra = !sym || sym.declarations?.every((d) => !isCoreDeclaration(d));
				if (!extra && !augmentedProperty(this.index, owner.name, e.name, sym)) unappliedProperty(t, e.name, `${owner.name}.${name}`, 'NativeScriptKit');
				else if (inChain) throw t.error(e, `${owner.name}.${name} in an optional chain`);
				else return t.fromAnyCode(`${recv}[jsKey: ${JSON.stringify(name)}]`, t.typeOf(e), true);
			}
			return t.fromAnyCode(`${recv}.get(${JSON.stringify(name)})`, t.typeOf(e), true);
		}
		// A namespace of core's held as a value (`knownFolders.ios[name]()`): an object of its functions that take nothing, as script reads it.
		if (owner.isStatic && !kitMember(this.index, owner.name, name) && this.index.has(`${owner.name}.${name}`)) {
			const ns = `${owner.name}.${name}`;
			const fns = [...(this.index.get(ns)?.members ?? [])].filter(([, ms]) => ms.some((m) => m.kind === 'func' && m.static && !(m.params ?? '').trim()));
			return `JSObject([${fns.map(([fn]) => `(${JSON.stringify(fn)}, { (_: [Any?]) throws -> Any? in ${kitMember(this.index, ns, fn)?.throws ? 'try ' : ''}${ns}.${fn}() } as JSFunction)`).join(', ')}])`;
		}
		// `Color.equals` as a value: the class's own function of the name, not an instance method of it.
		const own = (() => {
			for (let x = this.index.get(owner.name); x; x = x.base ? this.index.get(x.base) : undefined) {
				const f = x.members.get(name)?.find((y) => y.kind === 'func' && !!y.static === owner.isStatic);
				if (f) return f;
			}
			return undefined;
		})();
		const propSym = t.resolve(e.name);
		if (!own && !owner.isStatic && (this.ownPropertyOnly(owner.name, e.name) || augmentedProperty(this.index, owner.name, e.name, propSym) || ((!propSym || !propSym.declarations?.some(isCoreDeclaration)) && kitMember(this.index, owner.name, 'jsExpando')))) {
			if (inChain) throw t.error(e, `${owner.name}.${name} in an optional chain`);
			return t.fromAnyCode(`${recv}[jsKey: ${JSON.stringify(name)}]`, t.typeOf(e), true);
		}
		const m = own ?? this.member(owner.name, name, e);
		if (inChain && continued) return this.t.marks.memberOf(recv, '.', name);
		// A method as a value (`Builder.load` given to `isFunction`): the function Swift has of it, adapted to the declared type.
		const called = ts.isCallExpression(e.parent) && e.parent.expression === e;
		if (m.kind === 'func' && !called && !inChain) {
			const plain = (x: string) =>
				x
					.trim()
					.replace(/^\((.*)\)!$/, '($1)?')
					.replace(/!$/, '?');
			const kitFn = `(${
				(m.params ?? '').trim()
					? splitParams(m.params!)
							.map(kitParamType)
							.map(plain)
							.map((p) => (this.t.functionTypeParts(p) ? `@escaping ${p}` : p))
							.join(', ')
					: ''
			}) ${m.throws ? 'throws ' : ''}-> ${plain(m.type) || 'Void'}`;
			return this.fromKit(`(${recv}.${name} as ${kitFn})`, kitFn, t.typeOf(e));
		}
		// A property the kit holds untyped, read as any value (`<any>style.borderColor` after `style.borderColor = hex`, which
		// TypeScript narrows to the string assigned): what it holds, which a setter converted (a Color).
		let outer: ts.Node = e.parent;
		while (ts.isParenthesizedExpression(outer)) outer = outer.parent;
		const untyped = (ts.isAsExpression(outer) || ts.isTypeAssertionExpression(outer)) && outer.type.kind === ts.SyntaxKind.AnyKeyword;
		const read = isUntyped(spelledType(m.type.trim())) && untyped && ['String', 'Double', 'Bool'].includes(t.typeOf(e)) ? 'Any?' : t.typeOf(e);
		const optional = !inChain && /[?!]$/.test(m.type.trim()) && !isUntyped(spelledType(read)) && !read.endsWith('?') && (t.readOptional(e) || (!t.lenient && t.states.nilKept(e)));
		return this.fromKit(this.t.marks.memberOf(recv, '.', name), inChain ? m.type.replace(/[?!]?$/, '?') : m.type, optional ? optionalType(read) : read);
	}

	/** A constant core declares with a literal type (`CoreTypes.AnimationCurve.easeIn` is "easeIn"), as that literal. */
	private constant(e: ts.PropertyAccessExpression): string | null {
		const decl = this.t.resolve(e.name)?.declarations?.[0];
		if (!decl || !isCoreDeclaration(decl) || !ts.isVariableDeclaration(decl) || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
		const type = this.t.checker.getTypeAtLocation(decl);
		if (type.isStringLiteral()) return JSON.stringify(type.value);
		if (type.isNumberLiteral()) return String(type.value);
		return null;
	}

	/** `target.name = value` where target is core-typed. */
	assign(left: ts.PropertyAccessExpression, value: ts.Expression): string | null {
		if (this.heldFunction(left.expression, left.name.text)) return null;
		const owner = this.mixinOwn(left.name) ? null : (this.owner(left.expression) ?? this.inheritedOwner(left.expression, left.name));
		if (!owner) return null;
		const t = this.t;
		const name = left.name.text;
		const recv = owner.isStatic ? owner.name : this.receiver(left.expression, left.name.text);
		if (!owner.isStatic && this.isView(owner.name) && (!kitMember(this.index, owner.name, name) || this.isViewProperty(owner.name, name))) {
			if (!this.isViewProperty(owner.name, name)) {
				const sym = t.resolve(left.name);
				if (!sym || sym.declarations?.every((d) => !isCoreDeclaration(d)) || augmentedProperty(this.index, owner.name, left.name, sym)) return `${recv}[jsKey: ${JSON.stringify(name)}] = ${t.coerce(value, 'Any?')}`;
				unappliedProperty(t, left.name, `${owner.name}.${name}`, 'NativeScriptKit');
			}
			// Core's `set` runs the property's change handlers, whose errors are reported as core reports them.
			return `${RT.jsReport} { try ${recv}.set(${JSON.stringify(name)}, ${t.coerce(value, 'Any?')}) }`;
		}
		if (!owner.isStatic && (this.ownPropertyOnly(owner.name, left.name) || augmentedProperty(this.index, owner.name, left.name, t.resolve(left.name)))) return `${recv}[jsKey: ${JSON.stringify(name)}] = ${t.coerce(value, 'Any?')}`;
		const m = this.member(owner.name, name, left);
		const assigned = (code: string) => this.t.marks.assignedCode(`${recv}.${name}`, code, !owner.isStatic && (t.receiverThrows(left.expression) || this.optionalKitValue(left.expression)));
		// A kit member typed `Any?` holds what core reads as a plain script object (`TouchManager.animations`).
		if (isUntyped(spelledType(m.type.trim()))) return assigned(this.scriptValue(value));
		// Undefined where the kit holds a string, number or boolean: its zero, as core's own code assigning it was compiled.
		const zero = ({ String: '""', Double: '0', Bool: 'false' } as Record<string, string>)[m.type.trim()];
		const nullish = value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined');
		if (zero && nullish) return assigned(zero);
		// Null where the kit holds an object maybe missing (`view.backgroundColor = null`): none.
		if (nullish && /[?!]$/.test(m.type.trim())) return assigned('nil');
		return assigned(this.toKit(t.coerce(value, t.typeOf(left)), m.type));
	}

	/** A core member read through a class of the app or a plugin that extends a core class (`this.isPassThroughParentEnabled` in a GridLayout subclass). */
	private inheritedOwner(target: ts.Expression, name: ts.MemberName): { name: string; isStatic: boolean } | null {
		const c = this.t.checker;
		const decl = c.getSymbolAtLocation(name)?.valueDeclaration;
		if (!decl || !isCoreDeclaration(decl)) return null;
		const cls = c.getNonNullableType(c.getTypeAtLocation(target)).getSymbol()?.valueDeclaration;
		const root = cls && ts.isClassLike(cls) && !cls.getSourceFile().isDeclarationFile ? this.t.kitRootOf(cls) : null;
		return root ? { name: root, isStatic: false } : null;
	}

	/** A member a mixin class declares: the extension it becomes has it by name. */
	private mixinOwn(name: ts.MemberName): boolean {
		return isMixinOwnMember(name, this.t.checker, (s) => this.t.mixinOf(s));
	}

	/**
	 * A member of an event data type (core's, or a framework's such as `ListViewItemTapEvent`)
	 * that the kit's EventData does not declare (`args.state`, `args.getX()`, `args.item`): the
	 * event's own object has it, read by name.
	 */
	eventMember(e: ts.PropertyAccessExpression): boolean {
		const c = this.t.checker;
		const type = c.getNonNullableType(c.getTypeAtLocation(e.expression));
		if (this.t.type(type, e.expression) !== 'EventData') return false;
		return !kitMember(this.index, 'EventData', e.name.text);
	}

	/** A call of a kit method, or a `new` of a kit class, that the kit declares `throws` (the kit generated from core throws as script does). */
	throwingCall(e: ts.CallExpression | ts.NewExpression): boolean {
		if (ts.isNewExpression(e)) {
			const sym = ts.isIdentifier(e.expression) ? this.t.resolve(e.expression) : undefined;
			const decl = sym?.declarations?.[0];
			if (!sym || !(sym.flags & ts.SymbolFlags.Class) || !isCoreDeclaration(decl) || this.t.compiledCounterpart(sym)) return false;
			const name = coreSymbolName(sym);
			// A color made of a string throws where the string is no color.
			if (name === 'Color') return (e.arguments ?? []).some((a) => this.t.typeOf(a) !== 'Double');
			return (this.index.get(this.platformClass(name))?.members.get('init') ?? []).some((m) => m.throws);
		}
		// A function core's index exports (`fromObject`), as the kit compiled it.
		if (ts.isIdentifier(e.expression)) {
			const decl = this.t.resolve(e.expression)?.declarations?.[0];
			if (!decl || !isCoreDeclaration(decl) || !ts.isFunctionDeclaration(decl)) return false;
			// By its own name, whatever the import calls it (`bindingBuilder.getBindingOptions`, read as `__bindingBuilder_getBindingOptions`).
			const name = decl.name?.text ?? e.expression.text;
			const owned = this.moduleFunction(decl);
			return owned ? !!kitMember(this.index, owned.slice(0, owned.lastIndexOf('.')), name)?.throws : this.throwingExports().has(name);
		}
		if (!ts.isPropertyAccessExpression(e.expression) || this.mixinOwn(e.expression.name)) return false;
		// `super.initNativeView()`, `this.requestLayout()` in a program's class of a core one: the core class declaring the method.
		const member = this.t.resolve(e.expression.name)?.declarations?.[0];
		const declaring = member && isCoreDeclaration(member) && ts.isClassLike(member.parent) && member.parent.name ? member.parent.name.text : null;
		const owner = this.owner(e.expression.expression)?.name ?? declaring;
		if (owner && this.addedMember(owner, e.expression)) return true;
		const m = owner ? this.callMember(owner, e.expression.name.text, e.arguments.length) : null;
		// A property holding a function that throws (`on: ((String, …) throws -> Void)!`).
		return !!m && (!!m.throws || (m.kind === 'var' && /\)\s*throws\s*->[^>]*\)?[?!]?$/.test(m.type)));
	}

	/** `signal.aborted`: a property of core's whose getter the kit compiled as throwing. */
	throwingAccess(e: ts.PropertyAccessExpression): boolean {
		if (this.mixinOwn(e.name)) return false;
		const owner = (this.owner(e.expression) ?? this.inheritedOwner(e.expression, e.name))?.name;
		const m = owner ? kitMember(this.index, owner, e.name.text) : null;
		if (m && !e.questionDotToken && this.optionalKitValue(e.expression)) return true;
		// A function held optional, called: checked (see `call`).
		if (m?.kind === 'var' && !m.params && ts.isCallExpression(e.parent) && e.parent.expression === e && /[?!]$/.test(m.type.trim()) && this.t.functionTypeParts(m.type.replace(/[?!]$/, '').replace(/^\((.*)\)$/, '$1'))) return true;
		return m?.kind === 'var' && !!m.throws;
	}

	/** A kit property's value or method's result the kit holds optional, read where core's typings say present. */
	kitNil(x: ts.Expression): boolean {
		try {
			x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
			if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
				const result = this.moduleResult(this.t.resolve(x.expression)?.declarations?.[0]);
				return (
					!!result &&
					/[?!]$/.test(result.trim()) &&
					!isUntyped(spelledType(result.trim())) &&
					!this.t.functionTypeParts(
						result
							.trim()
							.replace(/[?!]$/, '')
							.replace(/^\((.*)\)$/, '$1'),
					)
				);
			}
			const access = ts.isCallExpression(x) ? x.expression : x;
			if (ts.isOptionalChain(x) || !ts.isPropertyAccessExpression(access) || this.mixinOwn(access.name)) return false;
			const owner = this.owner(access.expression) ?? this.inheritedOwner(access.expression, access.name);
			const m = !owner ? null : ts.isCallExpression(x) ? this.callMember(owner.name, access.name.text, x.arguments.length) : kitMember(this.index, owner.name, access.name.text);
			if (!m || m.kind !== (ts.isCallExpression(x) ? 'func' : 'var')) return false;
			const k = m.type.trim();
			return /[?!]$/.test(k) && !isUntyped(spelledType(k)) && !this.t.functionTypeParts(k.replace(/[?!]$/, '').replace(/^\((.*)\)$/, '$1'));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	}

	/**
	 * A read of a core value the kit holds optional that gives it as it is: a module constant (`Application`), a static or
	 * member core's typings declare as an interface the kit has no type for (`Screen.mainScreen`, read as any value).
	 */
	optionalKitValue(x: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(x)) x = x.expression;
		if (!this.t.lenient && !this.t.library && this.kitNil(x)) return true;
		if (ts.isIdentifier(x)) {
			const sym = this.t.resolve(x);
			const decl = sym?.declarations?.[0];
			if (!sym || !decl || !ts.isVariableDeclaration(decl) || !isCoreDeclaration(decl) || this.t.compiledCounterpart(sym)) return false;
			return /\?$/.test(this.exportVarType(sym.name) ?? '');
		}
		// A kit method's optional result (`SplitView.getInstance()`, `SplitViewBase | null`), which a non-strict app's typings give present.
		if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && !x.expression.questionDotToken && !ts.isOptionalChain(x)) {
			const c = x.expression;
			const owner = this.mixinOwn(c.name) ? null : (this.owner(c.expression) ?? this.inheritedOwner(c.expression, c.name));
			const m = owner ? this.callMember(owner.name, c.name.text, x.arguments.length) : null;
			if (
				m?.kind !== 'func' ||
				!/\?$/.test(m.type.trim()) ||
				this.t.functionTypeParts(
					m.type
						.trim()
						.replace(/\?$/, '')
						.replace(/^\((.*)\)$/, '$1'),
				)
			)
				return false;
			const read = this.t.typeOf(x);
			return isUntyped(spelledType(read)) || read.endsWith('?');
		}
		if (!ts.isPropertyAccessExpression(x) || x.questionDotToken || ts.isOptionalChain(x)) return false;
		const owner = this.mixinOwn(x.name) ? null : (this.owner(x.expression) ?? this.inheritedOwner(x.expression, x.name));
		const m = owner ? kitMember(this.index, owner.name, x.name.text) : null;
		if (
			m?.kind !== 'var' ||
			!/\?$/.test(m.type.trim()) ||
			this.t.functionTypeParts(
				m.type
					.trim()
					.replace(/\?$/, '')
					.replace(/^\((.*)\)$/, '$1'),
			)
		)
			return false;
		// `fromKit` unwraps it where the read is of a type it converts to; what is read as any value, or optional, stays as the kit holds it.
		const read = this.t.typeOf(x);
		return isUntyped(spelledType(read)) || read.endsWith('?');
	}

	/** The type of a variable core's index exports, as the kit's top-level accessor gives it. */
	private exportVarType(name: string): string | null {
		return this.coreGlobal(name, 'var')?.type ?? null;
	}

	/** The functions the kit's index exports that throw. */
	private throwingExports(): Set<string> {
		return new Set([...(this.index.get(KIT_GLOBALS)?.members ?? [])].filter(([, list]) => list.some((m) => m.exported && m.kind === 'func' && m.throws)).map(([n]) => n));
	}

	/** A call of a core function, its result as the declarations type it: one the kit compiled into its module enum, or one core's index exports. */
	moduleCall(decl: ts.Declaration, code: string, tsType: string, e?: ts.CallExpression): string {
		const result = this.moduleResult(decl);
		if (!result) return code;
		const kept = !!e && /[?!]$/.test(result.trim()) && !isUntyped(spelledType(tsType)) && !tsType.endsWith('?') && !this.t.lenient && this.t.states.nilKept(e);
		return this.fromKit(code, result, kept ? optionalType(tsType) : tsType);
	}

	/** The kit's result type of a core function an app calls by name: one compiled into its module's enum, or one core's index exports. */
	private moduleResult(decl: ts.Declaration | undefined): string | undefined {
		if (!decl || !ts.isFunctionDeclaration(decl) || !decl.name || !isCoreDeclaration(decl)) return undefined;
		const owned = this.moduleFunction(decl);
		const m = owned && kitMember(this.index, owned.slice(0, owned.lastIndexOf('.')), decl.name.text);
		return m ? m.type : !owned ? this.exportSignature(decl.name.text)?.result : undefined;
	}

	/** The kit's forwarder of a function core's index exports: its parameters and result. */
	private exportSignature(name: string): { params: string[]; result: string } | null {
		const m = this.coreGlobal(name, 'func');
		return m ? { params: (m.params ?? '').trim() ? splitParams(m.params!) : [], result: m.type } : null;
	}
	/** The arguments of a call of a function core's index exports, as the kit's forwarder takes them (`addWeakEventListener(…, target.onEvent, …)`). */
	exportArgs(e: ts.CallExpression, decl: ts.Declaration, args: string[]): string[] {
		if (!ts.isFunctionDeclaration(decl) || !decl.name || !isCoreDeclaration(decl)) return args;
		// Or one compiled into its module's enum (`fpsMeter.addCallback`): that member's parameters.
		const owned = this.moduleFunction(decl);
		const member = owned ? kitMember(this.index, owned.slice(0, owned.lastIndexOf('.')), decl.name.text) : null;
		const params = owned ? (member?.params?.trim() ? splitParams(member.params) : null) : this.exportSignature(decl.name.text)?.params;
		// A rest parameter (`makeValidator(...values)`), which the kit takes as one array.
		const restAt = decl.parameters.findIndex((p) => !!p.dotDotDotToken);
		const restType = params && restAt >= 0 && restAt === params.length - 1 ? /:\s*(JSArray<.*>)\s*$/.exec(params[restAt])?.[1] : undefined;
		if (restType && args.length >= restAt && !e.arguments.some(ts.isSpreadElement)) return [...args.slice(0, restAt), `${restType}([${args.slice(restAt).join(', ')}])`];
		if (!params || params.length < e.arguments.length) return args;
		const out = [...args];
		this.matchKitParams(e, params, out);
		return out;
	}

	/** `target.method(args)` where target is core-typed, or `new CoreClass(args)`. */
	call(e: ts.CallExpression): string | null {
		if (!ts.isPropertyAccessExpression(e.expression)) return null;
		// A factory in a core namespace is the kit class it builds.
		if (e.expression.getText() === 'CoreTypes.AnimationCurve.cubicBezier' && isCoreDeclaration(this.t.resolve(e.expression.name)?.declarations?.[0])) {
			return `CubicBezierAnimationCurve(${e.arguments.map((a) => this.t.coerce(a, 'Double')).join(', ')})`;
		}
		const owner = this.mixinOwn(e.expression.name) ? null : (this.owner(e.expression.expression) ?? this.inheritedOwner(e.expression.expression, e.expression.name));
		if (!owner) return null;
		const t = this.t;
		const name = e.expression.name.text;
		// A method the app's own type adds to a core one (`View & { addChild(view: View): void }`): called by name, as script calls it.
		if (this.addedMember(owner.name, e.expression)) {
			const target = owner.isStatic ? owner.name : t.expr(e.expression.expression);
			return this.fromKit(`${RT.jsCallMethod}(${target}, ${JSON.stringify(name)}${e.arguments.map((a) => `, ${t.coerce(a, 'Any?')}`).join('')})`, 'Any?', t.typeOf(e));
		}
		// `toString()` of a kit object without its own: as script converts it.
		if (name === 'toString' && !owner.isStatic && !e.arguments.length && !kitMember(this.index, owner.name, name)) return `${RT.jsToString}(${t.expr(e.expression.expression)})`;
		this.member(owner.name, name, e.expression);
		const m = this.callMember(owner.name, name, e.arguments.length)!;
		// `this.hud?.animate(…)`: nothing runs where the object is missing.
		const chained = !owner.isStatic && !!e.expression.questionDotToken && t.typeOf(e.expression.expression).endsWith('?');
		// A namespace of core's by its module (`path.join`), which a local of the name (`path: string`) would shadow.
		const recv = owner.isStatic ? (/^[a-z]/.test(owner.name) ? `NativeScriptKit.${owner.name}` : owner.name) : chained ? `${t.expr(e.expression.expression)}?` : this.receiver(e.expression.expression, name);
		if (name === 'navigate' && kitExtends(this.index, owner.name, 'Frame')) return this.navigate(recv, e);
		const listener = this.listenerArgs(e, m);
		// A kit method takes the arguments given; its own defaults stand for the rest.
		// A last argument spread into the kit's rest parameter is placed below, as the array it is.
		const spreadLast = e.arguments.length > 0 && ts.isSpreadElement(e.arguments[e.arguments.length - 1]);
		const args = listener ?? (SCRIPT_OBJECTS.has(name) && this.isView(owner.name) ? e.arguments.map((a, k) => this.scriptValue(a, (m.params ?? '').trim() ? kitParamType(splitParams(m.params!)[k] ?? '') : undefined)) : spreadLast ? [...t.args(e, e.arguments.length - 1), ''] : t.args(e, e.arguments.length));
		// A property holding a function (`Application.on`, which core assigns in its constructor): its parameters are the function type's,
		// each of them passed, as a Swift function value has no defaults.
		const held = m.kind === 'var' && !m.params ? t.functionTypeParts(m.type.replace(/[?!]$/, '').replace(/^\((.*)\)$/, '$1')) : null;
		// A closure for a kit parameter that cannot throw (`dispatchToMainThread`) reports what it throws, as a handler does.
		const kitParams = (m.params ?? '').trim() ? splitParams(m.params!) : held ? held.params.map((p) => `_ p: ${p}`) : [];
		e.arguments.forEach((a, k) => {
			const p = kitParams[k];
			if (!listener && p && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && !a.parameters.length && (t.checker.getContextualType(a)?.getCallSignatures()[0]?.getParameters().length ?? 0) === 0 && /->/.test(p) && !/\bthrows\b/.test(p) && /\(\s*\)\s*->/.test(p)) args[k] = t.callback(a);
		});
		const packed = !listener && this.matchKitParams(e, kitParams, args);
		// A rest parameter (`join(...paths)`), which the kit takes as one array.
		const restAt = (t.checker.getResolvedSignature(e)?.getDeclaration() as ts.SignatureDeclaration | undefined)?.parameters?.findIndex((p) => !!p.dotDotDotToken) ?? -1;
		const restType = restAt >= 0 ? /:\s*(JSArray<.*>)\s*$/.exec(kitParams[restAt] ?? '')?.[1] : undefined;
		if (restType && !listener && !packed && !e.arguments.some(ts.isSpreadElement) && args.length >= restAt) args.splice(restAt, args.length - restAt, `${restType}([${args.slice(restAt).join(', ')}])`);
		// One array spread into the rest (`path.join(...parts)`): the array the kit's rest parameter is.
		const spread = e.arguments[restAt];
		if (restType && !listener && !packed && e.arguments.length === restAt + 1 && spread && ts.isSpreadElement(spread)) args.splice(restAt, args.length - restAt, t.coerce(spread.expression, restType));
		// Fewer arguments than core declares (lenient code's `Builder.parseMultipleTemplates(value)`): undefined for each optional one left out.
		if (!held && !listener && !packed && !e.arguments.some(ts.isSpreadElement)) while (args.length < kitParams.length && !kitParams[args.length].includes('=') && /[?!]\s*$/.test(kitParams[args.length])) args.push('nil');
		if (held) {
			// A rest parameter of the function core implements behind the overloads its typings declare (`prompt(...args)` for `prompt(options)`).
			if (held.rest >= 0 && !listener && !packed) {
				while (args.length < held.rest) args.push('nil');
				args.splice(held.rest, args.length - held.rest, t.packed(e.arguments.slice(held.rest), held.params[held.rest]));
			}
			while (args.length < held.params.length && /[?!]$/.test(held.params[args.length])) args.push('nil');
			// Held optional (core assigns it later): V8's "is not a function" where it is missing.
			const fn = /[?!]$/.test(m.type.trim()) ? `${RT.jsCallable}(${recv}.${name}, ${JSON.stringify(e.expression.getText().replace(/\s+/g, ' '))})` : `${recv}.${name}`;
			return this.fromKit(this.t.marks.leading(`${fn}(${args.join(', ')})`, recv), held.result, t.typeOf(e));
		}
		const read = t.typeOf(e),
			kept = /[?!]$/.test(m.type.trim()) && !isUntyped(spelledType(read)) && !read.endsWith('?') && !t.lenient && t.states.nilKept(e);
		return this.fromKit(this.t.marks.leading(`${recv}.${name}(${args.join(', ')})`, recv), chained && m.type !== 'Void' ? m.type.replace(/\??$/, '?') : m.type, kept ? optionalType(read) : read);
	}

	/**
	 * Arguments as the kit's own parameters take them, where its Swift types differ from the
	 * declarations' (the kit generated from core): a function as the kit's function type
	 * (`on(event, (data) => …)` for `(EventData?) throws -> Void`), and the arguments from a
	 * rest parameter on (`closeModal('done')`) as the array the kit's rest parameter is. Returns whether it packed a rest
	 * parameter's arguments.
	 */
	private matchKitParams(e: ts.CallExpression, kitParams: string[], args: string[]): boolean {
		const t = this.t;
		const decl = t.checker.getResolvedSignature(e)?.getDeclaration();
		const declared = decl && !ts.isJSDocSignature(decl) ? decl.parameters : undefined;
		let packed = false;
		kitParams.forEach((p, k) => {
			const type = kitParamType(p);
			// `...args: any` the kit compiled as one untyped parameter, which the function reads as the array script passes;
			// or a method reading `arguments`, which takes them all so.
			// Not where the kit spreads the rest over parameters of its own (`showModal(_ __b0: Any?, _ __b1: Any?)`).
			const wholeRest = type === 'JSArray<Any?>' || (isUntyped(spelledType(type)) && k === kitParams.length - 1 && !/^_\s+__b\d/.test(p.trim()));
			if ((declared?.[k]?.dotDotDotToken && wholeRest) || (k === 0 && kitParams.length === 1 && /^_ __arguments: JSArray<Any\?>$/.test(p.trim()))) {
				args.splice(
					k,
					args.length - k,
					`JSArray<Any?>([${e.arguments
						.slice(k)
						.map((a) => t.coerce(a, 'Any?'))
						.join(', ')}])`,
				);
				packed = true;
				return;
			}
			const a = e.arguments[k];
			// A typed array where the kit erased its element type (`VirtualArray<number>.load(index, items)`): its elements as any value.
			if (a && !ts.isSpreadElement(a) && /^JSArray<Any\?>[?!]?$/.test(type) && /^JSArray<.+>$/.test(t.typeOf(a)) && t.typeOf(a) !== 'JSArray<Any?>') {
				const loose = t.loose(a) && t.looseTolerated(a);
				args[k] = t.untypedArray(loose ? `${t.expr(a)} as ${t.typeOf(a)}?` : t.expr(a), t.typeOf(a), type, loose) ?? (loose ? `(${t.expr(a)} as ${t.typeOf(a)}?).map { JSArray<Any?>($0.storage.map { $0 as Any? }) }` : `JSArray<Any?>(${t.expr(a)}.storage.map { $0 as Any? })`);
				return;
			}
			// Code without null checks: undefined or null where the kit takes a value (`addWeakEventListener(source, name, undefined, target)`),
			// the TypeError of its first use; a string, number or boolean where the kit takes another, converted as script converts it.
			if (a && t.lenientApp && !ts.isSpreadElement(a)) {
				let bare: ts.Expression = a;
				while (ts.isParenthesizedExpression(bare) || ts.isAsExpression(bare) || ts.isTypeAssertionExpression(bare)) bare = bare.expression;
				if ((bare.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(bare) && bare.text === 'undefined')) && !/[?!]$/.test(type) && !['String', 'Double', 'Bool', 'Any?'].includes(type)) {
					args[k] = this.t.marks.tryCode(`${RT.jsRequired}(nil as ${optionalType(type.replace(/^@escaping /, ''))}, ${JSON.stringify(p.trim().split(/[\s:]+/)[1] ?? 'argument')})`);
					return;
				}
				const own = t.typeOf(a);
				const convert: Record<string, string> = { String: RT.jsToString, Double: RT.jsToNumber, Bool: RT.jsTruthy };
				if (convert[type] && convert[own] && own !== type) {
					args[k] = `${convert[type]}(${t.coerce(a, own)})`;
					return;
				}
			}
			// An untyped value where the kit's parameter has a type (`releaseNativeObject(obj as any)` for an `NSObject!`): read as it.
			if (a && !ts.isSpreadElement(a) && !/->/.test(type) && !isUntyped(spelledType(type)) && isUntyped(spelledType(t.typeOf(a)))) {
				args[k] = t.coerce(a, type.replace(/!$/, '?'));
				return;
			}
			if (a && /->/.test(type) && (ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || (ts.isCallExpression(a) && /->/.test(t.typeOf(a))))) {
				// An optional function parameter (`callback: ((Any?) throws -> Void)?`) takes a closure as the function it wraps.
				const plain = type.replace(/^\((.*)\)[?!]$/, '$1');
				const fn = t.functionTypeParts(plain);
				if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && fn) {
					args[k] = this.closureArgument(a, plain);
				} else {
					const own = t.typeOf(a);
					args[k] = /->/.test(own) && own.replace(/^\((.*)\)$/, '$1') !== type ? t.convertPlaced(a, own, type) : t.coerce(a, type);
				}
			}
		});
		return packed;
	}

	/**
	 * `on`/`off`/`once` with a named function: Swift closures have no identity,
	 * so the kit matches a listener by key, here the declaration the function
	 * comes from. Two closures from one declaration (one per instance) share it.
	 */
	private listenerArgs(e: ts.CallExpression, m: KitMember): string[] | null {
		const name = (e.expression as ts.PropertyAccessExpression).name.text;
		if (!['on', 'once', 'off', 'addEventListener', 'removeEventListener'].includes(name) || !/\bkey: String\?/.test(m.params ?? '')) return null;
		const [event, callback, thisArg] = e.arguments;
		if (!event || !callback) return null;
		const t = this.t;
		const sym = ts.isIdentifier(callback) || ts.isPropertyAccessExpression(callback) ? t.resolve(ts.isIdentifier(callback) ? callback : callback.name) : undefined;
		const decl = sym?.valueDeclaration;
		// Only a function with one identity per declaration: a parameter or a reassigned variable holds any function.
		const named = decl && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || (ts.isPropertyDeclaration(decl) && !!decl.initializer && ts.isArrowFunction(decl.initializer)) || (ts.isVariableDeclaration(decl) && !!(decl.parent.flags & ts.NodeFlags.Const) && !!decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))));
		if (!decl || !named) return null;
		const key = `${decl.getSourceFile().fileName.split('/').pop()}:${decl.getStart()}`;
		return [t.str(event), t.coerce(callback, '(EventData) throws -> Void'), thisArg ? t.coerce(thisArg, 'Any?') : 'nil', `key: ${JSON.stringify(key)}`];
	}

	construct(e: ts.NewExpression): string | null {
		const code = this.constructed(e);
		// A local of the class's name (`var StackLayout = new sp.StackLayout()`) hides the kit's class: named through the kit.
		const name = code && /^([A-Z]\w*)\(/.exec(code)?.[1];
		const local = name ? this.t.checker.resolveName(name, e, ts.SymbolFlags.Value, false)?.valueDeclaration : undefined;
		return local && (ts.isVariableDeclaration(local) || ts.isParameter(local)) && !local.getSourceFile().isDeclarationFile ? `NativeScriptKit.${code}` : code;
	}

	private constructed(e: ts.NewExpression): string | null {
		const sym = this.t.resolve(e.expression);
		if (!sym || !isCoreDeclaration(sym.declarations?.[0]) || this.t.compiledCounterpart(sym)) return null;
		const t = this.t;
		const args = e.arguments ?? ts.factory.createNodeArray();
		const className = coreSymbolName(sym);
		let kitName = this.platformClass(className);
		// A class of a namespace (`Trace.DefaultErrorHandler`), nested in the kit as in core.
		if (!this.index.has(kitName)) {
			const path = [sym.name];
			let p = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
			for (; p && p.flags & ts.SymbolFlags.Module && !ts.isSourceFile(p.valueDeclaration ?? p.declarations![0]); p = (p as ts.Symbol & { parent?: ts.Symbol }).parent) path.unshift(p.name);
			// A module core's index exports as a namespace (`export * as Trace from './trace'`): its public name.
			const file = p?.valueDeclaration && ts.isSourceFile(p.valueDeclaration) ? p.valueDeclaration.fileName : undefined;
			const root = file && /^(.*[\\/]@nativescript[\\/]core)[\\/]/.exec(file)?.[1];
			const barrel = root ? coreBarrels(root).get(file!.slice(root.length + 1).split(/[\\/]/)[0]) : undefined;
			if (barrel) path.unshift(barrel);
			if (path.length > 1 && this.index.has(path.join('.'))) kitName = path.join('.');
		}
		if (!this.index.has(kitName)) throw t.error(e, `new ${className} (NativeScriptKit has no such class)`);
		// Core's constructor takes its arguments as a rest parameter; numbers never make it throw.
		if (sym.name === 'Color') {
			const list = `JSArray<Any?>([${args.map((a) => t.coerce(a, 'Any?')).join(', ')}])`;
			// A string may not be a color, which throws as script's constructor does.
			return args.some((a) => t.typeOf(a) !== 'Double') ? `Color(${list})` : `(try! Color(${list}))`;
		}
		if (sym.name === 'Animation') return `Animation(${args.map((a) => this.scriptValue(a)).join(', ')})`;
		const inits = (this.index.get(kitName)?.members.get('init') ?? []).map((m) => ((m.params ?? '').trim() ? splitTopLevel(m.params!) : []));
		// A constructor reading `arguments`, which the kit's takes as the one array script passes.
		if (inits.length === 1 && inits[0].length === 1 && /^_ __arguments: JSArray<Any\?>$/.test(inits[0][0].trim())) return `${kitName}(${t.packed(args, 'JSArray<Any?>')})`;
		const given = this.kitInitArgs(kitName, args);
		return `${kitName}(${(given ?? t.args(e)).join(', ')})`;
	}

	/**
	 * `require('@nativescript/core/ui/animation').fn(args)`: the function the kit compiled into that module's enum
	 * (`Core_ui_animation_index`), its arguments as it takes them; null where the call is not one of a core module.
	 */
	requiredModuleCall(e: ts.CallExpression): string | null {
		if (!ts.isPropertyAccessExpression(e.expression)) return null;
		let base: ts.Expression = e.expression.expression;
		while (ts.isParenthesizedExpression(base) || ts.isAsExpression(base) || ts.isTypeAssertionExpression(base)) base = base.expression;
		if (!ts.isCallExpression(base) || !ts.isIdentifier(base.expression) || base.expression.text !== 'require' || !base.arguments[0] || !ts.isStringLiteral(base.arguments[0])) return null;
		const path = /^@nativescript\/core\/(.+)$/.exec(base.arguments[0].text)?.[1];
		if (!path) throw this.t.error(base, `require('${base.arguments[0].text}') of a module other than core's`);
		const name = e.expression.name.text;
		const owner = [`Core_${path}_index`, `Core_${path}`].map((x) => x.replace(/\W/g, '_')).find((x) => kitMember(this.index, x, name)?.kind === 'func');
		if (!owner) throw this.t.error(e, `require('${base.arguments[0].text}').${name}, which the kit has no function of`);
		const m = kitMember(this.index, owner, name)!;
		const params = (m.params ?? '').trim() ? splitParams(m.params!).map(kitParamType) : [];
		const args = e.arguments.map((a, k) => this.t.coerce(a, (params[k] ?? 'Any?').replace(/^@escaping /, '').replace(/!$/, '?')));
		return this.fromKit(this.t.marks.tryIf(m.throws, `${owner}.${name}(${args.join(', ')})`), m.type, this.t.typeOf(e));
	}

	/** The arguments as an initializer of the kit's class takes them (`ImageSource(_ nativeSource: UIImage!)` for core's `nativeSource?: any`), or null. */
	kitInitArgs(kitName: string, args: ts.NodeArray<ts.Expression>): string[] | null {
		const t = this.t;
		const params = (this.index.get(kitName)?.members.get('init') ?? []).map((m) => ((m.params ?? '').trim() ? splitTopLevel(m.params!) : [])).find((ps) => ps.length >= args.length && !args.some(ts.isSpreadElement));
		if (!params || !args.length || !params.every((p) => p.includes(':'))) return null;
		return args.map((a, k) => {
			const p = params[k];
			const label = p.slice(0, p.indexOf(':')).trim().split(/\s+/)[0];
			const type = p
				.slice(p.indexOf(':') + 1)
				.replace(/=.*$/, '')
				.trim()
				.replace(/^@escaping\s+/, '')
				.replace(/!$/, '?');
			// An optional function parameter takes the closure as the function it wraps.
			const fnType = type.replace(/^\((.*)\)\?$/, '$1');
			return `${label === '_' ? '' : `${label}: `}${(ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && t.functionTypeParts(fnType) ? this.closureArgument(a, fnType) : t.coerce(a, type)}`;
		});
	}

	/**
	 * A closure passed where the kit takes a function of a known Swift type: the type's parameters past those the closure
	 * declares, and, where core's lenient types differ from the app's (`(ParserEvent?) throws -> Void` for `(e: ParserEvent) => void`), adapted.
	 */
	private closureArgument(a: ts.ArrowFunction | ts.FunctionExpression, type: string): string {
		const t = this.t;
		const want = t.functionTypeParts(type)!;
		t.closureSlots.set(a, want.params);
		try {
			const code = t.coerce(a, type);
			const own = t.typeOf(a);
			const have = t.functionTypeParts(own.replace(/^\((.*)\)[?!]$/, '$1'));
			return have && have.params.length === want.params.length && own.replace(/^\((.*)\)[?!]$/, '$1') !== type.replace(/^\((.*)\)[?!]$/, '$1') ? t.convert(code, own, type) : code;
		} finally {
			t.closureSlots.delete(a);
		}
	}

	/** `frame.navigate({ create: () => page })`: the kit builds what `create` returns. */
	private navigate(recv: string, e: ts.CallExpression): string {
		const entry = e.arguments[0];
		if (!entry) throw this.t.error(e, 'frame.navigate without an entry');
		// A function making the page, which core calls for it: its result is the page.
		const factory = (code: string) => `({ (_: [Any?]) throws -> Any? in try (${code})() } as JSFunction)`;
		if (ts.isArrowFunction(entry) || ts.isFunctionExpression(entry)) return `${recv}.navigate(${factory(this.t.expr(entry))})`;
		// A module name, or an entry held in a variable: as script gives it, its `create` boxed as script calls it.
		if (!ts.isObjectLiteralExpression(entry)) return `${recv}.navigate(${this.t.coerce(entry, 'Any?')})`;
		// Core reads the entry as script gives it: `create` a function it calls for the page, the rest plain values.
		const fields = entry.properties.map((p) => {
			if (ts.isShorthandPropertyAssignment(p)) return p.name.text === 'create' ? `("create", ${factory(this.t.expr(p.name))})` : `(${JSON.stringify(p.name.text)}, ${this.t.coerce(p.name, 'Any?')})`;
			if (!ts.isPropertyAssignment(p)) throw this.t.error(p, `the navigation entry's ${p.name?.getText()}`);
			const name = p.name.getText().replace(/^['"]|['"]$/g, '');
			if (name !== 'create') return `(${JSON.stringify(name)}, ${this.scriptValue(p.initializer)})`;
			return `("create", ${factory(this.t.expr(p.initializer))})`;
		});
		return `${recv}.navigate(JSObject([${fields.join(', ')}]))`;
	}

	/**
	 * An argument core reads as a plain script object (an animation definition):
	 * literals become JavaScript objects and arrays, whatever their declared type.
	 */
	private scriptValue(e: ts.Expression, kitType?: string): string {
		if (ts.isObjectLiteralExpression(e)) {
			const entry = (p: ts.ObjectLiteralElementLike): [string, string] => {
				if (ts.isPropertyAssignment(p)) return [JSON.stringify(p.name.getText().replace(/^['"]|['"]$/g, '')), this.scriptValue(p.initializer)];
				if (ts.isShorthandPropertyAssignment(p)) return [JSON.stringify(p.name.text), this.t.coerce(p.name, 'Any?')];
				throw this.t.error(p, 'this member in an animation definition');
			};
			if (!e.properties.some(ts.isSpreadAssignment)) return `JSObject([${e.properties.map((p) => `(${entry(p).join(', ')})`).join(', ')}])`;
			// `{ ...base, duration: 150 }`: each in order, a later key over an earlier one.
			const steps = e.properties.map((p) => (ts.isSpreadAssignment(p) ? this.t.marks.tryCode(`${RT.jsObjectSpread}(__o, ${this.t.coerce(p.expression, 'Any?').replace(/^try /, '')})`) : `__o[${entry(p)[0]}] = try ${entry(p)[1].replace(/^try /, '')}`));
			const body = `let __o = JSObject([]); ${steps.join('; ')}; return __o`;
			return `(try { () throws -> JSObject in ${body} }())`;
		}
		if (ts.isArrayLiteralExpression(e)) return `JSArray<Any?>([${e.elements.map((x) => this.scriptValue(x)).join(', ')}])`;
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
			// A function core calls back (`closeCallback`) takes script values.
			const args = e.parameters.map((p, i) => this.t.fromAnyCode(`(${i} < __args.count ? __args[${i}] : nil)`, this.t.typeOf(p)));
			return `({ (__args: [Any?]) throws -> Any? in _ = try (${this.t.expr(e)})(${args.join(', ')}); return nil } as JSFunction)`;
		}
		// A view the kit takes as its class (`open(_ view: View?, …)`), not as a script object.
		return this.t.coerce(e, kitType && /^[A-Z]\w*\?$/.test(kitType) ? kitType : 'Any?');
	}

	/** A kit value as the TypeScript type reads it: kit integers and CGFloats are Doubles. */
	private fromKit(code: string, kitType: string, tsType: string): string {
		const k = kitType.trim();
		// What the kit generated from core gives untyped (`animate()`'s promise), read as the type the declarations give it.
		if (isUntyped(spelledType(k)) && !isUntyped(spelledType(tsType)) && tsType !== 'Void') return this.t.fromAnyCode(code, tsType, true);
		if (k === 'JSArray<Any?>' && /^JSArray<.+>$/.test(tsType) && tsType !== k) return this.t.arrayOf(code, tsType.slice(8, -1));
		// An array of a base class (`Frame._stack()` of FrameBase) that TypeScript types as of a subclass.
		const ke = /^JSArray<([A-Z]\w*)>[?!]?$/.exec(k)?.[1],
			te = /^JSArray<([A-Z]\w*)>$/.exec(tsType)?.[1];
		if (ke && te && ke !== te && !['Any', 'Double', 'String', 'Bool'].includes(te)) {
			// Lenient code's array may be missing, which stays undefined; an element of another class is a TypeError.
			if (this.t.lenient) return this.t.marks.tryCode(`(${code} as JSArray<${ke}>?).map { JSArray<${te}>(try $0.storage.map { try (${RT.jsCastPresent}($0) as ${te}) }) }`);
			return `JSArray<${te}>((${code})${/[?!]$/.test(k) ? '!' : ''}.storage.map { $0 as! ${te} })`;
		}
		const numeric = /^(Int|UInt|Int32|UInt32|Int64|UInt64|CGFloat|Float)\??$/.exec(k);
		if (numeric && tsType.startsWith('Double')) return k.endsWith('?') ? `${code}.map { Double($0) }` : `Double(${code})`;
		// A member the kit types as a base class (`EventData.object` is an Observable) that TypeScript types as a subclass.
		const kb = k.replace(/[?!]$/, ''),
			tb = tsType.replace(/[?!]$/, '');
		if (kb !== tb && /^[A-Z]\w*$/.test(kb) && /^[A-Z]\w*$/.test(tb) && !['Double', 'String', 'Bool', 'Any'].includes(tb) && kb !== 'Any') {
			return tsType.endsWith('?') ? `(${code} as? ${tb})` : `(${code} as! ${tb})`;
		}
		// A function the kit gives of other types (`lazy(…)`'s, its result untyped): adapted to the declared one.
		const fn = (x: string) => this.t.functionTypeParts(x.replace(/^\((.*)\)[?!]$/, '$1'));
		if (k !== tsType && fn(k) && fn(tsType) && fn(k)!.text !== fn(tsType)!.text) return this.t.convert(code, k.replace(/^\((.*)\)!$/, '($1)?'), tsType);
		if (k.endsWith('?') && !tsType.endsWith('?') && !isUntyped(spelledType(tsType))) {
			const zero = tsType === 'String' ? '""' : tsType === 'Double' ? '0' : tsType === 'Bool' ? 'false' : null;
			return zero ? (heldLoss('kitResult', zero, { native: !!this.t.native }), `(${code} ?? ${zero})`) : this.t.marks.unwrappedCode(code);
		}
		return code;
	}

	private toKit(code: string, kitType: string): string {
		const k = kitType.replace(/\?$/, '');
		return /^(Int|UInt|Int32|UInt32|Int64|UInt64|CGFloat|Float)$/.test(k) ? `${k}(${code})` : code;
	}
}

/** A Swift parameter's type (`_ callback: @escaping (EventData?) throws -> Void = …` gives `(EventData?) throws -> Void`). */
function kitParamType(param: string): string {
	let depth = 0,
		colon = -1,
		end = param.length;
	for (let i = 0; i < param.length; i++) {
		const ch = param[i];
		if ('([<'.includes(ch)) depth++;
		else if (')]>'.includes(ch) && !(ch === '>' && param[i - 1] === '-')) depth--;
		else if (depth === 0 && ch === ':' && colon < 0) colon = i;
		else if (depth === 0 && ch === '=' && param[i + 1] !== '=' && colon >= 0) {
			end = i;
			break;
		}
	}
	return param
		.slice(colon + 1, end)
		.replace(/@escaping\s+/, '')
		.trim();
}

/** A parameter list's parameters, split at top-level commas. */
function splitParams(text: string): string[] {
	const out: string[] = [];
	let depth = 0,
		start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if ('([<'.includes(ch)) depth++;
		else if (')]>'.includes(ch) && text[i - 1] !== '-') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(text.slice(start).trim());
	return out;
}
