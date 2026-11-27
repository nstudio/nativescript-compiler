import ts from 'typescript';
import { heldLoss } from '../semantics/losses.ts';
import { join } from 'node:path';
import { addedDeclarations, augmentedProperty, isCoreDeclaration, ownPropertyOnly } from '../program/core-facts.ts';
import { KitTypes, coreClass, kitExtends, kitMember, type KitMember, type KitType } from '../kit/kit-index.ts';
import { KIT_NAMES_ANDROID } from './library.ts';
import { functionTypeParts, kotlinString, numberLiteral, safeCast, splitTopLevel, RT } from './syntax.ts';
import type { KotlinCore, Translator } from './translator.ts';
import { KIT_ANDROID } from '../driver/paths.ts';
import type { AdapterKit } from '../api/adapter-api.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';
import { isMixinOwnMember } from '../semantics/classes.ts';
import { nullableTypeNode } from '../semantics/lang.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { kotlinKitIndex, TOP_LEVEL, NATIVE_MEMBERS, SCRIPT_OBJECTS, KIT } from './core-index.ts';

/** The native class a core view's `android` is. */
export const NATIVE_VIEWS_ANDROID: Record<string, string> = {
	Label: 'android.widget.TextView',
	Button: 'android.widget.Button',
	TextField: 'android.widget.EditText',
	TextView: 'android.widget.EditText',
	Image: 'org.nativescript.widgets.ImageView',
	Switch: 'android.widget.Switch',
	Slider: 'android.widget.SeekBar',
	ActivityIndicator: 'android.widget.ProgressBar',
	Progress: 'android.widget.ProgressBar',
	ScrollView: 'android.widget.FrameLayout',
	ListView: 'android.widget.ListView',
	DatePicker: 'android.widget.DatePicker',
	TimePicker: 'android.widget.TimePicker',
	StackLayout: 'org.nativescript.widgets.StackLayout',
	GridLayout: 'org.nativescript.widgets.GridLayout',
	AbsoluteLayout: 'org.nativescript.widgets.AbsoluteLayout',
	DockLayout: 'org.nativescript.widgets.DockLayout',
	WrapLayout: 'org.nativescript.widgets.WrapLayout',
	FlexboxLayout: 'org.nativescript.widgets.FlexboxLayout',
	ContentView: 'org.nativescript.widgets.ContentLayout',
	WebView: 'android.webkit.WebView',
	View: 'android.view.View',
};

/**
 * @nativescript/core's API as kit-android offers it. A core class is the kit
 * class of the same name; a member the kit declares is used as it is, a view
 * property the kit applies by name (`text`, `color`) is set and read through
 * `set`/`get`, and anything else stops the build with the file and line.
 */
export class CoreKotlin extends KitTypes implements KotlinCore {
	private t: Translator;

	constructor(t: Translator) {
		super(kotlinKitIndex(kitSources(t.config.adapter.kit)));
		this.t = t;
	}

	/** A kit property's value or method's result the kit holds nullable, read where core's typings say present. */
	kitNil(x: ts.Expression): boolean {
		try {
			x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
			const access = ts.isCallExpression(x) ? x.expression : x;
			if (ts.isOptionalChain(x) || !ts.isPropertyAccessExpression(access)) return false;
			const owner = this.ownerOf(access.expression, access.name);
			const m = owner && kitMember(this.index, owner.name, this.kitName(owner.name, access.name.text));
			if (!m || m.kind !== (ts.isCallExpression(x) ? 'func' : 'var')) return false;
			const k = m.type.trim();
			return k.endsWith('?') && (!isUntyped(spelledType(k)) || !isUntyped(spelledType(this.t.typeOf(x)))) && !functionTypeParts(k.replace(/^\((.*)\)\?$/, '$1'));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	}

	/** A core module's variable the app imports by name (`_rootModalViews` of ui/core/view): its module object's. */
	coreVariable(e: ts.Identifier): string | null {
		const sym = this.t.resolve(e);
		const decl = sym?.declarations?.[0];
		if (!sym || !(sym.flags & ts.SymbolFlags.Variable) || !isCoreDeclaration(decl) || kitMember(this.index, TOP_LEVEL, sym.name)) return null;
		const module = this.moduleObject(decl!);
		const m = module ? kitMember(this.index, module, sym.name) : null;
		if (m?.kind !== 'var') return null;
		const code = `${module}.${sym.name}`;
		const p = e.parent;
		const written = (ts.isBinaryExpression(p) && p.left === e && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken));
		// Read as the app's declarations type it (`_rootModalViews`, `JSArray<ViewBase>?` in the kit).
		return written ? code : this.fromKit(code, m.type, this.t.typeOf(e), keepsNullable(e));
	}

	/** The kit's view classes a page's XML can name (`Label`, `StackLayout`). */
	kitElements(): string[] {
		return [...this.index.keys()].filter((n) => kitExtends(this.index, n, 'ViewBase'));
	}

	/** The generated kit's object for a core module (`Connectivity` of `export * as Connectivity` is `Core_connectivity_index`). */
	private moduleObject(decl: ts.Node): string | null {
		const file = decl.getSourceFile().fileName.replace(/\\/g, '/');
		const rel = /[\/]@nativescript[\/]core[\/](.*)$/.exec(file)?.[1] ?? /[\/]packages[\/]core[\/](.*)$/.exec(file)?.[1];
		if (!rel) return null;
		const name = 'Core_' + rel.replace(/(\.(ios|android))?(\.d)?\.ts$/, '').replace(/[^A-Za-z0-9]+/g, '_');
		return this.index.has(name) ? name : null;
	}

	/** The generated kit: a core interface it has no class for (`PanGestureEventData`, `PromptResult`) is a plain object, untyped. */
	type(t: ts.Type): string | null {
		const sym = t.aliasSymbol ?? t.getSymbol();
		// An event's data beyond EventData's (`PanGestureEventData`, a ListView's item tap): the object core notifies with, read by name.
		if (sym && sym.name !== 'EventData' && !(sym.flags & ts.SymbolFlags.TypeParameter) && t.getProperty('eventName') && t.getProperty('object') && t.getProperties().length > 2) return 'Any?';
		if (!sym || !isCoreDeclaration(sym.declarations?.[0])) return null;
		if (sym.flags & ts.SymbolFlags.Class) {
			const kit = this.kitClass(sym.name);
			return kit === (KIT_NAMES_ANDROID[sym.name] ?? sym.name) ? null : kit;
		}
		if (!(sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) return null;
		// A function type's alias (`ModuleListProvider`) types as the function, which the kit's signatures declare too.
		if (sym.flags & ts.SymbolFlags.TypeAlias && t.getCallSignatures().length === 1 && !t.getProperties().length) return null;
		return this.index.has(KIT_NAMES_ANDROID[sym.name] ?? sym.name) ? null : 'Any?';
	}

	nested(name: string): boolean {
		return !!this.index.get(name)?.outer;
	}

	/** The kit's class of core's class `name` (`ViewBase` is `View`; see `coreClass`). */
	kitClass(name: string): string {
		if (Object.hasOwn(KIT_NAMES_ANDROID, name)) return KIT_NAMES_ANDROID[name];
		return coreClass(this.index, name);
	}

	kitExtends(name: string, base: string): boolean {
		return kitExtends(this.index, name, base);
	}

	/** The class of the native view `view.android` (`nativeView`) holds, when the kit view's class says. */
	nativeClassOf(e: ts.Expression): string | null {
		if (!ts.isPropertyAccessExpression(e) || !NATIVE_MEMBERS.has(e.name.text)) return null;
		let name: string | null | undefined = this.owner(e.expression)?.name;
		while (name) {
			const type = this.index.get(name);
			if (type?.native) return type.native;
			name = type?.base;
		}
		return null;
	}

	owner(e: ts.Expression): { name: string; isStatic: boolean } | null {
		const found = this.declaredOwner(e);
		if (!found) return found;
		const name = coreClass(this.index, found.name);
		return name === found.name ? found : { ...found, name };
	}

	/** A class the generated kit renames for a clash (`Source` of utils/debug-source is `Source__debug_source`), that has `member`. */
	private renamedOwner(owner: { name: string; isStatic: boolean }, member?: string): { name: string; isStatic: boolean } | null {
		const renamed = [...this.index.keys()].filter((k) => k.startsWith(`${owner.name}__`) && (!member || !!kitMember(this.index, k, member)));
		return renamed.length === 1 ? { ...owner, name: renamed[0] } : null;
	}

	private declaredOwner(e: ts.Expression): { name: string; isStatic: boolean } | null {
		const c = this.t.checker;
		// A namespace core nests in a static owner (`Utils.layout`, `Application.android`) is the kit object `UtilsLayout`.
		if (ts.isPropertyAccessExpression(e) && (ts.isIdentifier(e.expression) || ts.isPropertyAccessExpression(e.expression))) {
			const outer = this.owner(e.expression);
			const nested = outer?.isStatic ? outer.name + e.name.text[0].toUpperCase() + e.name.text.slice(1) : '';
			if (nested && this.index.has(nested)) return { name: nested, isStatic: true };
		}
		// A core namespace re-exported by another module (`Utils.layout`): the generated kit's object for it.
		if (ts.isPropertyAccessExpression(e)) {
			const sym = this.aliased(e.name);
			const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
			if (sym && sym.flags & ts.SymbolFlags.ValueModule && isCoreDeclaration(decl)) {
				const module = (this.index.get(sym.name) as (KitType & { object?: boolean }) | undefined)?.object ? sym.name : this.moduleObject(decl!);
				if (module) return { name: module, isStatic: true };
			}
		}
		if (ts.isIdentifier(e)) {
			const sym = this.t.resolve(e);
			const decl = sym?.declarations?.[0];
			if (sym && isCoreDeclaration(decl) && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.ValueModule | ts.SymbolFlags.Variable)) {
				if (sym.flags & ts.SymbolFlags.ValueModule) {
					// A namespace core declares (`knownFolders`): the kit's object of that name.
					const value = sym.valueDeclaration ?? decl!;
					if (ts.isModuleDeclaration(value) && (this.index.get(sym.name) as (KitType & { object?: boolean }) | undefined)?.object) return { name: sym.name, isStatic: true };
					const module = this.moduleObject(value);
					return { name: module ?? e.text, isStatic: true };
				}
				if (sym.flags & ts.SymbolFlags.Class) return { name: sym.name, isStatic: true };
				if (this.index.has(sym.name)) return { name: sym.name, isStatic: true };
				// A module's constant object of its own functions (`Dialogs = { alert, confirm, … }`): the module's object, which has them.
				const value = sym.valueDeclaration;
				const functionsOnly = (n: ts.TypeLiteralNode) => n.members.every((m) => ts.isMethodSignature(m) || (ts.isPropertySignature(m) && !!m.type && (ts.isFunctionTypeNode(m.type) || ts.isTypeQueryNode(m.type))));
				if (value && ts.isVariableDeclaration(value) && (value.initializer ? ts.isObjectLiteralExpression(value.initializer) && value.initializer.properties.every(ts.isShorthandPropertyAssignment) : !!value.type && ts.isTypeLiteralNode(value.type) && functionsOnly(value.type))) {
					const module = this.moduleObject(value);
					if (module) return { name: module, isStatic: true };
				}
				// Any other constant object core exports (`Device`, `platformNames`): the kit's top-level value, an object of its class.
				// Only where the class has every member the typings declare: one it lacks is the object's own, read by name.
				const held = kitMember(this.index, TOP_LEVEL, sym.name)?.type.trim().replace(/\?$/, '');
				if (
					held &&
					this.index.has(held) &&
					c
						.getTypeAtLocation(e)
						.getProperties()
						.every((p) => kitMember(this.index, held, p.name))
				)
					return { name: held, isStatic: false };
			}
			if (sym && sym.flags & ts.SymbolFlags.Alias) return null;
		}
		let type = c.getNonNullableType(c.getTypeAtLocation(e));
		// `View & { extra?: … }`: the core class.
		if (type.isIntersection()) type = type.types.find((u) => (u.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class && isCoreDeclaration(u.getSymbol()?.declarations?.[0])) ?? type;
		const sym = type.getSymbol();
		const mixin = this.t.mixinOf(sym);
		if (mixin) return { name: mixin, isStatic: false };
		// An interface extending a core class (`interface MenuView extends View`): that class.
		if (sym && sym.flags & ts.SymbolFlags.Interface && !isCoreDeclaration(sym.declarations?.[0]) && type.isClassOrInterface()) {
			const base = c
				.getBaseTypes(type as ts.InterfaceType)
				.map((b) => b.getSymbol())
				.find((b) => b && b.flags & ts.SymbolFlags.Class && isCoreDeclaration(b.declarations?.[0]));
			if (base) return { name: KIT_NAMES_ANDROID[base.name] ?? base.name, isStatic: false };
		}
		if (!sym || !isCoreDeclaration(sym.declarations?.[0])) return null;
		if (this.t.type(type, e) === 'EventData') return null;
		// A module's default export class (`AbortSignal`): its declared name.
		const decl = sym.valueDeclaration;
		const name = sym.name === 'default' && decl && ts.isClassDeclaration(decl) && decl.name ? decl.name.text : sym.name;
		// The generated kit holds a core interface it has no class for (`PromptResult`) as a plain object: read as script reads it.
		if (isUntyped(spelledType(this.type(type))) || (!(sym.flags & ts.SymbolFlags.Class) && !this.index.has(KIT_NAMES_ANDROID[name] ?? name))) return null;
		return { name: KIT_NAMES_ANDROID[name] ?? name, isStatic: false };
	}

	private aliased(n: ts.Node): ts.Symbol | undefined {
		const c = this.t.checker;
		const sym = c.getSymbolAtLocation(n);
		return sym && sym.flags & ts.SymbolFlags.Alias ? c.getAliasedSymbol(sym) : sym;
	}

	/**
	 * The owner of `target.name`, where a module object lacks a member another module declares and it re-exports
	 * (`Utils.android` of utils/index is utils/native-helper's): that module's object.
	 */
	private ownerOf(target: ts.Expression, name: ts.MemberName): { name: string; isStatic: boolean } | null {
		let owner = isMixinOwnMember(name, this.t.checker, (s) => this.t.mixinOf(s)) ? null : (this.owner(target) ?? this.inheritedOwner(target, name));
		if (owner && !kitMember(this.index, owner.name, name.text)) owner = this.renamedOwner(owner, name.text) ?? owner;
		if (!owner || !owner.isStatic || !owner.name.startsWith('Core_') || kitMember(this.index, owner.name, name.text)) return owner;
		// A namespace core's declarations give where its platform file declares a class of statics (`AndroidHelper`): the class.
		const ns = this.aliased(ts.isPropertyAccessExpression(target) ? target.name : (target as ts.Identifier));
		if (ns && ns.flags & ts.SymbolFlags.ValueModule && kitMember(this.index, ns.name, name.text)) return { name: ns.name, isStatic: true };
		// A member a barrel's declarations give that one of the package's modules implements (`Utils.executeOnMainThread`, utils/common's).
		const family = owner.name.replace(/_index$/, '_');
		const found = [...this.index.keys()].filter((k) => k.startsWith(family) && kitMember(this.index, k, name.text)?.static);
		if (found.length === 1) return { name: found[0], isStatic: true };
		const sym = this.aliased(name);
		const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
		const module = decl && isCoreDeclaration(decl) ? this.moduleObject(decl) : null;
		return module && kitMember(this.index, module, name.text) ? { name: module, isStatic: true } : owner;
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

	/**
	 * `on`/`off`/`once` with a named function: a function value made once per
	 * evaluation has no identity across them, so the kit matches a listener by
	 * key, here the declaration the function comes from.
	 */
	private listenerArgs(e: ts.CallExpression, m: KitMember): string[] | null {
		const name = (e.expression as ts.PropertyAccessExpression).name.text;
		if (!['on', 'once', 'off', 'addEventListener', 'removeEventListener'].includes(name) || !/\bkey: Any\?/.test(m.params ?? '')) return null;
		const [event, callback, thisArg] = e.arguments;
		if (!event || !callback) return null;
		const t = this.t;
		const sym = ts.isIdentifier(callback) || ts.isPropertyAccessExpression(callback) ? t.resolve(ts.isIdentifier(callback) ? callback : callback.name) : undefined;
		const decl = sym?.valueDeclaration;
		const named = decl && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || (ts.isPropertyDeclaration(decl) && !!decl.initializer && ts.isArrowFunction(decl.initializer)) || (ts.isVariableDeclaration(decl) && !!(decl.parent.flags & ts.NodeFlags.Const) && !!decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))));
		const key = named ? kotlinString(`${decl!.getSourceFile().fileName.split('/').pop()}:${decl!.getStart()}`) : 'null';
		// The key goes in the `key` parameter; any between (`once` of addEventListener) take their defaults.
		const params = splitTopLevel(m.params ?? '');
		const at = params.findIndex((p) => /^key\s*:/.test(p));
		const between = params.slice(3, at).map((p) => /=\s*(.+)$/.exec(p)?.[1].trim() ?? 'null');
		return [t.str(event), t.coerce(callback, '(EventData) -> Unit'), thisArg ? t.coerce(thisArg, 'Any?') : 'null', ...between, key];
	}

	/** The generated kit's name for a method named as a property's JVM accessor (`getRootView` beside `rootView` is `getRootView_`; kotlin/translator.ts' methodIdent). */
	private kitName(owner: string, name: string): string {
		if (kitMember(this.index, owner, name) || !/^(get|set|is)[A-Z]/.test(name)) return name;
		return kitMember(this.index, owner, `${name}_`) ? `${name}_` : name;
	}

	private member(owner: string, name: string, e: ts.Node): KitMember {
		const m = kitMember(this.index, owner, name);
		if (!m) throw this.t.error(e, `${owner}.${name} (kit-android has no such member)`);
		return m;
	}

	private isViewProperty(owner: string, name: string): boolean {
		// A style property applies to any view; the kit's classes each apply their own.
		if (owner === 'Style') return [...this.index.values()].some((t) => kitExtends(this.index, t.name, 'View') && t.props.has(name));
		for (let t = this.index.get(owner); t; t = t.base ? this.index.get(t.base.replace(/\(.*$/, '')) : undefined) if (t.props.has(name)) return true;
		return false;
	}

	/** `object.name` of an `augmentedProperty` on a core-typed object, outside a chain: the read of its own property (`Any?`), or null. */
	augmentedRead(e: ts.PropertyAccessExpression): string | null {
		if (ts.isOptionalChain(e) || this.constant(e) !== null) return null;
		const owner = this.ownerOf(e.expression, e.name);
		const view = !!owner && this.isView(owner.name);
		if (!owner || owner.isStatic || (view && this.isViewProperty(owner.name, e.name.text))) return null;
		if (!augmentedProperty(this.index, owner.name, e.name, this.t.resolve(e.name))) return null;
		// The generated kit's views keep what they have no field for by name (`property`'s view branch).
		return `${this.receiver(e.expression, e)}.${view ? 'get' : 'jsGet'}(${kotlinString(e.name.text)})`;
	}

	property(e: ts.PropertyAccessExpression): string | null {
		const constant = this.constant(e);
		if (constant !== null) return constant;
		const owner = this.ownerOf(e.expression, e.name);
		if (!owner) return null;
		const t = this.t;
		const name = this.kitName(owner.name, e.name.text);
		const recv = owner.isStatic ? this.declaring(owner.name, e.name.text) : this.receiver(e.expression, e);
		// The other platform's native view: undefined, as on Android.
		if (!owner.isStatic && name === 'ios' && this.isView(owner.name)) return 'null';
		// The generated kit: `android` of a class that types it as a kit object (Frame's `AndroidFrame`): that member.
		const ownAndroid = name === 'android' ? kitMember(this.index, owner.name, name) : null;
		if (ownAndroid && this.index.has(ownAndroid.type.replace(/\?$/, '')) && !owner.isStatic) return this.fromKit(`${recv}.android`, ownAndroid.type, t.typeOf(e), t.nullTolerant(e));
		if (!owner.isStatic && NATIVE_MEMBERS.has(name) && this.isView(owner.name)) {
			const native = t.typeOf(e);
			return isUntyped(spelledType(native)) ? `${recv}.nativeView` : `(${recv}.nativeView as ${native})`;
		}
		// A view narrowed to another class as well (`headerView instanceof Label` of a StackLayout): that class's member.
		const type = !owner.isStatic && !kitMember(this.index, owner.name, name) ? t.checker.getTypeAtLocation(e.expression) : undefined;
		const narrowed = type?.isIntersection() ? type.types.map((x) => x.getSymbol()?.name).find((n) => !!n && n !== owner.name && !!kitMember(this.index, n, name)) : undefined;
		if (narrowed) return this.fromKit(`(${recv} as ${narrowed}).${name}`, kitMember(this.index, narrowed, name)!.type, t.typeOf(e), t.nullTolerant(e));
		if (!owner.isStatic && this.isView(owner.name) && !kitMember(this.index, owner.name, name)) {
			// The kit is core: a member it has no field for is one core keeps by name (`onAccessibilityPerformEscape`).
			return t.fromAnyCode(`${recv}.get(${JSON.stringify(name)})`, t.typeOf(e), true);
		}
		// A member the kit's class has not, read in an optional chain (`container?.stabilizeLayout?.()`, an iOS API): undefined, as script finds none.
		if (!kitMember(this.index, owner.name, name) && (e.questionDotToken || (ts.isCallExpression(e.parent) && e.parent.expression === e && !!e.parent.questionDotToken))) {
			return `${RT.jsGetIfPresent}(${t.coerce(e.expression, 'Any?')}, ${kotlinString(e.name.text)})`;
		}
		if (!owner.isStatic && (ownPropertyOnly(this.index, owner.name, e.name, t.resolve(e.name)) || augmentedProperty(this.index, owner.name, e.name, t.resolve(e.name)))) {
			if (e.questionDotToken || ts.isOptionalChain(e)) throw t.error(e, `${owner.name}.${name} in an optional chain`);
			return t.fromAnyCode(`${recv}.jsGet(${kotlinString(name)})`, t.typeOf(e), true);
		}
		const m = this.member(owner.name, name, e);
		// A method read as a value (`typeof view.getSafeAreaInsets === 'function'`): bound to its object.
		// A method as a value; read through `?.` (`child?.getChildAt`), undefined where the receiver is.
		if (m.kind === 'func' && !(ts.isCallExpression(e.parent) && e.parent.expression === e)) {
			// A static method is its class's companion's: `ColorBase::equals` would be Any's instance `equals`, and the companion's
			// own reference is ambiguous with it: a function calling it.
			if (owner.isStatic && ['equals', 'hashCode', 'toString'].includes(name)) {
				const arity = t.checker.getTypeAtLocation(e).getCallSignatures()[0]?.parameters.length ?? 0;
				const ps = Array.from({ length: arity }, (_, k) => `__s${k}`);
				return `{ ${ps.map((p) => `${p}: Any?`).join(', ')} -> ${recv}.${name}(${ps.join(', ')}) }`;
			}
			// A kit method with non-null Kotlin default parameters (e.g. `flags: Double = 2.0`) where TS types the parameter optional (`Double?`):
			// a method reference drops the default and keeps non-null `Double`, so wrap in a lambda that forwards the default.
			const parsedParams = (m.params ?? '').trim()
				? splitTopLevel(m.params!).map((p) => {
						const hit = /^([^:]+):\s*(.+?)(?:\s*=\s*(.+))?$/.exec(p.trim());
						return hit ? { type: hit[2].trim(), def: hit[3]?.trim() } : null;
					})
				: [];
			const tsParts = functionTypeParts(t.typeOf(e).replace(/^\((.*)\)\?$/, '$1'));
			if (tsParts && parsedParams.length === tsParts.params.length && parsedParams.every(Boolean) && parsedParams.some((p, k) => p!.def && !p!.type.endsWith('?') && tsParts.params[k].endsWith('?'))) {
				const ps = tsParts.params.map((pt, k) => `__p${k}: ${pt}`);
				const callArgs = parsedParams.map((p, k) => (p!.def && !p!.type.endsWith('?') && tsParts.params[k].endsWith('?') ? `(__p${k} ?: ${p!.def})` : `__p${k}`));
				const call = (r: string) => `{ ${ps.join(', ')} -> ${r}.${name}(${callArgs.join(', ')}) }`;
				if (owner.isStatic) return call(recv);
				return recv.endsWith('?') ? `${recv.slice(0, -1)}?.let { __r -> ${call('__r')} }` : `(${recv}).let { __r -> ${call('__r')} }`;
			}
			// A Kotlin object's own function is referenced on the object; a class's static, on its companion.
			if (owner.isStatic) return (this.index.get(owner.name) as (KitType & { object?: boolean }) | undefined)?.object ? `${recv}::${name}` : `${recv}.Companion::${name}`;
			return recv.endsWith('?') ? `${recv.slice(0, -1)}?.let { __r -> __r::${name} }` : `${recv}::${name}`;
		}
		return this.fromKit(`${recv}.${name}`, m.type, t.typeOf(e), t.nullTolerant(e) || t.states.nilKept(e) || keepsNullable(e));
	}

	/** A core-typed receiver's code: unwrapped where it is nullable and the access is not an optional one (code checked without strictNullChecks). */
	private receiver(target: ts.Expression, access: ts.PropertyAccessExpression): string {
		const code = this.t.expr(target);
		if (code === 'super' || code === 'this') return code;
		const key = access.name.text;
		const write = ts.isBinaryExpression(access.parent) && access.parent.left === access && access.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && access.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
		if (this.t.isAsserted(code)) return this.t.present(code, key, target, write);
		// A core variable the kit holds nullable until core sets it (`Application`).
		// Imported under another name (`android as androidApp`), it is read by its own.
		const top = ts.isIdentifier(target) && code === this.t.resolve(target)?.name && isCoreDeclaration(this.t.resolve(target)?.declarations?.[0]) ? kitMember(this.index, TOP_LEVEL, code) : null;
		if (top?.type.endsWith('?')) return access.questionDotToken ? `${code}?` : this.t.present(code, key, target, write);
		// One the kit holds present (`Device`), whatever the declarations type it.
		if (top?.kind === 'var' && !access.questionDotToken) return code;
		const nullable = this.t.typeOf(target).endsWith('?');
		if (access.questionDotToken || (access.flags & ts.NodeFlags.OptionalChain && nullable)) return `${code}?`;
		return nullable ? this.t.present(code, key, target, write) : code;
	}

	/** A constant core declares with a literal type (`CoreTypes.AnimationCurve.easeIn` is "easeIn"), as that literal. */
	private constant(e: ts.PropertyAccessExpression): string | null {
		const decl = this.t.resolve(e.name)?.declarations?.[0];
		if (!decl || !isCoreDeclaration(decl) || !ts.isVariableDeclaration(decl) || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
		const type = this.t.checker.getTypeAtLocation(decl);
		if (type.isStringLiteral()) return kotlinString(type.value);
		if (type.isNumberLiteral()) return numberLiteral(String(type.value));
		return null;
	}

	lvalue(e: ts.PropertyAccessExpression): string | null {
		const owner = this.ownerOf(e.expression, e.name);
		if (!owner) return null;
		const m = kitMember(this.index, owner.name, e.name.text);
		return m ? `${owner.isStatic ? this.declaring(owner.name, e.name.text) : this.receiver(e.expression, e)}.${e.name.text}` : null;
	}

	assign(left: ts.PropertyAccessExpression, value: ts.Expression): string | null {
		const owner = this.ownerOf(left.expression, left.name);
		if (!owner) return null;
		const t = this.t;
		const name = left.name.text;
		const recv = owner.isStatic ? this.declaring(owner.name, left.name.text) : this.receiver(left.expression, left);
		if (!owner.isStatic && this.isView(owner.name) && !kitMember(this.index, owner.name, name)) {
			return `${recv}.set(${JSON.stringify(name)}, ${t.coerce(value, 'Any?')})`;
		}
		if (!owner.isStatic && (ownPropertyOnly(this.index, owner.name, left.name, t.resolve(left.name)) || augmentedProperty(this.index, owner.name, left.name, t.resolve(left.name)))) return `${recv}.jsSet(${kotlinString(name)}, ${t.coerce(value, 'Any?')})`;
		const m = this.member(owner.name, name, left);
		// Null or undefined for a member the kit types non-null (`label.text = null`): set by name, as script sets it.
		const unset = value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined');
		if (unset && !m.type.trim().endsWith('?') && !owner.isStatic) return `${RT.jsSet}(${recv}, ${kotlinString(name)}, null)`;
		if (unset && m.type.trim().endsWith('?') && !isUntyped(spelledType(m.type.trim()))) return `${recv}.${name} = null`;
		// A kit member typed `Any?` holds what core reads as a plain script object (`TouchManager.animations`).
		if (isUntyped(spelledType(m.type.trim()))) return `${recv}.${name} = ${this.scriptValue(value)}`;
		return `${recv}.${name} = ${this.toKit(t.coerce(value, t.typeOf(left)), m.type)}`;
	}

	call(e: ts.CallExpression): string | null {
		if (ts.isIdentifier(e.expression)) return this.topLevelCall(e, e.expression);
		if (!ts.isPropertyAccessExpression(e.expression)) return null;
		// A factory in a core namespace is the kit class it builds.
		if (e.expression.getText() === 'CoreTypes.AnimationCurve.cubicBezier' && isCoreDeclaration(this.t.resolve(e.expression.name)?.declarations?.[0])) {
			return `CubicBezierAnimationCurve(${e.arguments.map((a) => this.t.coerce(a, 'Double')).join(', ')})`;
		}
		const owner = this.ownerOf(e.expression.expression, e.expression.name);
		if (!owner) return null;
		const t = this.t;
		const name = this.kitName(owner.name, e.expression.name.text);
		// A method the app's own type adds to a core class (`View & { addChild(view): void }`): called by name, as script calls it.
		const declarations = t.checker.getSymbolAtLocation(e.expression.name)?.declarations ?? [];
		const declared = declarations[0];
		if (!owner.isStatic && !kitMember(this.index, owner.name, name) && addedDeclarations(declarations)) {
			const call = `${RT.jsCallMethod}(${t.expr(e.expression.expression)}, ${kotlinString(e.expression.name.text)}${e.arguments.map((a) => `, ${t.coerce(a, 'Any?')}`).join('')})`;
			return ts.isExpressionStatement(e.parent) ? call : t.fromAnyCode(call, t.typeOf(e), true);
		}
		// An optional call of a method the kit's class has not (`container?.stabilizeLayout?.()`, an iOS API): undefined, as script finds none.
		if (!kitMember(this.index, owner.name, name) && e.questionDotToken) {
			const key = kotlinString(e.expression.name.text);
			return `run { val __o: Any? = ${t.coerce(e.expression.expression, 'Any?')}; if (${RT.jsIsNullish}(__o) || ${RT.jsIsNullish}(${RT.jsGet}(__o, ${key}))) null else ${RT.jsCallMethod}(__o, ${key}${e.arguments.map((a) => `, ${t.coerce(a, 'Any?')}`).join('')}) }`;
		}
		const m = this.member(owner.name, name, e.expression);
		// A static method called through a class held as a value (`Utils.Source.get`, a namespace's class): the class's.
		const staticCall = !!declared && ts.isClassElement(declared) && !!(ts.getCombinedModifierFlags(declared as ts.Declaration) & ts.ModifierFlags.Static);
		const recv = owner.isStatic || staticCall ? this.declaring(owner.name, name) : this.receiver(e.expression.expression, e.expression);
		if (name === 'navigate' && kitExtends(this.index, owner.name, 'Frame')) return this.navigate(recv, e);
		// A method core assigns as a bound function (`read = this.readSync.bind(this)`), which the kit holds untyped: called as script calls it.
		if (m.kind === 'var' && /^Any\??$/.test(m.type.trim())) {
			const call = `${RT.jsCall}(${recv}.${name}${e.arguments.map((a) => `, ${t.coerce(a, 'Any?')}`).join('')})`;
			return ts.isExpressionStatement(e.parent) ? call : t.fromAnyCode(call, t.typeOf(e), true);
		}
		const listener = this.listenerArgs(e, m);
		const args = listener ?? this.restArgs(e, m) ?? (SCRIPT_OBJECTS.has(name) && this.isView(owner.name) ? e.arguments.map((a) => this.scriptValue(a)) : this.kitArgs(e, m, t.args(e)));
		// A function held in a field (`Application.off`, core's bound `globalEvents.off`) takes every parameter: those not given are undefined.
		const held = m.kind === 'var' ? functionTypeParts(m.type.replace(/^\((.*)\)\?$/, '$1')) : null;
		if (held) for (let k = args.length; k < held.params.length; k++) args.push('null');
		// A super call names every argument: Kotlin does not fill in defaults there.
		if (recv === 'super') {
			const params = (m.params ?? '').trim() ? splitTopLevel(m.params!) : [];
			for (let k = args.length; k < params.length; k++) args.push(/=\s*(.+)$/.exec(params[k])?.[1].trim() ?? 'null');
		}
		// A function held in a field the kit declares nullable (`CssAnimationProperty.register`): present where it is called.
		const callee = held && /\)\?$/.test(m.type.trim()) ? `(${recv}.${name} ?: ${RT.jsNotAFunction}(${kotlinString(e.expression.getText().replace(/\s+/g, ''))}))` : `${recv}.${name}`;
		return this.fromKit(`${callee}(${args.join(', ')})`, m.type, t.typeOf(e), keepsNullable(e) || t.states.nilKept(e) || t.nullOk.has(e));
	}

	construct(e: ts.NewExpression): string | null {
		const resolved = this.t.resolve(e.expression);
		if (!resolved || !isCoreDeclaration(resolved.declarations?.[0])) return null;
		const t = this.t;
		const args = e.arguments ?? ts.factory.createNodeArray();
		// A module's default export (`import AbortController from '@nativescript/core/abortcontroller'`): its class's name.
		const declared = resolved.name === 'default' && resolved.valueDeclaration && ts.isClassDeclaration(resolved.valueDeclaration) ? resolved.valueDeclaration.name?.text : undefined;
		const sym = declared ? ({ ...resolved, name: declared } as ts.Symbol) : resolved;
		const kitName = this.kitClass(sym.name);
		if (!this.index.has(kitName)) throw t.error(e, `new ${sym.name} (kit-android has no such class)`);
		if (sym.name === 'Color') return `Color(${RT.jsArrayOf}<Any?>(${args.map((a) => t.coerce(a, 'Any?')).join(', ')}))`;
		if (sym.name === 'Color') {
			if (args.length === 1 && t.typeOf(args[0]) === 'String') return `Color.js(${t.expr(args[0])})`;
			if (args.length === 1) return `Color(${t.toNumber(args[0])}.toLong().toInt())`;
			return `Color.argb(${args
				.slice(0, 4)
				.map((a) => t.toNumber(a))
				.join(', ')})`;
		}
		if (sym.name === 'Animation') return `Animation(${args.map((a) => this.scriptValue(a)).join(', ')})`;
		const made = this.index.get(kitName);
		const packed = args.length || !made?.members.has('<init0>') ? made?.members.get('<init>')?.[0] : undefined;
		// A class nested in a namespace's object (`Trace.DefaultErrorHandler`): named through it.
		const qualified = made?.outer ? `org.nativescript.kit.${made.outer}.${kitName}` : kitName;
		if (packed) return `${qualified}(${this.t.packed(args, 'JSArray<Any?>')})`;
		const ctor = made?.members.get('<ctor>')?.find((m) => splitTopLevel(m.params ?? '').filter((x) => x.trim()).length >= args.length);
		return `${qualified}(${(this.restArgs(e) ?? (ctor ? this.kitArgs(e, ctor, t.args(e)) : t.args(e))).join(', ')})`;
	}

	/** The generated kit: the class declaring a static member (`Frame.topmost` is FrameBase's), as Kotlin's companions are not inherited. */
	private declaring(type: string, name: string): string {
		let found = type;
		for (let k = this.index.get(type); k; k = k.base ? this.index.get(k.base) : undefined)
			if (k.members.has(name)) {
				found = k.name;
				break;
			}
		// A namespace's object (`layout`, `knownFolders`) is named as a member of the code using it may be.
		const outer = this.index.get(found)?.outer;
		if (outer) return `org.nativescript.kit.${outer}.${found}`;
		return /^[a-z]/.test(found) ? `org.nativescript.kit.${found}` : found;
	}

	/** The generated kit: a core function taking `...args` takes them as one array, as core's compiled signature does. */
	private restArgs(e: ts.CallExpression | ts.NewExpression, m?: KitMember): string[] | null {
		const decl = this.t.checker.getResolvedSignature(e)?.getDeclaration();
		const params = decl && !ts.isJSDocSignature(decl) ? decl.parameters : undefined;
		// Core's typings may declare overloads where its implementation takes `...args` (`prompt`): the kit's signature says.
		const restInKit = !!m && /^\s*(args|__arguments)\s*:\s*JSArray<Any\?>\s*$/.test(m.params ?? '');
		if (!restInKit && (!params || params.length !== 1 || !params[0].dotDotDotToken)) return null;
		// A rest parameter overriding fixed ones (`showModal(...args)` over `showModal(view, options)`): the kit's fixed ones.
		const spread = !!e.arguments?.some(ts.isSpreadElement);
		if (!restInKit && !spread && m?.params?.trim() && m.params.split(',').length >= (e.arguments?.length ?? 0)) return e.arguments!.map((a) => this.t.coerce(a, 'Any?'));
		if (spread) return [this.t.packed(e.arguments!, /^\s*\w+\s*:\s*(JSArray<[^,]*>)\s*$/.exec(m?.params ?? '')?.[1] ?? 'JSArray<Any?>')];
		const element = /^\s*\w+\s*:\s*JSArray<([^,]*)>\s*$/.exec(m?.params ?? '')?.[1] ?? 'Any?';
		return [`${RT.jsArrayOf}<${element}>(${(e.arguments ?? []).map((a) => this.t.coerce(a, element)).join(', ')})`];
	}

	/** A function core exports (`getRootLayout()`) that the kit declares at top level. */
	private topLevelCall(e: ts.CallExpression, callee: ts.Identifier): string | null {
		const sym = this.t.resolve(callee);
		const decl = sym?.declarations?.[0];
		if (!isCoreDeclaration(decl)) return null;
		// The function's own name, where the app imports it under another (`isDefined as __types_isDefined`).
		const name = sym && sym.name !== 'default' ? sym.name : callee.text;
		const m = kitMember(this.index, TOP_LEVEL, name);
		// The generated kit: a function of a module the app imports by path (`resolveModuleName` of module-name-resolver), its module's object's.
		const module = !m && decl ? this.moduleObject(decl) : null;
		const mm = module ? kitMember(this.index, module, name) : undefined;
		if (module && mm) return this.fromKit(`${module}.${name}(${(this.restArgs(e, mm) ?? this.kitArgs(e, mm, this.t.args(e))).join(', ')})`, mm.type, this.t.typeOf(e), keepsNullable(e));
		if (!m) return null;
		return this.fromKit(`${name}(${(this.restArgs(e, m) ?? this.kitArgs(e, m, this.t.args(e))).join(', ')})`, m.type, this.t.typeOf(e), keepsNullable(e));
	}

	/**
	 * The generated kit: arguments the kit's signature types otherwise than core's declarations (`eachChildView`'s callback of
	 * `ViewCommon`, declared of `View`): a function adapted to the kit's parameters; a string, number or boolean where the kit
	 * takes another of them converted as script converts it (core's code takes what script passes).
	 */
	private kitArgs(e: ts.CallExpression | ts.NewExpression, m: KitMember, args: string[]): string[] {
		if (!m.params?.trim()) return args;
		const types = splitTopLevel(m.params).map((p) => /^\s*(?:vararg\s+)?[\w`]+\s*:\s*(.+?)(?:\s+=\s+.+)?$/.exec(p)?.[1]?.trim());
		const PRIMITIVES = ['String', 'Double', 'Boolean'];
		return args.map((code, k) => {
			const a = e.arguments?.[k],
				want = types[k];
			if (!a || !want || ts.isSpreadElement(a)) return code;
			const have = this.t.typeOf(a);
			// A string, number or boolean parameter the kit takes nullable takes undefined as it is, as core's code does.
			const held = want.endsWith('?') && have === want.slice(0, -1) ? this.t.undefinedConverted(code) : null;
			if (held) return held;
			const fn = (x: string) => functionTypeParts(x.replace(/^\((.*)\)\?$/, '$1'));
			const [f, g] = [fn(have), fn(want)];
			if (f && g && f.params.length <= g.params.length && (f.params.length < g.params.length || f.params.some((p, i) => p !== g.params[i]))) return this.t.coerce(a, want);
			const bare = want.replace(/\?$/, '');
			// Core's declarations may type a parameter `any` that its implementation, and so the kit, types (`new ImageAsset(asset: any)`).
			if (isUntyped(spelledType(have)) && PRIMITIVES.includes(bare)) return this.t.coerce(a, want);
			if (PRIMITIVES.includes(have) && PRIMITIVES.includes(bare) && have !== bare) {
				const value = this.t.expr(a);
				return bare === 'String' ? `${RT.jsToString}(${value})` : bare === 'Double' ? `${RT.jsToNumber}(${value})` : `${RT.jsTruthy}(${value})`;
			}
			return code;
		});
	}

	/**
	 * The generated kit: a subclass's `super(…)` arguments for the kit class's constructor. An argument Kotlin holds nullable
	 * where the constructor's parameter is not takes the parameter's default when undefined, as script's does (`duration = 350`).
	 */
	superArgs(base: string, e: ts.CallExpression, args: string[]): string[] {
		const ctors = (this.index.get(base)?.members.get('<ctor>') ?? []).map((m) => splitTopLevel(m.params ?? '').filter((x) => x.trim()));
		const ctor = ctors.find((ps) => ps.length >= args.length);
		if (!ctor) return args;
		return args.map((code, k) => {
			const m = /^\s*(?:vararg\s+)?[\w`]+\s*:\s*(.+?)(?:\s+=\s+(.+))?$/.exec(ctor[k]);
			const a = e.arguments[k];
			if (!m || !a || m[1].endsWith('?') || !this.t.typeOf(a).endsWith('?')) return code;
			if (m[2]) heldLoss('kitDefault', m[2].trim(), { node: a });
			return m[2] ? `(${code} ?: ${m[2].trim()})` : code;
		});
	}

	/** `frame.navigate({ create: () => page })`: the kit builds what `create` returns. */
	private navigate(recv: string, e: ts.CallExpression): string {
		const entry = e.arguments[0];
		// Core's own Frame takes any entry (`{ moduleName }`, a page module's name), as it does in JavaScript.
		if (entry && !(ts.isObjectLiteralExpression(entry) && entry.properties.length === 1 && ts.isPropertyAssignment(entry.properties[0]) && entry.properties[0].name.getText() === 'create')) {
			return `${recv}.navigate(${this.t.coerce(entry, 'Any?')})`;
		}
		if (!entry || !ts.isObjectLiteralExpression(entry)) throw this.t.error(e, 'frame.navigate with anything but a { create } entry');
		for (const p of entry.properties) if (p.name?.getText() !== 'create') throw this.t.error(p, `the navigation entry's ${p.name?.getText()}`);
		const create = entry.properties[0];
		if (!create || !ts.isPropertyAssignment(create)) throw this.t.error(entry, 'a navigation entry without create');
		return `${recv}.navigate(JSObject("create" to ${RT.jsFunction} { (${this.t.expr(create.initializer)})() }))`;
	}

	/**
	 * An argument core reads as a plain script object (an animation definition):
	 * literals become JavaScript objects and arrays, whatever their declared type.
	 */
	private scriptEntry(p: ts.ObjectLiteralElementLike): string {
		if (ts.isPropertyAssignment(p)) return `${kotlinString(p.name.getText().replace(/^['"]|['"]$/g, ''))} to ${this.scriptValue(p.initializer)}`;
		if (ts.isShorthandPropertyAssignment(p)) return `${kotlinString(p.name.text)} to ${this.t.coerce(p.name, 'Any?')}`;
		throw this.t.error(p, 'this member in an animation definition');
	}

	private scriptValue(e: ts.Expression): string {
		if (ts.isObjectLiteralExpression(e)) {
			// `{ ...base, duration: 150 }`: the spread object's keys, then the literal's, in order.
			if (e.properties.some(ts.isSpreadAssignment)) {
				const parts = e.properties.map((p) => (ts.isSpreadAssignment(p) ? this.t.coerce(p.expression, 'Any?') : `JSObject(${this.scriptEntry(p)})`));
				return `${RT.jsObjectAssign}(JSObject(), ${parts.join(', ')})`;
			}
			return `JSObject(${e.properties.map((p) => this.scriptEntry(p)).join(', ')})`;
		}
		if (ts.isArrayLiteralExpression(e)) return `JSArray<Any?>(listOf(${e.elements.map((x) => this.scriptValue(x)).join(', ')}))`;
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
			// A function core calls back (`closeCallback`) takes script values.
			const names = e.parameters.map((_, i) => `__a${i}`);
			const args = e.parameters.map((p, i) => this.t.fromAnyCode(names[i], this.t.typeOf(p)));
			return `{ ${names.map((n) => `${n}: Any?`).join(', ')} -> (${this.t.expr(e)})(${args.join(', ')}); null }`;
		}
		return this.t.coerce(e, 'Any?');
	}

	/**
	 * A kit value as the TypeScript type reads it: kit Ints and Floats are Doubles.
	 * An object only tested or dropped stays nullable: core declares some results non-null that are not.
	 */
	private fromKit(code: string, kitType: string, tsType: string, keepNull = false): string {
		const k = kitType.trim();
		const numeric = /^(Int|Long|Float|Short|Byte)\??$/.exec(k);
		if (numeric && tsType.startsWith('Double')) return k.endsWith('?') ? `${code}?.toDouble()` : `${code}.toDouble()`;
		// A subclass core's declarations give where its base declares the member (`Frame.topmost(): Frame`, FrameBase's).
		const kb = k.replace(/\?$/, ''),
			tb = tsType.replace(/\?$/, '');
		if (kb === 'Any' && ['String', 'Double', 'Boolean'].includes(tb)) return this.t.fromAnyCode(code, tsType, true);
		// An untyped result where the program's own class is declared (`getViewById` of an app's view): that class, as script trusts it.
		if (kb === 'Any' && tb !== 'Any' && ((/^[A-Z][\w.]*$/.test(tb) && !this.index.has(tb)) || /^JS(Array|Record)</.test(tb))) return this.t.unchecked(tsType, code);
		// A function of the kit's generics erased (`lazy`'s `() -> Any?`) where TypeScript names its types: as it names them.
		const isFn = (x: string) => !!functionTypeParts(x.replace(/^\((.*)\)\?$/, '$1'));
		if (kb !== tb && isFn(k) && isFn(tsType) && !tsType.endsWith('?')) return this.t.unchecked(tsType, code);
		// An untyped result where TypeScript names a function (`profile(name, fn)`): callable as that function.
		if (kb === 'Any' && isFn(tsType)) return this.t.fromAnyCode(code, tsType, true);
		// One array of the kit's where TypeScript names another element class (`Frame._stack()`, FrameBase's).
		if (/^JSArray<.*>$/.test(kb) && /^JSArray<.*>$/.test(tb) && kb !== tb) return this.t.unchecked(tsType, code);
		if (kb !== tb && this.index.has(tb) && (kb === 'Any' || kitExtends(this.index, tb, kb))) return k.endsWith('?') && (tsType.endsWith('?') || keepNull) ? safeCast(code, tb) : `(${code} as ${tb})`;
		if (k.endsWith('?') && !tsType.endsWith('?') && !isUntyped(spelledType(tsType))) {
			const zero = tsType === 'String' ? '""' : tsType === 'Double' ? '0.0' : tsType === 'Boolean' ? 'false' : null;
			return zero ? (heldLoss('kitResult', zero, { native: !!this.t.native }), `(${code} ?: ${zero})`) : keepNull ? code : this.t.asserted(code);
		}
		return code;
	}

	private toKit(code: string, kitType: string): string {
		const k = kitType.replace(/\?$/, '');
		const conversions: Record<string, string> = { Int: 'toInt', Long: 'toLong', Float: 'toFloat', Short: 'toShort', Byte: 'toByte' };
		return conversions[k] ? `(${code}).${conversions[k]}()` : code;
	}
}

/** Whether `e`'s value is only tested (a condition, the operand of `!`), asserted nullable, optional-chained, coalesced, or dropped. */
function keepsNullable(e: ts.Expression): boolean {
	let n: ts.Node = e;
	while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
	const p = n.parent;
	return (
		ts.isExpressionStatement(p) ||
		((ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)) && nullableTypeNode(p.type)) ||
		(ts.isConditionalExpression(p) && p.condition === n) ||
		(ts.isIfStatement(p) && p.expression === n) ||
		(ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) ||
		(ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && p.left === n) ||
		((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === n && !!p.questionDotToken)
	);
}

/**
 * What kit-android's build compiles: the generated code, src/fromcore, src/main (the runtime and the hand-written files
 * the generated code calls), and the build's adapter's Kotlin for it (`adapter`).
 */
export function kitSources(adapter: Readonly<AdapterKit>): string[] {
	const { android, androidGenerated } = adapter;
	return [join(KIT_ANDROID, 'generated/kotlin'), join(KIT_ANDROID, 'src/fromcore/kotlin'), ...(androidGenerated ? [androidGenerated] : []), KIT, ...(android ? [android] : [])];
}
