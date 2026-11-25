// The members a program's classes declare as Swift: kit and program declarations, member names, redeclared and compiled members.
import ts from 'typescript';
import { ident, throwingGetter } from './syntax.ts';
import { replaceableMethod } from '../semantics/shapes.ts';
import { isStatic } from '../semantics/throws.ts';
import { accessedDeclaration, intersectionAliasMembers } from '../semantics/lang.ts';
import { hasModifier } from '../semantics/ast.ts';
import type { Translator } from './translator.ts';

export const membersMethods = {
	/** App mode: whether the program declares a top-level Swift type of this name, which hides an imported module's from every file. */
	programDeclares(this: Translator, name: string): boolean {
		if (this.library) return false;
		if (!this.programTypeNames) {
			const names = new Set<string>();
			const top = this.topNames();
			const add = (st: ts.Node, own: string) => names.add(top.get(st) ?? own);
			const visit = (statements: readonly ts.Statement[], nested: boolean) => {
				for (const st of statements) {
					if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
					if ((ts.isInterfaceDeclaration(st) || (ts.isTypeAliasDeclaration(st) && (ts.isTypeLiteralNode(st.type) || intersectionAliasMembers(st, this.checker)))) && !(this.checker.getSymbolAtLocation(st.name)!.flags & ts.SymbolFlags.Class)) add(st, st.name.text);
					if (nested) continue;
					if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) add(st, st.name.text);
					if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) add(st, st.name.text);
				}
				for (const st of statements) if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body) && !hasModifier(st, ts.SyntaxKind.DeclareKeyword)) visit(st.body.statements, true);
			};
			for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) visit(sf.statements, false);
			this.programTypeNames = names;
		}
		return this.programTypeNames.has(name);
	},
	kitTypes(this: Translator): string[] {
		return this.core.typeNames();
	},
	/** The kit's classes an XML element can name: core's views and the other objects its builder makes (`Span`, `TabViewItem`). */
	kitElements(this: Translator): string[] {
		return this.core.typeNames().filter((n) => this.core.extendsKit(n, 'ViewBase'));
	},

	declaredNullable(this: Translator, n: ts.Node): boolean {
		if (!this.library?.strict || !ts.isIdentifier(n) || !this.library.strict(n.getSourceFile().fileName)) return false;
		const d = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
		if (!d || !(ts.isVariableDeclaration(d) || ts.isParameter(d)) || !d.type || !this.library.strict(d.getSourceFile().fileName)) return false;
		const nullable = (t: ts.TypeNode): boolean => ts.isUnionTypeNode(t) && t.types.some((x) => ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword);
		return nullable(d.type);
	},

	/**
	 * A static field a class declares where a class it extends declares a static of that name
	 * (`static default = new Font()` over FontBase's): a field of its own, as JavaScript's
	 * constructors each hold theirs, which Swift's statics cannot redeclare.
	 */
	staticName(this: Translator, m: ts.ClassElement): string | null {
		const over = ts.isPropertyDeclaration(m) ? this.kitRedeclared(m) : null;
		if (over && !over.same) return `${m.name!.getText()}__${((m.parent as ts.ClassLikeDeclaration).name?.text ?? 'class').replace(/\W/g, '_')}`;
		if (!isStatic(m) || !ts.isPropertyDeclaration(m) || !m.name || ts.isComputedPropertyName(m.name) || !ts.isClassLike(m.parent)) return null;
		const name = m.name.getText();
		if (ts.isClassDeclaration(m.parent) && (this.framework.hooks.addedStatics?.(m.parent, this.pluginFiles, this.checker) ?? []).includes(name)) return `${name}__${(m.parent.name?.text ?? 'class').replace(/\W/g, '_')}`;
		for (let b = this.sourceBase(m.parent); b; b = this.sourceBase(b)) {
			if (b.members.some((x) => isStatic(x) && x.name?.getText() === name)) return `${name}__${(m.parent.name?.text ?? 'class').replace(/\W/g, '_')}`;
		}
		return null;
	},

	/** A member's Swift name as `e` reaches it: a shadowing static's own name (see `staticName`). */
	memberName(this: Translator, e: ts.PropertyAccessExpression): string {
		const decl = this.resolve(e.name)?.valueDeclaration;
		const gated = decl && this.gatedFields.get(decl);
		if (gated) this.requireAvailability(gated);
		return ident((decl && ts.isClassElement(decl) && this.staticName(decl)) || e.name.text);
	},

	/** A read's member: the throwing body of a getter that has one (`throwingBodyOf`), called, or the member. */
	readMember(this: Translator, e: ts.PropertyAccessExpression, member?: string): string {
		const get = accessedDeclaration(this.resolve(e.name));
		return get && ts.isGetAccessorDeclaration(get) && this.throwingBodyOf(get) ? `${throwingGetter(e.name.text)}()` : (member ?? this.memberName(e));
	},

	/** A write's setter with a throwing body (`throwingBodyOf`), which the write calls. */
	throwingWrite(this: Translator, e: ts.Expression): ts.SetAccessorDeclaration | null {
		if (!ts.isPropertyAccessExpression(e)) return null;
		const set = accessedDeclaration(this.resolve(e.name), true);
		return set && ts.isSetAccessorDeclaration(set) && this.throwingBodyOf(set) ? set : null;
	},

	/** The iOS version a field's Swift type needs beyond the deployment target, or 0. */
	fieldAvailability(this: Translator, m: ts.PropertyDeclaration): number {
		this.availability.push(0);
		try {
			this.typeOf(m.name);
			return this.availability[this.availability.length - 1];
		} finally {
			this.availability.pop();
		}
	},
	/** A call of a method an instance can replace (see `instanceKeys`): through the instance's own value, which may throw. */
	replaceableCall(this: Translator, e: ts.CallExpression): boolean {
		return ts.isPropertyAccessExpression(e.expression) && e.expression.expression.kind !== ts.SyntaxKind.SuperKeyword && this.isInstanceMethod(e.expression.name) && !!this.resolve(e.expression.name)?.declarations?.some((d) => ts.isMethodDeclaration(d) && !!d.body);
	},
	/** The method a member name resolves to, through a mapped type (`Readonly<Match>`) too. */
	methodDecl(this: Translator, name: ts.MemberName): ts.Declaration | undefined {
		const sym = this.resolve(name);
		return sym?.valueDeclaration ?? sym?.declarations?.find(ts.isMethodDeclaration);
	},

	isInstanceMethod(this: Translator, name: ts.MemberName): boolean {
		return replaceableMethod(this.methodDecl(name), this.instanceKeys(), this.checker);
	},

	/** Whether a class above (the program's own) declares a member of this name. */
	baseDeclares(this: Translator, base: ts.ClassLikeDeclaration | undefined, name: string): boolean {
		for (let b = base; b; b = this.sourceBase(b)) if (b.members.some((m) => m.name?.getText() === name)) return true;
		return false;
	},

	/**
	 * App mode: the kit property an app class's field redeclares (`presented: UIViewController` over core's PageTransition's):
	 * the kit's, where Swift's types agree; else, of an app type named like core's (the app's `PageTransitionController`), a field of its own.
	 */
	kitRedeclared(this: Translator, m: ts.PropertyDeclaration): { type: string; same: boolean } | null {
		if (this.library || isStatic(m) || !ts.isClassLike(m.parent) || !ts.isIdentifier(m.name) || this.baseHasField(m.parent, m.name.text)) return null;
		const kitRoot = this.kitRootOf(m.parent);
		const kit = kitRoot ? this.core.kitMember(kitRoot, m.name.text) : null;
		if (kit?.kind !== 'var') return null;
		const plain = (t: string) => t.replace(/^\((.*)\)[?!]$/, '$1').replace(/[?!]$/, '');
		return { type: kit.type, same: plain(this.typeOf(m.name)) === plain(kit.type) };
	},

	/**
	 * A getter Swift declares without `throws`, reporting what it throws instead: one paired with a setter, or one over
	 * a base's field (Swift's settable properties cannot throw), as `classDecl` writes them.
	 */
	reportedGetter(this: Translator, get: ts.GetAccessorDeclaration, throws: (fn: ts.Node) => boolean = (f) => this.throwsInfo.fn(f)): boolean {
		const cls = get.parent;
		if (!ts.isClassLike(cls)) return false;
		const name = get.name.getText();
		const set = cls.members.find((m): m is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(m) && m.name.getText() === name && isStatic(m) === isStatic(get));
		const overField = !set && !isStatic(get) && this.baseHasField(cls, name);
		return (!!set || overField) && (throws(get) || (!!set && throws(set)));
	},

	/** An accessor whose throw Swift reports (`Throws`'s `reported`): a setter, or a getter `reportedGetter` names, that no throwing method (`throwingAccessor`) stands in for. */
	reportedAccessor(this: Translator, a: ts.AccessorDeclaration, throws: (fn: ts.Node) => boolean): boolean {
		if (this.throwingAccessor(a)) return false;
		return ts.isGetAccessorDeclaration(a) ? this.reportedGetter(a, throws) : true;
	},

	/**
	 * App mode: a program class's setter (but one taking any value), or a getter beside a setter or over a base's field,
	 * whose typed reads and writes call its body as a throwing method (`throwingGetter`, `throwingSetter`).
	 */
	throwingAccessor(this: Translator, a: ts.AccessorDeclaration): boolean {
		if (this.library || !a.body || !ts.isClassLike(a.parent) || a.getSourceFile().isDeclarationFile) return false;
		return ts.isSetAccessorDeclaration(a) ? !this.setterTakesAny(a) : this.reportedGetter(a, () => true);
	},

	/** Whether a source base class declares a field, or a settable accessor, of this name. */
	baseHasField(this: Translator, cls: ts.ClassLikeDeclaration, name: string): boolean {
		for (let b = this.sourceBase(cls); b; b = this.sourceBase(b)) {
			if (b.members.some((x) => (ts.isPropertyDeclaration(x) || ts.isSetAccessorDeclaration(x)) && !isStatic(x) && x.name.getText() === name)) return true;
		}
		return false;
	},

	/** The Swift type a redeclared field has where its base declares it. */
	redeclaredType(this: Translator, root: ts.PropertyDeclaration | ts.AccessorDeclaration | ts.ParameterDeclaration): string {
		return ts.isGetAccessorDeclaration(root) ? this.returnTypeOf(root) : ts.isSetAccessorDeclaration(root) ? this.typeOf(root.parameters[0].name) : this.typeOf(root.name);
	},

	/** The object `Object.defineProperty` or `defineProperties` defines a property on (`Object.defineProperty(X.prototype, 'k', …)`). */
	definedOn(this: Translator, e: ts.Expression): boolean {
		const call = ts.walkUpParenthesizedExpressions(e.parent);
		return ts.isCallExpression(call) && call.arguments[0] !== undefined && ts.skipOuterExpressions(call.arguments[0], ts.OuterExpressionKinds.Parentheses) === e && ['Object.defineProperty', 'Object.defineProperties'].includes(call.expression.getText());
	},

	/** A method read off a prototype (`Object.prototype.hasOwnProperty`), or a variable holding one: a method value, untyped. */
	isPrototypeMember(this: Translator, n: ts.Node): boolean {
		if (ts.isPropertyAccessExpression(n)) return this.isPrototypeRef(n.expression);
		if (!ts.isIdentifier(n) || !this.library) return false;
		const decl = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
		return !!decl && ts.isVariableDeclaration(decl) && !!decl.initializer && ts.isPropertyAccessExpression(decl.initializer) && this.isPrototypeRef(decl.initializer.expression);
	},
	/**
	 * Library mode: what a name core's published declarations give (`import { ActionItem } from '.'`) is
	 * in the program, when the module those declarations describe is compiled with it: its export of that name.
	 */
	compiledCounterpart(this: Translator, sym: ts.Symbol | undefined): ts.Symbol | null {
		if (!sym || !this.library?.sourceOf) return null;
		let found = this.compiledSymbols.get(sym);
		if (found !== undefined) return found;
		found = null;
		const decl = sym.declarations?.[0];
		const source = decl?.parent && ts.isSourceFile(decl.parent) && decl.getSourceFile().isDeclarationFile ? this.library.sourceOf(decl.getSourceFile().fileName) : null;
		const sf = source ? this.sourceFiles.find((f) => f.fileName === source) : undefined;
		const module = sf && this.checker.getSymbolAtLocation(sf);
		const exported = module && this.checker.getExportsOfModule(module).find((x) => x.name === sym.name);
		const target = exported && (exported.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(exported) : exported);
		if (target && target.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum) && target.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) found = target;
		this.compiledSymbols.set(sym, found);
		return found;
	},
	/** Library mode: the compiled method or constructor a published declaration's class member stands for. */
	compiledMember(this: Translator, decl: ts.Declaration): ts.Declaration | null {
		const cls = decl.parent;
		if (!this.library || !cls || !ts.isClassDeclaration(cls) || !cls.name) return null;
		const compiled = this.compiledCounterpart(this.checker.getSymbolAtLocation(cls.name))?.declarations?.find((d): d is ts.ClassDeclaration => ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile);
		if (!compiled) return null;
		if (ts.isConstructorDeclaration(decl)) return compiled.members.find((m) => ts.isConstructorDeclaration(m) && !!m.body) ?? null;
		const name = (decl as ts.NamedDeclaration).name?.getText();
		const member = name ? this.checker.getTypeAtLocation(compiled).getProperty(name) : undefined;
		return member?.declarations?.find((d) => (ts.isMethodDeclaration(d) || ts.isGetAccessorDeclaration(d)) && !!d.body) ?? null;
	},

	/** Writes a type's members with `owner` as the type they are recorded under. */
	declaring<T>(this: Translator, owner: string, kind: 'class' | 'struct' | 'enum' | 'protocol' | 'extension', base: string | null, write: () => T, available?: number): T {
		if (!this.declarations) return write();
		const name = owner.replace(/^NativeScriptKit\./, '');
		this.declarations.type(name, kind, base, available);
		const saved = this.declOwner;
		this.declOwner = name;
		try {
			return write();
		} finally {
			this.declOwner = saved;
		}
	},

	/** A member function as `func` writes it, recorded under the type being written. */
	memberFunc(this: Translator, fn: ts.FunctionDeclaration | ts.MethodDeclaration, name: string, modifiers = '', extraParams: string[] = []): string {
		const code = this.func(fn, name, modifiers, extraParams);
		if (this.lastSignature) this.declare(name, this.lastSignature);
		return code;
	},
};
