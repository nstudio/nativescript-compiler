// A class's place in its hierarchy, as the checker gives it: its program base, the constructor it runs, what it inherits.
import ts from 'typescript';
import { ERRORS } from './globals.ts';
import { isStatic } from './throws.ts';
import { hasModifier, isLibDeclaration, isWriteTarget } from './ast.ts';
import { literalKey, optionalBodilessMethod } from './lang.ts';
import type { StateBackend } from './states/value-states.ts';

/** The class `cls` extends where the program's own source declares it; undefined for a library's class or none. */
export function programBase(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ts.ClassLikeDeclaration | undefined {
	const h = cls.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
	const d = h && checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
	return d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
}

/** The nearest method of the same name a program base class declares: an overloaded method's implementation, or an abstract one. */
export function baseMethod(m: ts.MethodDeclaration, checker: ts.TypeChecker): ts.MethodDeclaration | null {
	const name = m.name.getText();
	for (let c = programBase(m.parent as ts.ClassLikeDeclaration, checker); c; c = programBase(c, checker)) {
		const named = c.members.filter((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && x.name.getText() === name && !isStatic(x));
		const b = named.find((x) => !!x.body) ?? named.find((x) => hasModifier(x, ts.SyntaxKind.AbstractKeyword));
		if (b) return b;
	}
	return null;
}

/** The method of this name a class's program base classes declare: an overloaded one's implementation, not an optional bodiless one. */
export function inheritedMethod(cls: ts.ClassLikeDeclaration, name: string, checker: ts.TypeChecker): ts.MethodDeclaration | undefined {
	for (let b = programBase(cls, checker); b; b = programBase(b, checker)) {
		const all = b.members.filter((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && x.name.getText() === name && !optionalBodilessMethod(x));
		const m = all.find((x) => !!x.body) ?? all[0];
		if (m) return m;
	}
	return undefined;
}

/** The topmost declaration a method overrides in the program's base classes (`inheritedMethod`), or the method itself. */
export function rootMethod(m: ts.MethodDeclaration, checker: ts.TypeChecker): ts.MethodDeclaration {
	if (!ts.isClassLike(m.parent)) return m;
	let root = m;
	for (let up = inheritedMethod(m.parent, m.name.getText(), checker); up; up = inheritedMethod(up.parent as ts.ClassLikeDeclaration, m.name.getText(), checker)) root = up;
	return root;
}

/** The field, accessor or parameter property a program base class declares under a field's name, which the field redeclares. */
export function redeclaredField(m: ts.PropertyDeclaration | ts.ParameterDeclaration, checker: ts.TypeChecker): ts.PropertyDeclaration | ts.AccessorDeclaration | ts.ParameterDeclaration | null {
	const cls = ts.isParameter(m) ? (ts.isParameterPropertyDeclaration(m, m.parent) ? m.parent.parent : undefined) : m.parent;
	if (!cls || !ts.isClassLike(cls) || (!ts.isParameter(m) && isStatic(m))) return null;
	const name = m.name.getText();
	let found: ts.PropertyDeclaration | ts.AccessorDeclaration | ts.ParameterDeclaration | null = null;
	for (let b = programBase(cls, checker); b; b = programBase(b, checker)) {
		const own = b.members.find((x): x is ts.PropertyDeclaration | ts.AccessorDeclaration => (ts.isPropertyDeclaration(x) || ts.isAccessor(x)) && !isStatic(x) && x.name.getText() === name) ?? b.members.find((x): x is ts.ConstructorDeclaration => ts.isConstructorDeclaration(x) && !!x.body)?.parameters.find((q) => ts.isParameterPropertyDeclaration(q, q.parent) && q.name.getText() === name);
		if (own) found = own;
	}
	return found;
}

/**
 * A field over what program base classes declare only abstract (`abstract get label(): string`, `abstract label:
 * string`): no member when the program runs, so the field is the class's own, a key its level of the constructor makes,
 * undefined to a base's code reading it before then.
 */
export function overAbstractOnly(m: ts.PropertyDeclaration | ts.ParameterDeclaration, checker: ts.TypeChecker): boolean {
	const cls = ts.isParameter(m) ? m.parent.parent : m.parent;
	if (!ts.isClassLike(cls) || (!ts.isParameter(m) && isStatic(m))) return false;
	const name = m.name.getText();
	let declared = false;
	for (let b = programBase(cls, checker); b; b = programBase(b, checker)) {
		const own = b.members.filter((x) => (ts.isPropertyDeclaration(x) || ts.isAccessor(x)) && !isStatic(x) && x.name.getText() === name);
		const param = b.members.find((x): x is ts.ConstructorDeclaration => ts.isConstructorDeclaration(x) && !!x.body)?.parameters.some((q) => ts.isParameterPropertyDeclaration(q, q.parent) && q.name.getText() === name);
		if (param || own.some((x) => !hasModifier(x, ts.SyntaxKind.AbstractKeyword))) return false;
		declared ||= own.length > 0;
	}
	return declared;
}

/** An abstract field: no property when the program runs, so no key (a subclass's field of its name makes one). */
export function abstractField(m: ts.Declaration | undefined): boolean {
	return !!m && ts.isPropertyDeclaration(m) && hasModifier(m, ts.SyntaxKind.AbstractKeyword);
}

/**
 * An app class's own field with an initializer that code of a base class may read before the field is set: the base's
 * constructor or a field initializer calls a method or getter the class declares (`this.kind()`), or the field
 * implements only abstract declarations. JavaScript defines the field after the base constructor returns, so such a
 * read sees undefined.
 */
export function readEarly(m: ts.PropertyDeclaration, b: Pick<StateBackend, 'checker' | 'library' | 'pluginFiles'>): boolean {
	const cls = m.parent;
	return !b.library && ts.isClassLike(cls) && !isStatic(m) && !!m.initializer && !hasModifier(m, ts.SyntaxKind.DeclareKeyword) && ts.isIdentifier(m.name) && !b.pluginFiles.has(m.getSourceFile().fileName) && !ts.getDecorators(m)?.length && (readsFieldsEarly(cls, b.checker) || overAbstractOnly(m, b.checker));
}

/** A class some base of which calls, from its constructor or a field initializer, a method or getter the class declares. */
function readsFieldsEarly(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
	const own = new Set(cls.members.filter((m) => (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) && !isStatic(m) && m.name && ts.isIdentifier(m.name)).map((m) => (m.name as ts.Identifier).text));
	if (!own.size) return false;
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found || (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) || ts.isClassLike(n)) return;
		if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && own.has(n.name.text)) found = true;
		ts.forEachChild(n, visit);
	};
	for (let up = programBase(cls, checker); up && !found; up = programBase(up, checker)) {
		for (const m of up.members) {
			if (ts.isConstructorDeclaration(m) && m.body) ts.forEachChild(m.body, visit);
			else if (ts.isPropertyDeclaration(m) && !isStatic(m) && m.initializer) visit(m.initializer);
		}
	}
	return found;
}

/**
 * A `[Symbol.iterator]()` method whose declared result is no iterator (`unknown`, `any`, an object without `next`):
 * iterating its instance checks what it gives, as GetIterator does.
 */
export function uncheckedIteratorResult(m: ts.MethodDeclaration, checker: ts.TypeChecker): boolean {
	const sig = checker.getSignatureFromDeclaration(m);
	const t = sig && checker.getReturnTypeOfSignature(sig);
	return !t || !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || !checker.getPropertyOfType(t, 'next');
}

/** The method with a body `X.prototype.name` is: X's own, or the nearest base's of the program's. */
export function declaringMethod(cls: ts.ClassLikeDeclaration, name: string, checker: ts.TypeChecker): ts.MethodDeclaration | undefined {
	for (let c: ts.ClassLikeDeclaration | undefined = cls; c; c = programBase(c, checker)) {
		const m = c.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && !isStatic(x) && !!x.body && x.name.getText() === name);
		if (m) return m;
		if (c.members.some((x) => !isStatic(x) && x.name?.getText() === name)) return undefined;
	}
	return undefined;
}

/** The constructor with a body `new` of `cls` runs: its own, else the nearest program base's. */
export function constructorOf(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ts.ConstructorDeclaration | undefined {
	for (let b: ts.ClassLikeDeclaration | undefined = cls; b;) {
		const ctor = b.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
		if (ctor) return ctor;
		const h: ts.ExpressionWithTypeArguments | undefined = b.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		const d: ts.Declaration | undefined = h && checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
		b = d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
	}
	return undefined;
}

/** A base of `cls` declares `toString`, or it extends one of the library's error classes. */
export function inheritsToString(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
	const h = cls.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
	const d = h && checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
	if (!d || !ts.isClassLike(d)) return !!h && !!ERRORS[h.expression.getText()];
	return d.members.some((m) => ts.isMethodDeclaration(m) && m.name.getText() === 'toString') || inheritsToString(d, checker);
}

/**
 * Whether the `toString()` method `m` (of a class, or of the topmost base class declaring one) may give no string: string
 * conversion then goes on to valueOf, and both backends hold the method apart from the platform's own toString.
 */
export function toStringGivesNonString(m: ts.MethodDeclaration, checker: ts.TypeChecker): boolean {
	if (m.name.getText() !== 'toString' || m.parameters.length || !ts.isClassLike(m.parent)) return false;
	let root = m;
	for (let cls: ts.ClassLikeDeclaration | undefined = m.parent; cls;) {
		const h: ts.ExpressionWithTypeArguments | undefined = cls.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		const d: ts.Declaration | undefined = h && checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
		cls = d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
		const own = cls?.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && x.name.getText() === 'toString' && !x.parameters.length);
		if (own) root = own;
	}
	const sig = checker.getSignatureFromDeclaration(root);
	const t = sig && checker.getReturnTypeOfSignature(sig);
	return !!t && (t.isUnion() ? t.types : [t]).some((x) => !(x.flags & ts.TypeFlags.StringLike));
}

/** The one base of a class or interface type, where it has exactly one and that base is a class. */
export function extendedClass(t: ts.Type, checker: ts.TypeChecker): ts.Type | null {
	if (!t.isClassOrInterface()) return null;
	const bases = checker.getBaseTypes(t as ts.InterfaceType);
	if (bases.length !== 1 || !(bases[0].getSymbol()?.flags! & ts.SymbolFlags.Class)) return null;
	return bases[0];
}

/**
 * An instance field whose decorators are functions of the program's own source (a plugin's `@cssProperty`), not
 * gesturehandler's native-property shape: JavaScript calls each with the class's prototype and the key when the class
 * is defined, and the field is read and written through whatever accessor they put on the prototype chain.
 */
export function prototypeDecorated(b: Pick<StateBackend, 'resolve'>, m: ts.ClassElement): boolean {
	if (!ts.isPropertyDeclaration(m) || isStatic(m) || !ts.isIdentifier(m.name)) return false;
	const ds = ts.getDecorators(m) ?? [];
	return (
		ds.length > 0 &&
		ds.every((d) => {
			const callee = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
			const decl = b.resolve(callee)?.declarations?.[0];
			return !!decl && !decl.getSourceFile().isDeclarationFile;
		})
	);
}

/** A framework's event type (`ListViewItemTapEvent`) is an `EventData` with typed members. */
export function isEventData(t: ts.Type, checker: ts.TypeChecker): boolean {
	const target = (t as ts.TypeReference).target ?? t;
	if (!(target.flags & ts.TypeFlags.Object) || !target.isClassOrInterface()) return false;
	// Core declares some event types as classes of their own (`TouchGestureEventData`): an event names itself.
	const declared = target.getSymbol()?.declarations?.every((d) => d.getSourceFile().isDeclarationFile);
	if (declared && target.getProperty('eventName') && target.getProperty('object')) return true;
	return checker.getBaseTypes(target).some((b) => b.getSymbol()?.getName() === 'EventData' || isEventData(b, checker));
}

/** `EventData` itself, or a class or interface `isEventData` holds. */
export function isEventDataSymbol(sym: ts.Symbol, checker: ts.TypeChecker): boolean {
	const t = checker.getDeclaredTypeOfSymbol(sym);
	return sym.name === 'EventData' || (t.isClassOrInterface() && isEventData(t, checker));
}

/** The program's class a type names (`SelectorsMatch`, `Readonly<SelectorsMatch>`), if any. */
export function classOfType(type: ts.Type, checker: ts.TypeChecker): ts.ClassDeclaration | undefined {
	const t = checker.getNonNullableType(type);
	const inner = t.aliasSymbol?.name === 'Readonly' && t.aliasTypeArguments?.length === 1 ? t.aliasTypeArguments[0] : t;
	return inner.getSymbol()?.declarations?.find((x): x is ts.ClassDeclaration => ts.isClassDeclaration(x) && !x.getSourceFile().isDeclarationFile);
}

/** What `literalClassOf` reads of a translator. */
export interface LiteralClassBackend {
	readonly checker: ts.TypeChecker;
	readonly library: { moduleName?(file: string): string | null } | null;
}

/** Library mode: the program's class an array of object literals' shape goes where an array of it is taken (`keys.map((k) => ({ ... }))` returned as `KeyframeDeclaration[]`). */
export function shapesClassOf(b: LiteralClassBackend, e: ts.Expression): ts.ClassDeclaration | null {
	const want = b.checker.getContextualType(e);
	const have = b.checker.getTypeAtLocation(e);
	if (!want || !b.checker.isArrayType(want) || !b.checker.isArrayType(have)) return null;
	const element = b.checker.getTypeArguments(have as ts.TypeReference)[0];
	if (!((element?.getSymbol()?.flags ?? 0) & ts.SymbolFlags.ObjectLiteral)) return null;
	const decl = b.checker
		.getTypeArguments(want as ts.TypeReference)[0]
		?.getSymbol()
		?.declarations?.find(ts.isClassDeclaration);
	return decl && !decl.getSourceFile().isDeclarationFile && b.library?.moduleName?.(decl.getSourceFile().fileName) ? decl : null;
}

/** Library mode: the program's class of a compiled module an object literal is typed as, which the literal makes an instance of. */
export function literalClassOf(b: LiteralClassBackend, e: ts.ObjectLiteralExpression): ts.ClassDeclaration | null {
	if (!b.library?.moduleName) return null;
	const t = b.checker.getContextualType(e) ?? b.checker.getTypeAtLocation(e);
	return t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ? null : compiledClassOf(b, t);
}

/** Library mode: the class an object literal's own type (where a value of it is held) is spelled as: its objects are the class's (`literalClassOf`). */
export function literalTypeClassOf(b: LiteralClassBackend, t: ts.Type): ts.ClassDeclaration | null {
	const literal = (t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.ObjectLiteral ? t.getSymbol()?.declarations?.find(ts.isObjectLiteralExpression) : undefined;
	return literal ? literalClassOf(b, literal) : null;
}

/** The program's class of a compiled module a type names; for an object literal's own type, the class its literal is held as (`heldClassOf`). */
function compiledClassOf(b: LiteralClassBackend, t: ts.Type): ts.ClassDeclaration | null {
	t = b.checker.getNonNullableType(t);
	if (t.aliasSymbol?.name === 'Readonly' && t.aliasTypeArguments?.length === 1) t = t.aliasTypeArguments[0];
	const decl = t.getSymbol()?.declarations?.find(ts.isClassDeclaration);
	if (decl) return !decl.getSourceFile().isDeclarationFile && b.library?.moduleName?.(decl.getSourceFile().fileName) ? decl : null;
	const literal = (t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.ObjectLiteral ? t.getSymbol()?.declarations?.find(ts.isObjectLiteralExpression) : undefined;
	return literal ? heldClassOf(b, literal) : null;
}

/** Per program: the classes found, the literals being followed, and whether a cycle cut a result short. */
interface HeldClasses {
	known: Map<ts.Node, ts.ClassDeclaration | null>;
	holding: Set<ts.Node>;
	cut: boolean;
}
const heldClasses = new WeakMap<ts.TypeChecker, HeldClasses>();

/**
 * An object literal with no class typing it, held where one class is taken: an unannotated `const` every typed use of
 * which takes that class, a `map` callback's result where an array of it is taken (directly or through such a const),
 * or a field of another literal of a class declaring the field so. Its keys are all fields of the class, so every read
 * of it is a read of the class's object, which the literal makes as JavaScript keeps one object wherever it goes.
 */
function heldClassOf(b: LiteralClassBackend, e: ts.ObjectLiteralExpression): ts.ClassDeclaration | null {
	let state = heldClasses.get(b.checker);
	if (!state) heldClasses.set(b.checker, (state = { known: new Map(), holding: new Set(), cut: false }));
	const { known, holding } = state;
	if (known.has(e)) return known.get(e)!;
	if (holding.has(e)) {
		state.cut = true;
		return null;
	}
	const outer = !holding.size;
	if (outer) state.cut = false;
	holding.add(e);
	let cls: ts.ClassDeclaration | null;
	try {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const call = ts.isArrowFunction(x.parent) && x.parent.body === x ? mapCallOf(b, x.parent) : undefined;
		cls = call ? slotClassOf(b, call, true) : slotClassOf(b, x as ts.Expression, false);
		if (cls && !literalFits(b, e, cls)) cls = null;
	} finally {
		holding.delete(e);
	}
	if (!state.cut || outer) known.set(e, cls);
	return cls;
}

/** The `array.map(f)` call `f` is the callback of. */
function mapCallOf(b: LiteralClassBackend, f: ts.ArrowFunction): ts.CallExpression | undefined {
	const call = f.parent;
	if (!ts.isCallExpression(call) || call.arguments[0] !== f || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'map') return undefined;
	const receiver = b.checker.getNonNullableType(b.checker.getTypeAtLocation(call.expression.expression));
	return b.checker.isArrayType(receiver) ? call : undefined;
}

/** The class a value (or with `element`, each element of an array value) is held as where it is written: see `heldClassOf`. */
function slotClassOf(b: LiteralClassBackend, x: ts.Expression, element: boolean): ts.ClassDeclaration | null {
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	if (ts.isVariableDeclaration(p) && p.initializer === x && !p.type) return constUsesClassOf(b, p, element);
	if (ts.isPropertyAssignment(p) && p.initializer === x && ts.isObjectLiteralExpression(p.parent)) {
		const outer = literalClassOf(b, p.parent);
		const key = outer && literalKey(p.name, b.checker);
		const field = key ? declaredType(b.checker, outer).getProperty(key)?.valueDeclaration : undefined;
		return field && ts.isPropertyDeclaration(field) && !isStatic(field) ? (takenClassOf(b, b.checker.getTypeAtLocation(field), element) ?? null) : null;
	}
	return takenClassOf(b, b.checker.getContextualType(x), element) ?? null;
}

/** The class an unannotated `const` is held as: the one class its every use with a type takes. */
function constUsesClassOf(b: LiteralClassBackend, d: ts.VariableDeclaration, element: boolean): ts.ClassDeclaration | null {
	if (!ts.isIdentifier(d.name) || !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) || (ts.isVariableStatement(d.parent.parent) && hasModifier(d.parent.parent, ts.SyntaxKind.ExportKeyword))) return null;
	const sym = b.checker.getSymbolAtLocation(d.name);
	const scope = ts.findAncestor(d.parent, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n) || ts.isClassStaticBlockDeclaration(n));
	if (!sym || !scope) return null;
	const name = d.name.text;
	let found: ts.ClassDeclaration | null | undefined;
	const visit = (n: ts.Node): void => {
		if (found === null) return;
		if (ts.isIdentifier(n) && n.text === name && n !== d.name) {
			if ((ts.isShorthandPropertyAssignment(n.parent) && b.checker.getShorthandAssignmentValueSymbol(n.parent) === sym) || (ts.isExportSpecifier(n.parent) && b.checker.getExportSpecifierLocalTargetSymbol(n.parent) === sym)) found = null;
			else if (b.checker.getSymbolAtLocation(n) === sym) {
				const taken = takenClassOf(b, b.checker.getContextualType(n), element);
				if (taken !== undefined) found = found === undefined || found === taken ? taken : null;
			}
		}
		ts.forEachChild(n, visit);
	};
	visit(scope);
	return found ?? null;
}

/** The class a slot of type `t` takes (with `element`, an array of it): undefined where any value goes, null where no class's object does. */
function takenClassOf(b: LiteralClassBackend, t: ts.Type | undefined, element: boolean): ts.ClassDeclaration | null | undefined {
	if (!t || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
	if (element) {
		const array = b.checker.getNonNullableType(t);
		if (!b.checker.isArrayType(array)) return null;
		const of = b.checker.getTypeArguments(array as ts.TypeReference)[0];
		if (!of || of.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
		return compiledClassOf(b, of);
	}
	return compiledClassOf(b, t);
}

/** Whether every key of a literal is one of a class's fields, which the class's object (of no base class) holds as the literal does. */
function literalFits(b: LiteralClassBackend, e: ts.ObjectLiteralExpression, cls: ts.ClassDeclaration): boolean {
	if (cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) return false;
	const type = declaredType(b.checker, cls);
	return e.properties.every((p) => {
		if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) return false;
		const key = literalKey(p.name, b.checker);
		const d = key ? type.getProperty(key)?.valueDeclaration : undefined;
		return !!d && ts.isPropertyDeclaration(d) && !isStatic(d);
	});
}

function declaredType(checker: ts.TypeChecker, cls: ts.ClassDeclaration): ts.Type {
	return checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(cls.name!)!);
}

/**
 * `Cls.name` read of a class the program declares, named by itself or by a `const` holding it: the name it is declared
 * with, which JavaScript gives every function; an anonymous default-exported class's is `default`.
 */
export function declaredClassName(e: ts.PropertyAccessExpression, checker: ts.TypeChecker): string | null {
	if (e.name.text !== 'name' || !ts.isIdentifier(e.expression) || isWriteTarget(e)) return null;
	let x: ts.Expression = e.expression;
	for (let depth = 0; depth < 8; depth++) {
		let sym = ts.isIdentifier(x) ? checker.getSymbolAtLocation(x) : undefined;
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
		const v = sym?.valueDeclaration;
		if (v && ts.isVariableDeclaration(v) && v.initializer && ts.getCombinedNodeFlags(v) & ts.NodeFlags.Const && !v.getSourceFile().isDeclarationFile) {
			x = ts.skipOuterExpressions(v.initializer);
			continue;
		}
		const d = sym && sym.flags & ts.SymbolFlags.Class ? v : undefined;
		if (!d || !ts.isClassDeclaration(d) || d.getSourceFile().isDeclarationFile || staticName(d, checker)) return null;
		return d.name?.text ?? 'default';
	}
	return null;
}

/**
 * `x.name` read of a value holding one of the program's classes, other than `declaredClassName`'s: the name of the class
 * it holds when read, a subclass's included. Not for a hierarchy that declares a static `name`.
 */
export function heldClassName(e: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
	if (e.name.text !== 'name' || isWriteTarget(e) || declaredClassName(e, checker) !== null) return false;
	const t = checker.getNonNullableType(checker.getTypeAtLocation(e.expression));
	if (t.isUnion() || !t.getConstructSignatures().length) return false;
	const d = t.getSymbol()?.valueDeclaration;
	if (!d || !ts.isClassDeclaration(d) || d.getSourceFile().isDeclarationFile) return false;
	// A library base's statics are the platform's: its classes' names are not the program's to give.
	for (let b: ts.ClassLikeDeclaration | undefined = d; b; b = programBase(b, checker)) {
		if (staticName(b, checker) || (b.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) && !programBase(b, checker))) return false;
	}
	return true;
}

function staticName(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
	return cls.members.some((m) => isStatic(m) && !!m.name && !ts.isComputedPropertyName(m.name) && literalKey(m.name, checker) === 'name');
}

/** Collection base methods that runtime `JSMap`/`JSSet` declare `open` so subclasses may override them. */
export const COLLECTION_OVERRIDE_METHODS: Readonly<Record<'Map' | 'Set' | 'Array', readonly string[]>> = {
	Map: ['get', 'set', 'has', 'delete', 'clear'],
	Set: ['add', 'has', 'delete', 'clear'],
	Array: [],
};

/** Built-in collection (`Map`, `Set`, `Array`) a class extends directly or through another program class; null otherwise. */
export function collectionBaseInfo(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): { kind: 'Map' | 'Set' | 'Array'; typeArgs: readonly ts.TypeNode[] } | null {
	const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
	if (!heritage) return null;
	const sym = checker.getSymbolAtLocation(heritage.expression);
	if (ts.isIdentifier(heritage.expression) && (heritage.expression.text === 'Map' || heritage.expression.text === 'Set' || heritage.expression.text === 'Array') && isLibDeclaration(sym?.declarations?.[0])) {
		return { kind: heritage.expression.text, typeArgs: heritage.typeArguments ?? [] };
	}
	const decl = checker.getTypeAtLocation(heritage.expression).getSymbol()?.valueDeclaration;
	return decl && ts.isClassLike(decl) && !decl.getSourceFile().isDeclarationFile ? collectionBaseInfo(decl, checker) : null;
}

/** Instantiated collection base (`Map<K, V>`, `Set<T>`, `Array<T>`) of a type whose class extends a built-in collection. */
export function instantiatedCollectionBase(type: ts.Type, checker: ts.TypeChecker): { kind: 'Map' | 'Set' | 'Array'; typeArgs: ts.Type[] } | null {
	const t = checker.getNonNullableType(type);
	const decl = t.getSymbol()?.valueDeclaration;
	if (!decl || !ts.isClassLike(decl) || decl.getSourceFile().isDeclarationFile) return null;
	const info = collectionBaseInfo(decl, checker);
	if (!info) return null;
	const iterElem = (prop: string): ts.Type | undefined => {
		const sym = checker.getPropertyOfType(t, prop);
		const ret = sym && checker.getTypeOfSymbol(sym).getCallSignatures()[0]?.getReturnType();
		return ret ? checker.getTypeArguments(ret as ts.TypeReference)[0] : undefined;
	};
	if (info.kind === 'Map') {
		const k = iterElem('keys'),
			v = iterElem('values');
		return { kind: 'Map', typeArgs: [k, v].filter((x): x is ts.Type => !!x) };
	}
	if (info.kind === 'Set') {
		const v = iterElem('values');
		return { kind: 'Set', typeArgs: v ? [v] : [] };
	}
	const el = checker.getIndexTypeOfType(t, ts.IndexKind.Number);
	return { kind: 'Array', typeArgs: el ? [el] : [] };
}

/** Whether `type` is a program class extending `Map`/`Set`/`Array` that inherits the collection's `[Symbol.iterator]` without overriding it. */
export function inheritsCollectionIterator(type: ts.Type, checker: ts.TypeChecker): boolean {
	const t = checker.getNonNullableType(type);
	const decl = t.getSymbol()?.valueDeclaration;
	if (!decl || !ts.isClassLike(decl) || decl.getSourceFile().isDeclarationFile || !collectionBaseInfo(decl, checker)) return false;
	for (let b: ts.ClassLikeDeclaration | undefined = decl; b; b = programBase(b, checker)) {
		if (b.members.some((m) => ts.isMethodDeclaration(m) && !isStatic(m) && ts.isComputedPropertyName(m.name) && m.name.expression.getText() === 'Symbol.iterator')) return false;
	}
	return true;
}

/** Whether a class expression inside a function references locals of that enclosing function (cannot be hoisted to module scope). */
export function classExprCaptures(cls: ts.ClassExpression, checker: ts.TypeChecker): boolean {
	const fn = ts.findAncestor(cls.parent, ts.isFunctionLike);
	if (!fn) return false;
	let captures = false;
	const visit = (n: ts.Node): void => {
		if (captures) return;
		if (ts.isIdentifier(n)) {
			const sym = checker.getSymbolAtLocation(n);
			const d = sym?.declarations?.[0];
			const local = !!d && (ts.isParameter(d) || ts.isFunctionDeclaration(d) || ts.isBindingElement(d) || ts.isVariableDeclaration(d) || ts.isClassDeclaration(d));
			if (local && d.getSourceFile() === cls.getSourceFile() && d.pos >= fn.pos && d.end <= fn.end && !(d.pos >= cls.pos && d.end <= cls.end)) {
				captures = true;
				return;
			}
		}
		ts.forEachChild(n, visit);
	};
	ts.forEachChild(cls, visit);
	return captures;
}

/** The `ClassExpression` an expression is directly or via a `const` binding (`const C = class { … }`); null otherwise. */
export function constClassExpr(e: ts.Expression, checker: ts.TypeChecker): ts.ClassExpression | null {
	const inner = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	if (ts.isClassExpression(inner)) return inner;
	if (!ts.isIdentifier(inner)) return null;
	let sym = checker.getSymbolAtLocation(inner);
	if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
	const d = sym?.valueDeclaration;
	if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const && !d.getSourceFile().isDeclarationFile) {
		const init = ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses);
		if (ts.isClassExpression(init)) return init;
	}
	return null;
}

/** Script-visible class name of a class expression: its own name, else its `const` binding's name, else `""`. */
export function classExprScriptName(cls: ts.ClassExpression): string {
	if (cls.name) return cls.name.text;
	if (ts.isVariableDeclaration(cls.parent) && ts.isIdentifier(cls.parent.name)) return cls.parent.name.text;
	return '';
}

/** Registry of generated names and emission state for class expressions in a translation pass. */
export class ClassExprRegistry {
	private readonly names = new Map<ts.ClassExpression, string>();
	readonly emitted = new Set<ts.ClassExpression>();

	name(cls: ts.ClassExpression): string {
		let n = this.names.get(cls);
		if (!n) {
			n = `${cls.name ? cls.name.text : '__ClassExpr'}_${this.names.size}`;
			this.names.set(cls, n);
		}
		return n;
	}
}

/** Whether `t`/`e` is a built-in iterable (`JSArray`/`JSSet`/`JSMap`/`String` or a collection subclass inheriting its iterator). */
export function isBuiltinIterable(t: string, e: ts.Expression, checker: ts.TypeChecker): boolean {
	return /^JS(Array|Set|Map)</.test(t) || t === 'String' || inheritsCollectionIterator(checker.getTypeAtLocation(e), checker);
}

/** Kit collection supertype (`JSMap<K, V>`, `JSSet<T>`, `JSArray<T>`) for a class extending a built-in collection. */
export function spellCollectionBase(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker, render: (t: ts.Type, n: ts.TypeNode) => string): string | null {
	const info = collectionBaseInfo(cls, checker);
	if (!info) return null;
	const args = info.typeArgs.map((a) => render(checker.getTypeFromTypeNode(a), a));
	return info.kind === 'Map' ? `JSMap<${args[0] ?? 'Any?'}, ${args[1] ?? 'Any?'}>` : `JS${info.kind}<${args[0] ?? 'Any?'}>`;
}

/** Instantiated kit collection type (`JSMap<K, V>`, `JSSet<T>`, `JSArray<T>`) for an expression of a collection subclass. */
export function spellInstantiatedCollection(type: ts.Type, checker: ts.TypeChecker, render: (t: ts.Type) => string): string | null {
	const info = instantiatedCollectionBase(type, checker);
	if (!info) return null;
	const args = info.typeArgs.map(render);
	return info.kind === 'Map' ? `JSMap<${args[0] ?? 'Any?'}, ${args[1] ?? 'Any?'}>` : `JS${info.kind}<${args[0] ?? 'Any?'}>`;
}
