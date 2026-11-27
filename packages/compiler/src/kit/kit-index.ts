import { adapterRuntimeFiles, mergedManifest, paramsText, readKitManifest, runtimeFiles, runtimeSurface, type KitManifest, type ManifestMember } from './manifest.ts';

/** A public member of a kit type, as the kit declares it. */
export interface KitMember {
	kind: 'var' | 'func' | 'init' | 'subscript' | 'case';
	static: boolean;
	/** The declared Swift type of a property, or the result of a function. */
	type: string;
	/** A function's parameter list as Swift writes it (labels and types). */
	params?: string;
	/** A function or initializer declared `throws`, or a property whose getter is. */
	throws?: boolean;
	/** The iOS version the member needs. */
	available?: string;
	/** A top-level function or variable core's index exports, which the kit forwards to its module. */
	exported?: boolean;
}

export interface KitType {
	name: string;
	base: string | null;
	members: Map<string, KitMember[]>;
	/** NativeScript property names the type applies by name: the `case` labels of its setProperty, shorthands, and names it reads back (`applied["src"]`). */
	props: Set<string>;
	/** The class of the native view a kit view creates (Android: `createNativeView(): NativeView = VerticalScrollView(…)`), fully qualified. */
	native?: string;
	/** Declared by the kit, not only extended by it (`extension UIView`). */
	declared?: boolean;
	/** Kotlin: the object or class declaring it, for a nested one (`Trace` of `Trace.categories`). */
	outer?: string;
	/** Generated from @nativescript/core, not only the kit's hand-written runtime. */
	core?: boolean;
	/** A class the kit declares open (Swift `open`, Kotlin `open` or `abstract`): one an app may subclass. */
	open?: boolean;
}

/** The top-level functions and variables of the kit, as the pseudo-type of this name. */
export const KIT_GLOBALS = '';

/**
 * What NativeScriptKit offers translated code: each public type, the type it extends, and its public members. The
 * translator checks @nativescript/core members against it, so an app using something the kit lacks stops with the
 * file and line instead of failing in the Swift compiler. Read from the kit's manifest, with the build's adapter's
 * part (`adapterApple`, its Swift's folder); while the kit is generated (or before it ever was), from the hand-written
 * runtime's Swift alone, less `exclude`: the hand-written files the generated code replaces.
 */
export function kitIndex(kitSources: string, adapterApple: string | undefined, exclude: RegExp | null = null): Map<string, KitType> {
	const manifest = (!exclude && readKitManifest(kitSources, adapterApple)) || mergedManifest({ types: {}, globals: {} }, runtimeSurface(kitSources, [...runtimeFiles(kitSources, exclude), ...adapterRuntimeFiles(adapterApple)]));
	return manifestIndex(manifest);
}

const indexes = new WeakMap<KitManifest, Map<string, KitType>>();

export function manifestIndex(manifest: KitManifest): Map<string, KitType> {
	const cached = indexes.get(manifest);
	if (cached) return cached;
	const types = new Map<string, KitType>();
	const member = (m: ManifestMember): KitMember => ({ kind: m.kind, static: !!m.static, type: m.type, ...(m.params ? { params: paramsText(m.params) } : {}), ...(m.throws ? { throws: true } : {}), ...(m.available ? { available: m.available } : {}), ...(m.exported ? { exported: true } : {}) });
	for (const [name, t] of Object.entries(manifest.types)) {
		if (t.alias) continue;
		types.set(name, { name, base: t.base ?? null, members: new Map(Object.entries(t.members).map(([k, v]) => [k, v.map(member)])), props: new Set(t.names ?? []), ...(t.kind !== 'extension' ? { declared: true } : {}), ...(t.origin === 'core' ? { core: true } : {}), ...(t.open ? { open: true } : {}) });
	}
	for (const [name, t] of Object.entries(manifest.types)) if (t.alias && types.has(t.alias)) types.set(name, types.get(t.alias)!);
	types.set(KIT_GLOBALS, { name: KIT_GLOBALS, base: null, members: new Map(Object.entries(manifest.globals).map(([k, v]) => [k, v.map(member)])), props: new Set() });
	indexes.set(manifest, types);
	return types;
}

/** Property names a kit class reads from its own stored values (`applied["src"]`, `get("dateStyle")`) or tests for (`name == "orientation"`): a value set by name reaches them. */
export function readNames(line: string): string[] {
	return [...line.matchAll(/(?<![\w.?])(?:self\.|this\.)?(?:(?:applied|locals)\["(\w+)"\]|get\("(\w+)"\))|\bname\s*==\s*"(\w+)"/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/**
 * The kit's class of core's class `name`: the type of that name when core's, else the one class the generated kit
 * names apart by its file (`Source__debug_source`, as the hand-written runtime has a `Source`).
 */
export function coreClass(index: Map<string, KitType>, name: string): string {
	if (index.get(name)?.core) return name;
	const renamed = [...index.keys()].filter((k) => k.startsWith(`${name}__`) && !k.includes('.') && index.get(k)!.core);
	return renamed.length === 1 ? renamed[0] : name;
}

/** A member of `type` or of a type it extends. */
export function kitMember(index: Map<string, KitType>, type: string, name: string): KitMember | null {
	for (let t = index.get(type); t; t = t.base ? index.get(t.base) : undefined) {
		const found = t.members.get(name);
		if (found) return found[0];
	}
	return null;
}

/** Whether `type` is `base` or extends it. */
export function kitExtends(index: Map<string, KitType>, type: string, base: string): boolean {
	for (let t = index.get(type); t; t = t.base ? index.get(t.base) : undefined) if (t.name === base) return true;
	return false;
}

/** The questions both backends ask of their kit's type index; each backend's core API extends it. */
export class KitTypes {
	protected readonly index: Map<string, KitType>;

	constructor(index: Map<string, KitType>) {
		this.index = index;
	}

	/** Whether the kit declares a type of this name. */
	has(name: string): boolean {
		return this.index.has(name);
	}

	/** Whether the kit's class of this name views any object as one of it (`Size.jsView`): a result interface of core's. */
	viewable(name: string): boolean {
		return !!this.index
			.get(name)
			?.members.get('jsView')
			?.some((m) => m.static);
	}

	/** Whether the kit declares a class of this name open, for an app's class to extend. */
	subclassable(name: string): boolean {
		return !!this.index.get(name)?.open;
	}

	/** Whether a kit type is a view (extends View). */
	isKitView(name: string): boolean {
		return kitExtends(this.index, name, 'View');
	}

	/** Whether the kit applies `name` by name on this view class (a property in its setProperty). */
	protected isViewProperty(owner: string, name: string): boolean {
		if (owner === 'Style') return [...this.index.values()].some((t) => kitExtends(this.index, t.name, 'View') && t.props.has(name));
		for (let t = this.index.get(owner); t; t = t.base ? this.index.get(t.base.replace(/\(.*$/, '')) : undefined) if (t.props.has(name)) return true;
		return false;
	}

	/** A view, or a view's `style`: properties by name. */
	protected isView(owner: string): boolean {
		return owner === 'Style' || kitExtends(this.index, owner, 'View');
	}

	/** A member of a kit type or a type it extends, as the kit declares it. */
	kitMember(owner: string, name: string): KitMember | null {
		return kitMember(this.index, owner, name);
	}

	/** The kit's final copy of a method, as the nearest type declaring it has it (see `nonVirtualEntry` in semantics/translator-methods.ts). */
	nonVirtualEntry(type: string, name: string): string | null {
		for (let t = this.index.get(type); t; t = t.base ? this.index.get(t.base) : undefined) {
			if (t.members.has(name)) return [...t.members.keys()].find((k) => k.startsWith(`${name}__`) && t!.members.get(k)!.some((m) => m.kind === 'func' && !m.static)) ?? null;
		}
		return null;
	}
}
