// Java classes and types as script names them: the class a TypeScript type or name is, and its Kotlin type.
import ts from 'typescript';
import { ACC_INTERFACE, type JavaClass } from './classfiles.ts';
import type { AndroidNativeAPI } from './api.ts';
import { KOTLIN_COLLECTIONS, hasStatic, matchingAngle, splitArgs, topLevelTypes } from './bridging.ts';
import { hasModifier } from '../../semantics/ast.ts';
import { isCoreDeclaration } from '../../program/core-facts.ts';
import { isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeTypesMethods = {
	isNativeSymbol(this: AndroidNativeAPI, sym: ts.Symbol | undefined): boolean {
		const d = sym?.declarations?.[0];
		return !!d && this.isNativeDeclaration(d);
	},

	/** The Java class a native TypeScript class symbol declares (`android.view.View.OnClickListener` → `android/view/View$OnClickListener`). */
	classOf(this: AndroidNativeAPI, sym: ts.Symbol | undefined, where?: ts.Node): JavaClass | null {
		// A member of an enum the typings declare (`GridUnitType.auto`) is a constant of that Java enum.
		if (sym && sym.flags & ts.SymbolFlags.EnumMember) sym = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
		if (!sym || !(sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) || !this.isNativeSymbol(sym)) return null;
		if (!this.symbols.has(sym)) {
			const segs = this.t.checker.getFullyQualifiedName(sym).split('.');
			let found: JavaClass | null = null;
			for (let k = segs.length - 1; k >= 1 && !found; k--) found = this.classpath.get(`${segs.slice(0, k).join('/')}/${segs.slice(k).join('$')}`);
			this.symbols.set(sym, found);
			// Library mode or plugin code naming another platform's class (`NativeScript.Mason.TextNode`, `MasonTextWrap`), untyped.
			if (!found && (this.t.library || this.t.pluginFiles.has(where?.getSourceFile().fileName ?? this.t.currentFile ?? ''))) return null;
			if (!found) throw this.t.error(where, `${segs.join('.')} (no class file on the classpath: android.jar, the widgets AAR, androidx in the Gradle cache)`, 'native');
		}
		return this.symbols.get(sym)!;
	},

	/** A class as a Kotlin type names it. A type's qualifier resolves to packages and classes alone, so no value named `android` hides the package. */
	kotlinName(this: AndroidNativeAPI, internal: string): string {
		if (this.classpath.get(internal)?.deprecated) this.t.noteDeprecated(internal);
		if (internal === 'java/lang/Object') return 'Any';
		if (internal === 'java/lang/String') return 'String';
		if (internal === 'java/lang/CharSequence') return 'CharSequence';
		return internal.replace(/[/$]/g, '.');
	},

	/**
	 * A class as an expression names it (`android.view.View.MeasureSpec.EXACTLY`, a constructor call, `::class.java`), whose
	 * qualifier resolves to a value named `android` before the package: rooted where one is in Kotlin's scope at `where`.
	 */
	kotlinValueName(this: AndroidNativeAPI, internal: string, where: ts.Node): string {
		return this.expressionName(this.kotlinName(internal), where);
	},

	/** `kotlinValueName` of a class Kotlin names `type`; rooted with no `where`, where a member may hide the package. */
	expressionName(this: AndroidNativeAPI, type: string, where: ts.Node | undefined): string {
		if (this.t.library || !type.startsWith('android.')) return type;
		return !where || this.androidShadowed(where) || (this.kitAndroid() && !this.hidesKitAndroid()) ? `_root_ide_package_.${type}` : type;
	},

	/** The generated kit's top-level `android` (core's `Application.android`), which the app's star import of the kit brings into every file. */
	kitAndroid(this: AndroidNativeAPI): boolean {
		return this.t.generatedKit && !!this.t.core?.kitMember('', 'android');
	},
	/**
	 * Whether the app's files import the kit's top-level `android` under another name (`withKitAndroidHidden`), so that
	 * `android` names the package: unless the program reads core's `android` export, which then has to keep its name.
	 */
	hidesKitAndroid(this: AndroidNativeAPI): boolean {
		if (this.hidden !== undefined) return this.hidden;
		if (!this.kitAndroid()) return (this.hidden = false);
		const c = this.t.checker;
		// A module-level `android` of core's read by its own name or an import's (`Utils.android`, a member, is its module's).
		const reads = (n: ts.Node): boolean => {
			if (ts.isIdentifier(n) && n.text.includes('android') && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
				let sym = c.getSymbolAtLocation(n);
				if (sym && sym.flags & ts.SymbolFlags.Alias) sym = c.getAliasedSymbol(sym);
				if (sym?.name === 'android' && sym.flags & ts.SymbolFlags.Variable && sym.declarations?.some((d) => isCoreDeclaration(d) && ts.isVariableDeclaration(d) && ts.isSourceFile(d.parent.parent.parent))) return true;
			}
			return ts.forEachChild(n, reads) ?? false;
		};
		return (this.hidden = !this.t.sourceFiles.some((sf) => !sf.isDeclarationFile && sf.text.includes('android') && reads(sf)));
	},
	/** Whether the program declares a top-level value named `android`, which the app's package has in every file. */
	programDeclaresAndroid(this: AndroidNativeAPI): boolean {
		return (this.programAndroid ??= this.t.sourceFiles.some((sf) => !sf.isDeclarationFile && sf.statements.some((st) => !(st.flags & ts.NodeFlags.Ambient) && !hasModifier(st, ts.SyntaxKind.DeclareKeyword) && ((ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'android')) || ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isModuleDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.getText() === 'android')))));
	},

	/**
	 * Whether Kotlin resolves `android` at `where` to a value of the program's: a local, parameter, import or module
	 * variable of that name, a member of an enclosing class or object literal (its implicit receiver), or a mixin's
	 * target's (core's `View.android`).
	 */
	androidShadowed(this: AndroidNativeAPI, where: ts.Node): boolean {
		const c = this.t.checker;
		if (this.programDeclaresAndroid()) return true;
		const own = c.resolveName('android', where, ts.SymbolFlags.Value, false);
		if (own?.declarations?.some((d) => !(d.flags & ts.NodeFlags.Ambient))) return true;
		for (let n: ts.Node | undefined = where; n; n = n.parent) {
			if (ts.isClassLike(n)) {
				if (ts.isClassDeclaration(n) && this.t.patterns.mixinTarget(n)) return true;
				const sym = n.name ? c.getSymbolAtLocation(n.name) : c.getTypeAtLocation(n).getSymbol();
				if (sym && (c.getPropertyOfType(c.getDeclaredTypeOfSymbol(sym), 'android') || c.getPropertyOfType(c.getTypeOfSymbolAtLocation(sym, n), 'android'))) return true;
			}
			if (ts.isObjectLiteralExpression(n)) {
				const types = [c.getTypeAtLocation(n), c.getContextualType(n)];
				if (types.some((t) => t && c.getPropertyOfType(c.getNonNullableType(t), 'android'))) return true;
			}
		}
		return false;
	},

	/** A class as Kotlin names its type (static members keep the Java name: `java.util.List.of`). */
	kotlinTypeName(this: AndroidNativeAPI, internal: string): string {
		return KOTLIN_COLLECTIONS[internal] ?? this.kotlinName(internal);
	},

	typeParamCount(this: AndroidNativeAPI, c: JavaClass | null): number {
		const sig = c?.signature;
		if (!sig?.startsWith('<')) return 0;
		let depth = 0,
			count = 0;
		for (let i = 0; i < sig.length; i++) {
			const ch = sig[i];
			if (ch === '<') depth++;
			else if (ch === '>') {
				if (--depth === 0) break;
			} else if (depth === 1 && ch === ':' && sig[i - 1] !== ':' && /[\w$]/.test(sig[i - 1])) count++;
		}
		return count;
	},

	/** A class as a Kotlin type: its dotted name, with type arguments from TypeScript's (or `star`) when it is generic. */
	classRef(this: AndroidNativeAPI, c: JavaClass, args: readonly ts.Type[] | undefined, star: string, where?: ts.Node, asType = false): string {
		const n = this.typeParamCount(c);
		const name = asType ? this.kotlinTypeName(c.name) : this.kotlinName(c.name);
		if (!n) return name;
		const bounds = this.typeParamBounds(c);
		// An untyped argument (a plugin's own type parameter) is the parameter's bound, which any argument satisfies.
		const given = (args ?? []).slice(0, n).map((a, k) => {
			const t = this.t.type(a, where);
			// `java.lang.Class<any>`: what `forName`, `getClass` give, of no class Kotlin knows.
			if (asType && isUntyped(spelledType(t)) && c.name === 'java/lang/Class') return '*';
			return isUntyped(spelledType(t)) && bounds[k] ? bounds[k]! : t;
		});
		while (given.length < n) given.push(isUntyped(spelledType(star)) && bounds[given.length] ? bounds[given.length]! : star);
		return `${name}<${given.join(', ')}>`;
	},

	/**
	 * The Kotlin types a class's type arguments give the type variables of `owner`, one of its supertypes
	 * (`MonthDayBinder<ViewContainer>` gives Binder's `Data` CalendarDay and its `Container` ViewContainer).
	 */
	supertypeVars(this: AndroidNativeAPI, cls: JavaClass, args: string[], owner: string): (name: string) => string {
		const visit = (c: JavaClass, given: string[], depth: number): { names: string[]; args: string[] } | null => {
			const names = this.typeParamNames(c);
			if (c.name === owner) return { names, args: given };
			if (depth > 12) return null;
			const sig = c.signature;
			const supers = sig ? topLevelTypes(sig.startsWith('<') ? sig.slice(matchingAngle(sig, 0) + 1) : sig) : [c.superName, ...c.interfaces].filter((n): n is string => !!n).map((n) => `L${n};`);
			const typeVar = (n: string) => given[names.indexOf(n)] ?? 'Any?';
			for (const st of supers) {
				const internal = /^L([^<;]+)/.exec(st)?.[1];
				const sc = internal ? this.classpath.get(internal) : null;
				if (!sc) continue;
				const k = this.kotlinType(st, typeVar);
				const inner = /<(.*)>$/.exec(k)?.[1];
				const found = visit(sc, inner ? splitArgs(inner).map((a) => a.replace(/^(in|out) /, '')) : [], depth + 1);
				if (found) return found;
			}
			return null;
		};
		const found = visit(cls, args, 0);
		return (n: string) => (found ? (found.args[found.names.indexOf(n)] ?? 'Any?') : 'Any?');
	},

	/** The names of a generic class's type parameters, in order. */
	typeParamNames(this: AndroidNativeAPI, c: JavaClass): string[] {
		const sig = c.signature;
		if (!sig?.startsWith('<')) return [];
		const names: string[] = [];
		let depth = 0;
		let start = 1;
		for (let i = 1; i < sig.length; i++) {
			const ch = sig[i];
			if (ch === '<') depth++;
			else if (ch === '>') {
				if (depth === 0) break;
				depth--;
			} else if (ch === ':' && depth === 0 && start >= 0) {
				names.push(sig.slice(start, i));
				start = -1;
			} else if (ch === ';' && depth === 0 && sig[i + 1] !== ':') start = i + 1;
		}
		return names;
	},

	/** Each type parameter's bound as a Kotlin type with star arguments (`<T:Lcom/…/GestureHandler;>` → `GestureHandler<*>`), or null for Object. */
	typeParamBounds(this: AndroidNativeAPI, c: JavaClass): (string | null)[] {
		const sig = c.signature;
		if (!sig?.startsWith('<')) return [];
		const out: (string | null)[] = [];
		let i = 1;
		while (sig[i] !== '>') {
			while (sig[i] !== ':') i++;
			i++;
			if (sig[i] === ':') i++;
			let depth = 0;
			const start = i;
			while (depth > 0 || sig[i] !== ';') {
				if (sig[i] === '<') depth++;
				else if (sig[i] === '>') depth--;
				i++;
			}
			const bound = sig.slice(start, i + 1);
			i++;
			while (sig[i] === ':') {
				i++;
				let d = 0;
				while (d > 0 || sig[i] !== ';') {
					if (sig[i] === '<') d++;
					else if (sig[i] === '>') d--;
					i++;
				}
				i++;
			}
			const internal = bound.replace(/<.*>/, '').slice(1, -1);
			if (internal === 'java/lang/Object') {
				out.push(null);
				continue;
			}
			const cls = this.classpath.get(internal);
			const params = cls ? this.typeParamCount(cls) : 0;
			out.push(`${this.kotlinTypeName(internal)}${params ? `<${Array(params).fill('*').join(', ')}>` : ''}`);
		}
		return out;
	},

	type(this: AndroidNativeAPI, t: ts.Type): string | null {
		if (t.isUnion()) {
			const parts = t.types.filter((u) => !(u.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
			const common = this.commonClass(parts);
			return common ? this.kotlinTypeName(common) : null;
		}
		const sym = t.aliasSymbol ?? t.getSymbol();
		if (!sym || !this.isNativeSymbol(sym)) return null;
		if (this.isJavaArray(t)) return `JSArray<${this.t.type(this.t.checker.getTypeArguments(t as ts.TypeReference)[0])}>`;
		const c = this.classOf(sym);
		if (!c) return null;
		return this.classRef(c, (t as ts.TypeReference).typeArguments, '*', undefined, true);
	},

	/** `androidNative.Array<T>`, NativeScript's type for a Java array, which translated code holds as a JSArray. */
	isJavaArray(this: AndroidNativeAPI, t: ts.Type): boolean {
		const sym = t.getSymbol();
		return !!sym && sym.name === 'Array' && this.isNativeSymbol(sym) && this.t.checker.getFullyQualifiedName(sym) === 'androidNative.Array';
	},

	/** The nearest class the Java classes of these types all extend (`StyleableTextView` and `EditText`: a `TextView`), as Kotlin names it. */
	sharedClassType(this: AndroidNativeAPI, parts: ts.Type[]): string | null {
		const names = parts.map((p) => this.classesOf(p)?.[0]);
		if (!names.length || names.some((n) => !n)) return null;
		const shared = this.classpath.supertypes(names[0]!).find((c) => !(c.access & ACC_INTERFACE) && names.every((n) => this.classpath.distance(n!, c.name) !== null));
		return shared ? this.kotlinTypeName(shared.name) : null;
	},

	/**
	 * A variable script asserts a Java class of an untyped value (`view.android as android.widget.ScrollView`), whose
	 * uses need only a class above it (`getWidth()`, a `View` parameter): that class, as Kotlin holds it, since the value
	 * may be another subclass of it (a `NestedScrollView`) where NativeScript's runtime never checks the assertion.
	 */
	assertedWiderClass(this: AndroidNativeAPI, d: ts.VariableDeclaration): string | null {
		const t = this.t;
		let init = d.initializer;
		while (init && ts.isParenthesizedExpression(init)) init = init.expression;
		if (!init || !(ts.isAsExpression(init) || ts.isTypeAssertionExpression(init)) || !ts.isIdentifier(d.name) || !isUntyped(spelledType(t.typeOf(init.expression)))) return null;
		const asserted = this.classesOf(t.checker.getTypeAtLocation(init))?.[0];
		const cls = asserted ? this.classpath.get(asserted) : null;
		if (!cls || cls.access & ACC_INTERFACE) return null;
		const sym = t.checker.getSymbolAtLocation(d.name);
		const scope = ts.findAncestor(d, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n));
		if (!sym || !scope) return null;
		const chain = this.classpath.supertypes(cls.name).filter((c) => !(c.access & ACC_INTERFACE));
		let needed = chain.length - 1;
		let ok = true;
		const need = (internal: string | undefined) => {
			const k = internal ? chain.findIndex((c) => c.name === internal) : -1;
			if (k < 0) ok = false;
			else needed = Math.min(needed, k);
		};
		const visit = (n: ts.Node): void => {
			if (!ok) return;
			if (ts.isIdentifier(n) && n !== d.name && t.checker.getSymbolAtLocation(n) === sym) {
				const p = n.parent;
				if (ts.isPropertyAccessExpression(p) && p.expression === n) {
					// The topmost class of the chain that declares the member.
					const k = [...chain.keys()].reverse().find((i) => chain[i].methods.some((m) => m.name === p.name.text) || chain[i].fields.some((f) => f.name === p.name.text));
					if (k === undefined) ok = false;
					else needed = Math.min(needed, k);
				} else if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== n) {
					const decl = t.checker.getResolvedSignature(p)?.getDeclaration();
					const k = p.arguments?.indexOf(n as ts.Expression) ?? -1;
					const param = decl && !ts.isJSDocSignature(decl) && this.isNativeDeclaration(decl) ? decl.parameters[k] : undefined;
					need(param ? this.classesOf(t.checker.getTypeAtLocation(param))?.[0] : undefined);
				} else if (!(ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) && !ts.isIfStatement(p) && !(ts.isBinaryExpression(p) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind))) ok = false;
			}
			ts.forEachChild(n, visit);
		};
		visit(scope);
		return ok && needed > 0 ? this.kotlinTypeName(chain[needed].name) : null;
	},

	/** The one class among several every other one extends (`AppCompatActivity | Activity` is an Activity). */
	commonClass(this: AndroidNativeAPI, parts: ts.Type[], seen = new Set<ts.Type>()): string | null {
		const names = parts.map((p) => this.classesOf(p, seen)?.[0]);
		if (!names.length || names.some((n) => !n)) return null;
		return names.find((c) => names.every((o) => this.classpath.distance(o!, c!) !== null)) ?? null;
	},

	/** The Java classes a TypeScript type's values are: a native class, or an app class's native base and the Java interfaces it implements. */
	classesOf(this: AndroidNativeAPI, type: ts.Type, seen = new Set<ts.Type>()): string[] | null {
		const c = this.t.checker;
		type = c.getNonNullableType(type);
		if (seen.has(type)) return null;
		seen.add(type);
		if (type.isUnion()) {
			const common = this.commonClass(type.types, seen);
			return common ? [common] : null;
		}
		// A Java class with members the app's type adds (`NumberPicker & { valueChangedListener: … }`): the class's.
		if (type.isIntersection()) {
			// `T & {}` (a type parameter made non-null) names no class: the other parts only.
			const classes = type.types.filter((x) => !(x.flags & ts.TypeFlags.TypeParameter)).flatMap((x) => this.classesOf(x, seen) ?? []);
			return classes.length ? classes : null;
		}
		const sym = type.getSymbol();
		if (!sym) return null;
		if (this.isNativeSymbol(sym)) {
			if (!(sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.EnumMember)) || this.isJavaArray(type)) return null;
			const cls = this.classOf(sym);
			return cls ? [cls.name] : null;
		}
		const decl = sym.valueDeclaration;
		if (decl && ts.isClassDeclaration(decl) && !decl.getSourceFile().isDeclarationFile) {
			const native = this.nativeHeritage(decl);
			if (native) return [native.base.name, ...native.interfaces.map((i) => i.name)];
		}
		// An interface of the program's adding fields to Java classes (`interface OwnerSeekBar extends android.widget.SeekBar`): those classes.
		const own = sym.declarations?.find((d): d is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(d) && !d.getSourceFile().isDeclarationFile);
		if (own && sym.flags & ts.SymbolFlags.Interface && !(sym.flags & ts.SymbolFlags.Class)) {
			const bases = (own.heritageClauses ?? []).flatMap((h) => h.types.map((x) => this.classesOf(c.getTypeAtLocation(x), seen) ?? []).flat());
			if (bases.length) return bases;
		}
		return null;
	},

	/** The Java class an app class extends, directly, and the Java interfaces it implements (`implements`, `static interfaces = [...]`). */
	nativeHeritage(this: AndroidNativeAPI, cls: ts.ClassDeclaration): { base: JavaClass; interfaces: JavaClass[]; listed?: ts.PropertyDeclaration } | null {
		const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		if (!heritage) return null;
		// Through a local alias of the class (`const AccessibilityDelegate = android.view.View.AccessibilityDelegate`).
		const base = this.classOf(this.t.resolve(heritage.expression), heritage) ?? (this.t.library ? (this.classOf(this.classSymbol(heritage.expression), heritage) ?? this.nestedAlias(heritage.expression)) : null);
		if (!base) return null;
		const interfaces: JavaClass[] = [];
		const add = (e: ts.Expression, skipNonNative = false) => {
			const sym = this.t.resolve(e);
			if (skipNonNative && !this.isNativeSymbol(sym)) return;
			const i = this.classOf(sym, e);
			if (!i || !(i.access & ACC_INTERFACE)) throw this.t.error(e, `${e.getText()} (not a Java interface)`, 'native');
			if (!interfaces.includes(i)) interfaces.push(i);
		};
		for (const i of cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? []) add(i.expression, true);
		const listed = cls.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && m.name.getText() === 'interfaces' && hasStatic(m));
		if (listed?.initializer && ts.isArrayLiteralExpression(listed.initializer)) for (const e of listed.initializer.elements) add(e);
		return { base, interfaces, listed };
	},
};
