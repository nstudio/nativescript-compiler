// Members a declaration does not list: ambient classes, merged interfaces, augmentations and undeclared members; and
// whether a value is undefined (admitsUndefined, assertedOperand, undefinedLiteral, onlyUndefined, resultsAreUndefinedElements).
import ts from 'typescript';

/**
 * A class only a `declare class` in the program's own source describes (`declare class IController extends UIViewController`
 * typing a `@NativeClass` subclass's instances): it has no runtime existence, so nothing is emitted for it.
 */
export function isAmbientClass(sym: ts.Symbol | undefined): boolean {
	const decls = sym?.declarations ?? [];
	return !!sym && !!(sym.flags & ts.SymbolFlags.Class) && decls.length > 0 && decls.every((d) => (ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile && !!ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) || ts.isInterfaceDeclaration(d));
}

/**
 * The class what an ambient class (`isAmbientClass`) types is held as: the nearest class it extends that is emitted, as at
 * runtime its objects are that class's, carrying what the declaration adds as their own properties. Null where it extends none.
 */
export function ambientBase(sym: ts.Symbol, checker: ts.TypeChecker): ts.Type | null {
	let c = checker.getDeclaredTypeOfSymbol(sym);
	while (isAmbientClass(c.getSymbol())) {
		const base = checker.getBaseTypes(c as ts.InterfaceType).find((b) => !!(b.getSymbol()?.flags! & ts.SymbolFlags.Class));
		if (!base) return null;
		c = (base as ts.TypeReference).target ?? base;
	}
	return c;
}

/**
 * `object.name` (or `object['name']`) where the object is typed by an ambient class, or an interface extending exactly one class, and `name` is
 * what that declaration adds to the class the object is held as: the object's own property, read and written by name.
 * The class held as, or null.
 */
export function ambientAddedMemberOf(e: ts.PropertyAccessExpression | ts.ElementAccessExpression, checker: ts.TypeChecker): ts.Type | null {
	const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isStringLiteral(e.argumentExpression) ? e.argumentExpression.text : null;
	if (name === null) return null;
	const sym = checker.getNonNullableType(checker.getTypeAtLocation(e.expression)).getSymbol();
	if (!sym || !(sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) return null;
	let held: ts.Type | null = null;
	if (isAmbientClass(sym)) held = ambientBase(sym, checker);
	else if (!(sym.flags & ts.SymbolFlags.Class)) {
		const bases = checker.getBaseTypes(checker.getDeclaredTypeOfSymbol(sym) as ts.InterfaceType);
		const base = bases.length === 1 && bases[0].getSymbol()?.flags! & ts.SymbolFlags.Class ? bases[0].getSymbol()! : null;
		held = base && (isAmbientClass(base) ? ambientBase(base, checker) : checker.getDeclaredTypeOfSymbol(base));
	}
	return held && !held.getProperty(name) ? held : null;
}

/** A class's `implements` types that are interfaces: implementing a class (even itself) only checks its shape. */
export function implementedInterfaces(checker: ts.TypeChecker, cls: ts.ClassLikeDeclaration): ts.ExpressionWithTypeArguments[] {
	return (cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? []).filter((i) => {
		let s = checker.getSymbolAtLocation(i.expression);
		if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
		return !(s && s.flags & ts.SymbolFlags.Class);
	});
}

/** Whether a program type of this name would hide one of the runtime's from the generated code. */
export function runtimeTypeName(name: string): boolean {
	return /^JS[A-Z]/.test(name);
}

/**
 * `object.name` where the object is an instance of a program class and `name` is declared only by an interface merged
 * with that class or a base (`declare module 'm' { interface C { name(): T } }`), or only as an optional method without
 * a body (`name?(): T;`): the class has no such member, so it is what a subclass defines or script installs at run time
 * (`C.prototype.name = …`, `Object.defineProperty(c, 'name', …)`), read by name, and absent (undefined) wherever nothing did.
 */
export function mergedInterfaceMemberOf(e: ts.PropertyAccessExpression, checker: ts.TypeChecker): ts.ClassLikeDeclaration | null {
	const decls = checker.getSymbolAtLocation(e.name)?.declarations;
	if (!decls?.length || !decls.every((d) => ((ts.isMethodSignature(d) || ts.isPropertySignature(d)) && ts.isInterfaceDeclaration(d.parent)) || optionalBodilessMethod(d))) return null;
	const t = checker.getNonNullableType(checker.getTypeAtLocation(e.expression));
	if (t.getConstructSignatures().length || t.isUnionOrIntersection()) return null;
	const compiled = (x: ts.Type) => {
		const d = x.getSymbol()?.valueDeclaration;
		return d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
	};
	// Through a class's `extends`, only an interface merged into a base class from another file (a `declare module`
	// augmentation): the base's own interface members (`Array`'s `splice`) are its prototype's.
	const merged = (base: ts.Type, d: ts.Declaration) => {
		const classes = base.getSymbol()?.declarations?.filter(ts.isClassLike) ?? [];
		return ts.isInterfaceDeclaration(d.parent) && classes.length > 0 && classes.every((c) => c.getSourceFile() !== d.getSourceFile());
	};
	const declares = (i: ts.InterfaceDeclaration | ts.ClassLikeDeclaration) =>
		(i.members as ts.NodeArray<ts.Node>).some((m) => decls.includes(m as ts.Declaration)) ||
		!!i.heritageClauses?.some((h) =>
			h.types.some((x) => {
				const base = checker.getTypeAtLocation(x);
				return base.getProperty(e.name.text)?.declarations?.some((d) => decls.includes(d) && (ts.isInterfaceDeclaration(i) || merged(base, d)));
			}),
		);
	// An interface the library or a base outside the program declares (`Error`'s `stack`) is no merge with a program class.
	for (let c = t as ts.Type | undefined; c && compiled(c); c = checker.getBaseTypes(((c as ts.TypeReference).target ?? c) as ts.InterfaceType).find((b) => !!(b.getSymbol()!.flags & ts.SymbolFlags.Class))) {
		if (c.getSymbol()!.declarations!.some((d) => (ts.isInterfaceDeclaration(d) || ts.isClassLike(d)) && declares(d))) return compiled(t)!;
	}
	return null;
}

/** A read of a `mergedInterfaceMemberOf` property: undefined wherever nothing set it, whatever its declared type. */
export function augmentedPropertyRead(e: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
	return !e.questionDotToken && !!checker.getSymbolAtLocation(e.name)?.declarations?.every(ts.isPropertySignature) && !!mergedInterfaceMemberOf(e, checker);
}

/** `m?(): T;` in a class: a declaration only, which puts no method on the prototype. */
export function optionalBodilessMethod(d: ts.Node): boolean {
	return ts.isMethodDeclaration(d) && !d.body && !!d.questionToken && ts.isClassLike(d.parent);
}

/**
 * `object.name` where the object is an instance of a program class and the type checker finds no member `name`: an own
 * property of the instance, read and written by name. Only code checked leniently reaches here: a plugin's component is
 * typed by the plugin's declarations but compiled against its platform file, whose stub class may declare none of them.
 */
export function undeclaredMemberOf(e: ts.PropertyAccessExpression, checker: ts.TypeChecker): ts.ClassLikeDeclaration | null {
	if (checker.getSymbolAtLocation(e.name)) return null;
	const t = checker.getNonNullableType(checker.getTypeAtLocation(e.expression));
	if (t.getConstructSignatures().length) return null;
	const decl = t.getSymbol()?.valueDeclaration;
	return decl && ts.isClassLike(decl) && !decl.getSourceFile().isDeclarationFile ? decl : null;
}

/**
 * The program classes, each the root of its program hierarchy, whose instances the program holds untyped (`as any`, an
 * `any` variable or parameter given one), where script may give them members their classes don't declare. `open`: held as
 * `object`, `{}` or a type parameter as well, by any expression.
 */
export function classesHeldUntyped(files: readonly ts.SourceFile[], checker: ts.TypeChecker, open = false): Set<ts.ClassLikeDeclaration> {
	const roots = new Set<ts.ClassLikeDeclaration>();
	const classOf = (n: ts.Expression) => {
		const d = checker.getNonNullableType(checker.getTypeAtLocation(n)).getSymbol()?.valueDeclaration;
		return d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
	};
	const untyped = (t: ts.Type | undefined) => !!t && (!!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (open && (!!(t.flags & (ts.TypeFlags.NonPrimitive | ts.TypeFlags.TypeParameter)) || (!!(t.flags & ts.TypeFlags.Object) && !t.getProperties().length && !t.getCallSignatures().length && !t.getConstructSignatures().length && !checker.getIndexInfosOfType(t).length))));
	// An argument of a library function (`JSON.stringify(x)`, `Object.keys(x)`) goes nowhere else, but Object.defineProperty's target.
	const givenToLibrary = (n: ts.Expression) => {
		const call = n.parent;
		if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || !call.arguments?.includes(n)) return false;
		const d = checker.getResolvedSignature(call)?.declaration;
		if (!d || !d.getSourceFile().isDeclarationFile) return false;
		return !(ts.isCallExpression(call) && call.arguments[0] === n && ts.isPropertyAccessExpression(call.expression) && ['defineProperty', 'defineProperties'].includes(call.expression.name.text));
	};
	const visit = (n: ts.Node) => {
		let held: ts.Expression | undefined;
		if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && untyped(checker.getTypeFromTypeNode(n.type))) held = n.expression;
		else if ((ts.isNewExpression(n) || ts.isIdentifier(n) || n.kind === ts.SyntaxKind.ThisKeyword || (open && (ts.isPropertyAccessExpression(n) || ts.isCallExpression(n) || ts.isElementAccessExpression(n)))) && ts.isExpression(n) && !ts.isPropertyAccessExpression(n.parent) && untyped(checker.getContextualType(n)) && !(open && givenToLibrary(n))) held = n;
		// `Object.assign(instance, …)` gives it the sources' keys.
		else if (ts.isCallExpression(n) && n.arguments.length && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'assign' && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Object') held = n.arguments[0];
		// A class with a string index signature takes any key.
		let cls = held ? classOf(held) : ts.isClassLike(n) && n.members.some((m) => ts.isIndexSignatureDeclaration(m) && !hasStatic(m)) ? n : undefined;
		for (let h = cls?.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]; cls && h; h = cls.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]) {
			const d = checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
			if (!d || !ts.isClassLike(d) || d.getSourceFile().isDeclarationFile) break;
			cls = d;
		}
		if (cls) roots.add(cls);
		ts.forEachChild(n, visit);
	};
	for (const sf of files) if (!sf.isDeclarationFile) visit(sf);
	return roots;
}

export function hasStatic(d: ts.Declaration): boolean {
	return !!ts.canHaveModifiers(d) && !!ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

/** Whether a value of type `t` may be undefined when it runs: its type admits undefined or void, or it is untyped. */
export function admitsUndefined(t: ts.Type): boolean {
	return (t.isUnion() ? t.types : [t]).some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/** The first of `e` and the operands of its parentheses and type assertions that `untyped` holds: the value as it runs. */
export function assertedOperand(e: ts.Expression, untyped: (x: ts.Expression) => boolean): ts.Expression | null {
	for (let x: ts.Expression = e; ; x = x.expression) {
		if (untyped(x)) return x;
		if (!ts.isParenthesizedExpression(x) && !ts.isAsExpression(x) && !ts.isTypeAssertionExpression(x) && !ts.isSatisfiesExpression(x)) return null;
	}
}

/** `undefined` or `void` of a literal: undefined, with nothing evaluated. */
export function undefinedLiteral(e: ts.Expression): boolean {
	const x = ts.skipParentheses(e);
	return (ts.isIdentifier(x) && x.text === 'undefined') || (ts.isVoidExpression(x) && ts.isLiteralExpression(ts.skipParentheses(x.expression)));
}

/** Whether a value is undefined whatever it runs as (`undefined`, `void 0`). */
export function onlyUndefined(t: ts.Type): boolean {
	return !t.isUnion() && !!(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
}

/**
 * Whether a callback's results are the elements of the array of undefined its call gives (`map(() => undefined)`): its
 * slot returns a type parameter and the call's result is an array of undefined.
 */
export function resultsAreUndefinedElements(fn: ts.ArrowFunction | ts.FunctionExpression, slot: ts.Signature, checker: ts.TypeChecker): boolean {
	const d = slot.getDeclaration();
	if (!d || ts.isJSDocSignature(d) || !(checker.getSignatureFromDeclaration(d)!.getReturnType().flags & ts.TypeFlags.TypeParameter)) return false;
	let arg: ts.Node = fn;
	while (ts.isParenthesizedExpression(arg.parent)) arg = arg.parent;
	const call = arg.parent;
	if (!call || !ts.isCallExpression(call) || !call.arguments.includes(arg as ts.Expression)) return false;
	const t = checker.getTypeAtLocation(call);
	return checker.isArrayType(t) && onlyUndefined(checker.getTypeArguments(t as ts.TypeReference)[0]);
}

/** The program's interfaces a class implements, whose fields its classes declare as well. */
export function implementedInterfaceDeclarations(files: readonly ts.SourceFile[], checker: ts.TypeChecker): Set<ts.Declaration> {
	const out = new Set<ts.Declaration>();
	const visit = (n: ts.Node) => {
		if (ts.isClassLike(n)) for (const i of implementedInterfaces(checker, n)) for (const d of checker.getTypeAtLocation(i).getSymbol()?.declarations ?? []) out.add(d);
		ts.forEachChild(n, visit);
	};
	for (const f of files) if (!f.isDeclarationFile) visit(f);
	return out;
}

/**
 * The declaration an access of `sym` goes through: of an accessor pair, the getter for a read and the setter for a
 * write, whichever the class declares first (`valueDeclaration` is the first). A read of a setter-only member keeps its setter.
 */
export function accessedDeclaration(sym: ts.Symbol | undefined, write = false): ts.Declaration | undefined {
	const d = sym?.valueDeclaration;
	if (!d || !ts.isAccessor(d)) return d;
	return sym!.declarations?.find((x) => x.parent === d.parent && (write ? ts.isSetAccessorDeclaration(x) : ts.isGetAccessorDeclaration(x))) ?? d;
}

/** The generic class a member, or a constructor's parameter property, belongs to. */
export function memberOwner(decl: ts.Declaration): ts.ClassLikeDeclaration | null {
	const owner = ts.isParameter(decl) && ts.isConstructorDeclaration(decl.parent) ? decl.parent.parent : decl.parent;
	return owner && ts.isClassLike(owner) && owner.typeParameters?.length ? owner : null;
}

/**
 * Whether a member's type names a type parameter of its generic class, as written or, with no annotation, as the
 * checker infers it (`get data() { return this.mData; }` over `mData: T`), or a setter by what it takes: a backend
 * erasing the class's type parameters holds such a member untyped, whatever the instantiation it is read through.
 */
export function namesOwnTypeParameter(decl: ts.Declaration, checker: ts.TypeChecker): boolean {
	const owner = memberOwner(decl);
	if (ts.isSetAccessor(decl)) return !!owner && decl.parameters.length > 0 && namesTypeParameterOf(decl.parameters[0], owner, checker);
	return !!owner && (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isParameter(decl) || ts.isGetAccessor(decl)) && namesTypeParameterOf(decl, owner, checker);
}

function namesTypeParameterOf(decl: ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration | ts.GetAccessorDeclaration, owner: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
	const params = new Set(owner.typeParameters!.map((p) => checker.getSymbolAtLocation(p.name)));
	if (decl.type) {
		let named = false;
		const visit = (n: ts.Node) => {
			if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && params.has(checker.getSymbolAtLocation(n.typeName))) named = true;
			if (!named) ts.forEachChild(n, visit);
		};
		visit(decl.type);
		return named;
	}
	const sym = decl.name && checker.getSymbolAtLocation(decl.name);
	if (!sym) return false;
	const seen = new Set<ts.Type>();
	const names = (t: ts.Type, depth: number): boolean => {
		if (seen.has(t) || depth > 4) return false;
		seen.add(t);
		if (t.flags & ts.TypeFlags.TypeParameter) return params.has(t.symbol);
		if (t.isUnionOrIntersection()) return t.types.some((u) => names(u, depth + 1));
		return !!(t.flags & ts.TypeFlags.Object) && !!((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) && checker.getTypeArguments(t as ts.TypeReference).some((u) => names(u, depth + 1));
	};
	return names(checker.getTypeOfSymbolAtLocation(sym, decl), 0);
}
