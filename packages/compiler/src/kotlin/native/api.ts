import ts from 'typescript';
import { ACC_BRIDGE, ACC_FINAL, ACC_STATIC, ACC_SYNTHETIC, methodTypes, type ClassPath, type JavaClass } from './classfiles.ts';
import { ANDROID_TYPINGS, type Callable, type Extension } from './bridging.ts';
import type { KotlinNative, Translator } from '../translator.ts';
import { nativeTypesMethods } from './types.ts';
import { nativeMembersMethods } from './members.ts';
import { nativeCallsMethods } from './calls.ts';
import { nativeOverloadsMethods } from './overloads.ts';
import { nativeConversionsMethods } from './conversions.ts';
import { nativeSubclassesMethods } from './subclasses.ts';
import { nativeExtendMethods } from './extend.ts';
import { rethrowUnlessRefused } from '../../semantics/refusals.ts';

/**
 * Direct calls to Android APIs, as NativeScript apps write them in TypeScript
 * (`new android.content.Intent(android.content.Intent.ACTION_SEND)`,
 * `drawable.setCornerRadius(8)`), as Kotlin calling Java: the name is
 * the class's dotted name, the overload is chosen from the class files by the
 * arguments' TypeScript types, and numbers convert to the Java primitive the
 * parameter takes and back to Double. Interfaces implemented from object
 * literals become object expressions, and `@NativeClass()` classes extending
 * a Java class become Kotlin subclasses overriding with Java's signatures.
 */
export class AndroidNativeAPI implements KotlinNative {
	t: Translator;
	readonly classpath: ClassPath;
	symbols = new Map<ts.Symbol, JavaClass | null>();

	constructor(t: Translator, classpath: ClassPath) {
		this.t = t;
		this.classpath = classpath;
	}

	/** Typings files plugins keep beside their source (`typings/android.d.ts`), declaring their Java classes. */
	readonly pluginTypings = new Set<string>();

	isNativeDeclaration(d: ts.Node): boolean {
		const file = d.getSourceFile().fileName;
		return ANDROID_TYPINGS.test(file) || this.pluginTypings.has(file);
	}

	/**
	 * Whether a typings declaration's Java binding holds null: a field's value, a method's result, a parameter's argument.
	 * Java's reference types are platform types, null unless annotated `@NonNull`; its primitives never are.
	 */
	holdsNil(d: ts.Declaration): boolean {
		const param = ts.isParameter(d) ? d : null;
		const member = param ? param.parent : d;
		const k = param ? (member as ts.SignatureDeclaration).parameters.indexOf(param) : -1;
		const primitive = (desc: string) => /^[BCDFIJSZV]$/.test(desc);
		try {
			const owner = member.parent,
				name = (member as ts.NamedDeclaration).name;
			const sym = ts.isClassDeclaration(owner) && owner.name ? this.t.checker.getSymbolAtLocation(owner.name) : undefined;
			const cls = sym && name && ts.isIdentifier(name) ? this.classOf(sym) : null;
			if (cls && name && ts.isIdentifier(name)) {
				const isStatic = !!(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static);
				const supers = this.classpath.supertypes(cls.name);
				if (ts.isPropertyDeclaration(member)) {
					const f = supers.flatMap((c) => c.fields).find((x) => x.name === name.text && !!(x.access & ACC_STATIC) === isStatic);
					// A static final field is set once, as its class loads: a constant or a platform singleton, never null in practice.
					if (f) return !primitive(f.descriptor) && !f.nonNull && !(isStatic && f.access & ACC_FINAL);
				} else if (ts.isMethodDeclaration(member)) {
					const arity = member.parameters.length;
					const found = supers
						.flatMap((c) => c.methods)
						.filter((m) => m.name === name.text && !!(m.access & ACC_STATIC) === isStatic)
						.map((m) => ({ m, ...methodTypes(m.descriptor) }))
						.filter((c) => c.params.length === arity);
					if (found.length) return found.some((c) => (k < 0 ? !primitive(c.ret) && !c.m.nonNull : !primitive(c.params[k]) && !c.m.nonNullParams?.[k]));
				}
			}
		} catch (e) {
			rethrowUnlessRefused(e);
			// A class no Android version has: the typings' type says whether it is a reference.
		}
		const c = this.t.checker;
		const sig = !param && ts.isFunctionLike(member) ? c.getSignatureFromDeclaration(member as ts.SignatureDeclaration) : undefined;
		const t = sig ? sig.getReturnType() : c.getTypeAtLocation(param ?? (member as ts.NamedDeclaration).name ?? member);
		return !(c.getNonNullableType(t).flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never));
	}

	isValueType(_t: string): boolean {
		return false;
	}

	hidden: boolean | undefined;

	programAndroid: boolean | undefined;

	namesRead: Set<string> | null = null;

	/**
	 * The Java methods a TypeScript method overrides. Library mode: each overload its parameters fit, as NativeScript's runtime
	 * routes every overload of the name to the one function (`onReceivedError` of WebViewClient's two signatures).
	 */
	overrideTargets(fn: ts.SignatureDeclaration, classes: string[], name: string, every = !!this.t.library): Callable[] {
		const all = this.overridable(classes, name);
		if (!all.length) {
			const final = this.methods(classes, name, false).find((c) => c.m.access & ACC_FINAL);
			if (final) throw this.t.error(fn, `${name} (overrides the final Java method ${this.display(final.m.owner, name, final)})`, 'native');
			return [];
		}
		// A rest parameter takes every overload's arguments.
		if (every && fn.parameters.length === 1 && fn.parameters[0].dotDotDotToken) return all;
		const arity = fn.parameters.length;
		const exact = all.filter((c) => c.params.length === arity);
		const pool = exact.length ? exact : all.filter((c) => c.params.length > arity);
		if (pool.length === 1) return [pool[0]];
		const kinds = fn.parameters.map((p) => this.kindOfType(this.t.checker.getTypeAtLocation(p.name), p));
		const fits = pool.filter((c) => kinds.every((k, i) => k.kind === 'any' || this.score(k, c.params[i]) !== null));
		if (fits.length === 1 || (every && fits.length)) return fits;
		if (fits.length > 1) {
			const nonBridge = fits.filter((c) => !(c.m.access & (ACC_BRIDGE | ACC_SYNTHETIC)));
			if (nonBridge.length === 1) return nonBridge;
			const concrete = (nonBridge.length ? nonBridge : fits).filter((c) => !c.params.some((p) => p === 'Ljava/lang/Object;'));
			if (concrete.length === 1) return concrete;
		}
		throw this.t.error(fn, `${name} (matches ${pool.map((c) => this.display(c.m.owner, name, c)).join(' and ')}; declare its parameter types)`, 'native');
	}

	/** What `Base.extend({ … })` calls make (extend.ts), by call and by the variable holding one, and the files scanned for them. */

	extensions = new Map<ts.CallExpression, Extension | null>();
	extensionOwners = new Map<ts.VariableDeclaration, Extension>();
	scanned = new Set<ts.SourceFile>();
}
type Mixins = typeof nativeTypesMethods & typeof nativeMembersMethods & typeof nativeCallsMethods & typeof nativeOverloadsMethods & typeof nativeConversionsMethods & typeof nativeSubclassesMethods & typeof nativeExtendMethods;
export interface AndroidNativeAPI extends Mixins {}
for (const methods of [nativeTypesMethods, nativeMembersMethods, nativeCallsMethods, nativeOverloadsMethods, nativeConversionsMethods, nativeSubclassesMethods, nativeExtendMethods]) Object.defineProperties(AndroidNativeAPI.prototype, Object.getOwnPropertyDescriptors(methods));
