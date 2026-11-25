// The members of Java classes: fields, methods and constructors, read from the class files.
import ts from 'typescript';
import { ACC_ABSTRACT, ACC_BRIDGE, ACC_PRIVATE, ACC_PROTECTED, ACC_PUBLIC, ACC_STATIC, ACC_SYNTHETIC, javaTypeName, methodTypes, type JavaClass, type JavaMember } from './classfiles.ts';
import type { AndroidNativeAPI } from './api.ts';
import { CONVERT, NUMERIC, extensionClasses, skipCasts, type Callable } from './bridging.ts';
import { cast, ident, lambda, RT } from '../syntax.ts';
import { reassigned } from '../../semantics/nullish.ts';

export const nativeMembersMethods = {
	sharedClass(this: AndroidNativeAPI, from: string, to: string): string | null {
		const internal = (n: string) => n.replace(/\./g, '/');
		if (!this.classpath.get(internal(to)) || this.classpath.distance(internal(from), internal(to)) !== null) return null;
		for (let c = this.classpath.get(internal(from)); c?.superName; c = this.classpath.get(c.superName)) {
			if (this.classpath.distance(internal(to), c.superName) !== null) return javaTypeName(`L${c.superName};`);
		}
		return null;
	},

	isClassAlias(this: AndroidNativeAPI, d: ts.VariableDeclaration): boolean {
		if (ts.isObjectBindingPattern(d.name)) return d.name.elements.length > 0 && d.name.elements.every((el) => !!this.destructuredClass(el));
		return this.nativeAlias(d) || !!this.extensionOf(d) || !!this.prototypeOf(d);
	},

	/** `const { AudioTrack } = android.media`: the Java class the name takes from its package. */
	destructuredClass(this: AndroidNativeAPI, el: ts.BindingElement): ts.Symbol | undefined {
		const d = el.parent.parent;
		if (el.dotDotDotToken || !ts.isObjectBindingPattern(el.parent) || !ts.isVariableDeclaration(d) || !(d.parent.flags & ts.NodeFlags.Const) || !d.initializer) return undefined;
		const pkg = this.t.resolve(skipCasts(d.initializer));
		const key = el.propertyName ?? el.name;
		if (!pkg || !(pkg.flags & ts.SymbolFlags.Namespace) || !this.isNativeSymbol(pkg) || !ts.isIdentifier(key)) return undefined;
		const member = this.t.checker.tryGetMemberInModuleExports(key.text, pkg);
		return member && member.flags & ts.SymbolFlags.Class && this.isNativeSymbol(member) ? member : undefined;
	},

	/** `const superProto = androidx.fragment.app.Fragment.prototype`: the Java class whose methods it holds. */
	prototypeOf(this: AndroidNativeAPI, d: ts.VariableDeclaration): JavaClass | null {
		const init = d.initializer && skipCasts(d.initializer);
		if (!init || !ts.isPropertyAccessExpression(init) || init.name.text !== 'prototype') return null;
		return this.untypedClass(init.expression) ?? this.classOf(this.classSymbol(init.expression), init.expression);
	},

	/**
	 * `superProto.onCreate` in a method of a Java subclass: a function calling the superclass's method (the overload of
	 * the enclosing method's arity when it is that one), taking `this` and script's arguments as `fn.call(this, …)` gives them.
	 */
	superMethodValue(this: AndroidNativeAPI, e: ts.PropertyAccessExpression, base: JavaClass): string {
		const name = e.name.text;
		const candidates = this.methods([base.name], name, false).filter((c) => !(c.m.access & ACC_ABSTRACT));
		const fn = ts.findAncestor(e.parent, (n) => ts.isFunctionLike(n) && !ts.isArrowFunction(n)) as ts.FunctionLikeDeclaration | undefined;
		const own = fn && (ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) ? (ts.isMethodDeclaration(fn) ? fn.name.getText() : ts.isPropertyAssignment(fn.parent) ? fn.parent.name.getText() : '') : '';
		const chosen = (own === name ? candidates.find((c) => c.params.length === fn!.parameters.length) : undefined) ?? (candidates.length === 1 ? candidates[0] : (candidates.find((c) => c.params.length === (fn?.parameters.length ?? 0)) ?? candidates[0]));
		this.used(chosen.m);
		if (!chosen) throw this.t.error(e, `${javaTypeName(`L${base.name};`)}.${name} (no Java method of that name to call as super)`, 'native');
		const args = chosen.params.map((desc, k) => {
			const a = `__a.getOrNull(${k})`;
			if (NUMERIC.has(desc)) return `${RT.jsToNumber}(${a})${CONVERT[desc]}`;
			if (desc === 'Z') return `${RT.jsTruthy}(${a})`;
			if (desc === 'C') return `${RT.jsToString}(${a})[0]`;
			return cast(`${RT.jsJavaArgument}(${a})`, `${this.kotlinType(desc, 'Any?')}${chosen.m.nonNullParams?.[k] ? '' : '?'}`);
		});
		const zuper = this.t.thisAlias ? `super@${ts.findAncestor(e, ts.isClassLike)?.name?.text ?? ''}` : 'super';
		const call = `${zuper}.${ident(name)}(${args.join(', ')})`;
		return `JSMethod ${lambda(['_', '__a'], chosen.ret === 'V' ? `${call}; null` : call)}`;
	},

	nativeAlias(this: AndroidNativeAPI, d: ts.VariableDeclaration): boolean {
		if (!ts.isIdentifier(d.name)) return false;
		// `let PageLayout: typeof com.nativescript.gesturehandler.PageLayout`, assigned the class before use.
		if (d.type && ts.isTypeQueryNode(d.type)) {
			const sym = this.t.resolve(d.type.exprName);
			return !!sym && !!(sym.flags & ts.SymbolFlags.Class) && this.isNativeSymbol(sym);
		}
		// `const Intent = android.content.Intent`, or a `let` nothing assigns again.
		if (!d.initializer || (!(d.parent.flags & ts.NodeFlags.Const) && reassigned(d, this.t.checker))) return false;
		let init: ts.Expression = d.initializer;
		while (ts.isParenthesizedExpression(init)) init = init.expression;
		if (!ts.isPropertyAccessExpression(init) && !ts.isIdentifier(init)) return false;
		const sym = this.t.resolve(init);
		return (!!sym && !!(sym.flags & ts.SymbolFlags.Class) && this.isNativeSymbol(sym)) || !!this.untypedClass(init);
	},

	/** The class symbol a class alias names. */
	aliasedClass(this: AndroidNativeAPI, d: ts.VariableDeclaration): ts.Symbol | undefined {
		return d.type && ts.isTypeQueryNode(d.type) ? this.t.resolve(d.type.exprName) : this.t.resolve(d.initializer!);
	},

	/**
	 * A Java class named through a package root code declares untyped
	 * (`declare const org: any; new org.nativescript.menu.GlassAnchoredMenuController(ctx)`):
	 * the class the dotted name is on the classpath, as the runtime resolves it.
	 */
	untypedClass(this: AndroidNativeAPI, e: ts.Expression): JavaClass | null {
		const segs: string[] = [];
		let x: ts.Expression = e;
		// `(<any>org).example.plugin.Asset`, `(<any>android.provider).DocumentsContract`: a package read untyped.
		let cast = false;
		for (;;) {
			if (ts.isPropertyAccessExpression(x)) {
				segs.unshift(x.name.text);
				x = x.expression;
				continue;
			}
			if (!ts.isParenthesizedExpression(x) && !ts.isAsExpression(x) && !ts.isTypeAssertionExpression(x)) break;
			if (!ts.isParenthesizedExpression(x)) cast ||= !!(this.t.checker.getTypeAtLocation(x).flags & ts.TypeFlags.Any);
			x = x.expression;
		}
		if (!ts.isIdentifier(x)) return null;
		const root = this.t.resolve(x);
		// `const DocumentsContract = (<any>android.provider).DocumentsContract`: the alias names the class.
		const alias = root?.valueDeclaration;
		if (alias && ts.isVariableDeclaration(alias) && alias.initializer && this.isClassAlias(alias)) {
			const base = this.untypedClass(alias.initializer);
			return base && segs.length ? (this.classpath.get(`${base.name}$${segs.join('$')}`) ?? null) : base;
		}
		if (!segs.length) return null;
		const decl = root?.valueDeclaration;
		const nativeRoot = cast && !!root?.declarations?.length && root.declarations.every((d) => this.isNativeDeclaration(d));
		const ambient = nativeRoot || (decl && ts.isVariableDeclaration(decl) && !decl.initializer && !!(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient));
		// Library mode and plugins: a Java class the typings lack (`org.nativescript.widgets.Async.File`), found on the classpath, as
		// NativeScript's runtime finds it. A plugin's own typings are a type-check aid its package may not carry (an ignored `typings/`).
		const lenient = this.t.library || this.t.pluginFiles.has(e.getSourceFile().fileName);
		const nativePackage = !root || (!!(root.flags & ts.SymbolFlags.Namespace) && !!root.declarations?.every((d) => this.isNativeDeclaration(d)));
		const missing = lenient && nativePackage && !this.t.resolve(e) && !(ts.isPropertyAccessExpression(e) && this.t.resolve(e.name));
		if (!missing && !nativeRoot && (!ambient || !(this.t.checker.getTypeAtLocation(x).flags & ts.TypeFlags.Any))) return null;
		segs.unshift(x.text);
		for (let k = segs.length - 1; k >= 1; k--) {
			const found = this.classpath.get(`${segs.slice(0, k).join('/')}/${segs.slice(k).join('$')}`);
			if (found) return found;
		}
		return null;
	},

	/** The class symbol an expression names, through a class alias. */
	classSymbol(this: AndroidNativeAPI, e: ts.Expression): ts.Symbol | undefined {
		const sym = this.t.resolve(e);
		const decl = sym?.valueDeclaration;
		if (decl && ts.isBindingElement(decl)) return this.destructuredClass(decl) ?? sym;
		return decl && ts.isVariableDeclaration(decl) && this.nativeAlias(decl) ? this.aliasedClass(decl) : sym;
	},

	/** What an expression is a Java member of: a class itself (static), or an instance of these classes. */
	receiver(this: AndroidNativeAPI, e: ts.Expression): { cls: JavaClass; isStatic: true } | { classes: string[]; isStatic: false } | null {
		const self = this.extensionOfThis(e);
		if (self) return { classes: extensionClasses(self), isStatic: false };
		const own = this.ownMember(e);
		if (own) {
			const classes = own.fn ? null : this.classesOf(this.t.checker.getTypeAtLocation(own.p.name!));
			return classes ? { classes, isStatic: false } : null;
		}
		const untyped = this.untypedClass(e);
		if (untyped) return { cls: untyped, isStatic: true };
		const sym = this.classSymbol(e);
		if (sym && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum) && this.isNativeSymbol(sym) && (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e))) {
			const cls = this.classOf(sym, e);
			if (cls) return { cls, isStatic: true };
		}
		// A namespace of functions the typings give a Java class's statics as (`org.nativescript.widgets.Async.File`): that class.
		if (sym && sym.flags & ts.SymbolFlags.Namespace && !(sym.flags & ts.SymbolFlags.Class) && this.isNativeSymbol(sym)) {
			const segs = this.t.checker.getFullyQualifiedName(sym).split('.');
			for (let k = segs.length - 1; k >= 1; k--) {
				const found = this.classpath.get(`${segs.slice(0, k).join('/')}/${segs.slice(k).join('$')}`);
				if (found) return { cls: found, isStatic: true };
			}
		}
		if (sym && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Namespace | ts.SymbolFlags.Module) && !(sym.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) && e.kind !== ts.SyntaxKind.ThisKeyword && e.kind !== ts.SyntaxKind.SuperKeyword) return null;
		const classes = this.classesOf(this.t.checker.getTypeAtLocation(e));
		return classes ? { classes, isStatic: false } : null;
	},

	field(this: AndroidNativeAPI, classes: string[], name: string, isStatic: boolean): JavaMember | null {
		for (const root of classes) {
			for (const c of this.classpath.supertypes(root)) {
				const f = c.fields.find((x) => x.name === name && !!(x.access & ACC_STATIC) === isStatic && !(x.access & ACC_PRIVATE));
				if (f) return this.used(f);
			}
		}
		return null;
	},
	/** Whether script reads a member `name` anywhere: `x.name`, `x['name']`, `{ name }` read from a value. */
	calledByName(this: AndroidNativeAPI, name: string): boolean {
		if (!this.namesRead) {
			const read = new Set<string>();
			const visit = (n: ts.Node): void => {
				if (ts.isPropertyAccessExpression(n)) read.add(n.name.text);
				else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) read.add(n.argumentExpression.text);
				else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) read.add((n.propertyName ?? n.name).getText());
				ts.forEachChild(n, visit);
			};
			for (const sf of this.t.sourceFiles) if (!sf.isDeclarationFile) visit(sf);
			this.namesRead = read;
		}
		return this.namesRead.has(name);
	},

	methods(this: AndroidNativeAPI, classes: string[], name: string, isStatic: boolean): Callable[] {
		const out: Callable[] = [];
		const seen = new Set<string>();
		for (const root of classes) {
			for (const c of this.classpath.supertypes(root)) {
				for (const m of c.methods) {
					if (m.name !== name || !!(m.access & ACC_STATIC) !== isStatic || m.access & (ACC_PRIVATE | ACC_BRIDGE | ACC_SYNTHETIC)) continue;
					if (!(m.access & (ACC_PUBLIC | ACC_PROTECTED))) continue;
					const key = m.descriptor.replace(/\).*$/, ')');
					if (seen.has(key)) continue;
					seen.add(key);
					out.push({ m, ...methodTypes(m.descriptor) });
				}
			}
		}
		return out;
	},

	constructors(this: AndroidNativeAPI, c: JavaClass): Callable[] {
		return c.methods.filter((m) => m.name === '<init>' && m.access & (ACC_PUBLIC | ACC_PROTECTED) && !(m.access & ACC_SYNTHETIC)).map((m) => ({ m, ...methodTypes(m.descriptor) }));
	},

	display(this: AndroidNativeAPI, owner: string, name: string, c: Callable): string {
		return `${name === '<init>' ? this.kotlinName(owner) : name}(${c.params.map(javaTypeName).join(', ')})`;
	},
};
