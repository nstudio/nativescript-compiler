// The keys an instance gets beyond its declaration: implemented optional members, Object.defineProperty, expandos and undeclared members.
import ts from 'typescript';
import { classesHeldUntyped, hasStatic, literalKey, literalMethod, mergedInterfaceMemberOf, undeclaredMemberOf } from './lang.ts';
import { downcast } from './nullish.ts';
import { programBase } from './classes.ts';

/** An optional interface property named by an identifier. */
type NamedSignature = ts.PropertySignature & { name: ts.Identifier };

const implementedMemo = new WeakMap<ts.TypeChecker, Map<ts.ClassLikeDeclaration, NamedSignature[]>>();

/**
 * The optional properties of the program's interfaces a class implements (theirs and the interfaces' they extend) that
 * neither the class nor any class it extends declares, nor a program base implements already: fields its objects
 * have as keys once written (`presence: 'written'`), as script's objects do. A method signature is no such field.
 */
export function implementedOptionalMembers(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): NamedSignature[] {
	let memo = implementedMemo.get(checker);
	if (!memo) implementedMemo.set(checker, (memo = new Map()));
	const known = memo.get(cls);
	if (known) return known;
	memo.set(cls, []);
	const taken = new Set<string>();
	for (let b = programBase(cls, checker); b; b = programBase(b, checker)) for (const m of implementedOptionalMembers(b, checker)) taken.add(m.name.text);
	const own = checker.getTypeAtLocation(cls.name ?? cls);
	const out: NamedSignature[] = [];
	for (const i of cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? []) {
		const t = checker.getTypeAtLocation(i);
		if (!t.getSymbol()?.declarations?.some((d) => ts.isInterfaceDeclaration(d) && !d.getSourceFile().isDeclarationFile)) continue;
		for (const p of t.getProperties()) {
			const d = p.valueDeclaration;
			if (!(p.flags & ts.SymbolFlags.Optional) || !d || !ts.isPropertySignature(d) || !ts.isIdentifier(d.name) || d.getSourceFile().isDeclarationFile) continue;
			if (taken.has(p.name) || own.getProperty(p.name)) continue;
			taken.add(p.name);
			out.push(d as NamedSignature);
		}
	}
	memo.set(cls, out);
	return out;
}

function sourceRootOf(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ts.ClassLikeDeclaration {
	let r = cls;
	for (let b = programBase(r, checker); b; b = programBase(b, checker)) r = b;
	return r;
}

/** `Object.defineProperty(…)` or `Object.defineProperties(…)`, `Object` the global. */
function objectDefineCall(n: ts.Node, checker: ts.TypeChecker): n is ts.CallExpression {
	if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || !['defineProperty', 'defineProperties'].includes(n.expression.name.text)) return false;
	const o = n.expression.expression;
	if (!ts.isIdentifier(o) || o.text !== 'Object') return false;
	const decl = checker.getSymbolAtLocation(o)?.declarations?.[0];
	return !decl || decl.getSourceFile().isDeclarationFile;
}

/**
 * The program's instance methods an object may hold its own value for: given by `Object.defineProperty(this, …)`,
 * `Object.defineProperties(this, …)`, an object literal of their class (`literalClass`), or an assignment (`obj.m = fn`;
 * not through `X.prototype` or `super`). Every declaration of such a method is in the set, its overloads too.
 */
export function instanceKeysOf(files: readonly ts.SourceFile[], checker: ts.TypeChecker, literalClass: (e: ts.ObjectLiteralExpression) => ts.ClassDeclaration | null | undefined): Set<ts.MethodDeclaration> {
	const keys = new Set<ts.MethodDeclaration>();
	const add = (sym: ts.Symbol | undefined) => {
		const decls = sym?.declarations?.filter((d): d is ts.MethodDeclaration => ts.isMethodDeclaration(d) && !literalMethod(d) && !d.getSourceFile().isDeclarationFile && !hasStatic(d)) ?? [];
		for (const d of decls) keys.add(d);
	};
	const methodOf = (cls: ts.ClassLikeDeclaration | null | undefined, key: string) => {
		const sym = cls?.name && checker.getSymbolAtLocation(cls.name);
		if (sym) add(checker.getDeclaredTypeOfSymbol(sym).getProperty(key));
	};
	const visit = (n: ts.Node) => {
		if (objectDefineCall(n, checker) && n.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword && n.arguments[1]) {
			const cls = ts.findAncestor(n, ts.isClassLike),
				map = n.arguments[1];
			if ((n.expression as ts.PropertyAccessExpression).name.text === 'defineProperty') {
				if (ts.isStringLiteralLike(map)) methodOf(cls, map.text);
			} else if (ts.isObjectLiteralExpression(map)) for (const p of map.properties) if (p.name && !ts.isComputedPropertyName(p.name)) methodOf(cls, literalKey(p.name, checker) ?? p.name.getText());
		}
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.expression.kind !== ts.SyntaxKind.SuperKeyword && !(ts.isPropertyAccessExpression(n.left.expression) && n.left.expression.name.text === 'prototype')) {
			const sym = checker.getSymbolAtLocation(n.left.name);
			add(sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
		}
		if (ts.isObjectLiteralExpression(n)) {
			const cls = literalClass(n);
			if (cls) for (const p of n.properties) if (p.name && !ts.isComputedPropertyName(p.name)) methodOf(cls, p.name.getText());
		}
		ts.forEachChild(n, visit);
	};
	for (const sf of files) if (!sf.isDeclarationFile) visit(sf);
	return keys;
}

/** Whether a method is one of `instanceKeysOf`'s, or overrides one a program base class declares. */
export function replaceableMethod(d: ts.Declaration | undefined, keys: ReadonlySet<ts.MethodDeclaration>, checker: ts.TypeChecker): boolean {
	if (!d || !ts.isMethodDeclaration(d) || !keys.size) return false;
	if (keys.has(d)) return true;
	if (!ts.isClassLike(d.parent)) return false;
	const name = d.name.getText();
	for (let c = programBase(d.parent, checker); c; c = programBase(c, checker)) {
		if (c.members.some((m) => ts.isMethodDeclaration(m) && keys.has(m) && m.name.getText() === name)) return true;
	}
	return false;
}

/**
 * App mode: the program classes, each the root of its program hierarchy, whose objects keep what script gives them
 * beyond their declared members: undeclared members (`classesGivenUndeclaredMembers`), objects held untyped
 * (`classesHeldUntyped`), `Object.defineProperty`/`defineProperties` targets, and `instanceKeys`' classes.
 */
export function expandoRootsOf(files: readonly ts.SourceFile[], checker: ts.TypeChecker, instanceKeys: ReadonlySet<ts.MethodDeclaration>): Set<ts.ClassLikeDeclaration> {
	const roots = new Set([...classesGivenUndeclaredMembers(files, checker), ...classesHeldUntyped(files, checker)]);
	const visit = (n: ts.Node) => {
		if (objectDefineCall(n, checker) && n.arguments[0]) {
			const cls = checker.getNonNullableType(checker.getTypeAtLocation(n.arguments[0])).getSymbol()?.valueDeclaration;
			if (cls && ts.isClassLike(cls) && !cls.getSourceFile().isDeclarationFile) roots.add(sourceRootOf(cls, checker));
		}
		const merged = ts.isPropertyAccessExpression(n) ? mergedInterfaceMemberOf(n, checker) : null;
		if (merged) roots.add(sourceRootOf(merged, checker));
		ts.forEachChild(n, visit);
	};
	for (const sf of files) if (!sf.isDeclarationFile) visit(sf);
	for (const d of instanceKeys) if (ts.isClassLike(d.parent)) roots.add(sourceRootOf(d.parent, checker));
	return roots;
}

/**
 * `Object.defineProperty(target, key, …)` with a key known only at run time, or `Object.defineProperties(target, map)` with
 * a map that is no literal of literal keys, on an untyped target (any, unknown, object, a type parameter).
 */
export function definesRunTimeKey(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
	const [target, key] = call.arguments;
	if (!target || !key || !ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== 'Object') return false;
	if (ts.isPropertyAccessExpression(target) && target.name.text === 'prototype') return false;
	const t = checker.getTypeAtLocation(target);
	if (!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive | ts.TypeFlags.TypeParameter))) return false;
	if (call.expression.name.text === 'defineProperty') {
		const k = checker.getTypeAtLocation(key);
		return !(k.isUnion() ? k.types : [k]).every((x) => x.isStringLiteral() || x.isNumberLiteral());
	}
	if (call.expression.name.text !== 'defineProperties') return false;
	return !ts.isObjectLiteralExpression(key) || key.properties.some((p) => !p.name || literalKey(p.name, checker) == null);
}

/** The program classes, each the root of its program hierarchy, whose instances are given members their classes don't declare. */
export function classesGivenUndeclaredMembers(files: readonly ts.SourceFile[], checker: ts.TypeChecker): Set<ts.ClassLikeDeclaration> {
	const roots = new Set<ts.ClassLikeDeclaration>();
	const baseOf = (cls: ts.ClassLikeDeclaration) => programBase(cls, checker);
	const visit = (n: ts.Node) => {
		if (ts.isPropertyAccessExpression(n)) {
			let cls = undeclaredMemberOf(n, checker);
			for (let b = cls && baseOf(cls); b; b = baseOf(b)) cls = b;
			if (cls) roots.add(cls);
		}
		// A member written through a downcast (`(view as TextField).hint = …`, held untyped): the object may be another class's.
		if (ts.isPropertyAccessExpression(n) && ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
			let r: ts.Node = ts.skipParentheses(n.expression);
			const v = ts.isIdentifier(r) ? checker.getSymbolAtLocation(r)?.valueDeclaration : undefined;
			if (v && ts.isVariableDeclaration(v) && !v.type && v.initializer && ts.isVariableStatement(v.parent.parent)) r = ts.skipParentheses(v.initializer);
			if ((ts.isAsExpression(r) || ts.isTypeAssertionExpression(r)) && downcast(checker, r, (d) => !!d && !d.getSourceFile().isDeclarationFile)) {
				const from = checker.getNonNullableType(checker.getTypeAtLocation(r.expression));
				const visitClasses = (x: ts.Node): void => {
					if (ts.isClassLike(x) && checker.isTypeAssignableTo(checker.getTypeAtLocation(x.name ?? x), from)) {
						let cls: ts.ClassLikeDeclaration | undefined = x;
						for (let b = baseOf(x); b; b = baseOf(b)) cls = b;
						roots.add(cls);
					}
					ts.forEachChild(x, visitClasses);
				};
				for (const sf of files) if (!sf.isDeclarationFile) visitClasses(sf);
			}
		}
		// `Object.defineProperty(instance, key, …)`, `Object.defineProperties(instance, …)`: members its class does not declare.
		if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Object' && ['defineProperty', 'defineProperties'].includes(n.expression.name.text) && n.arguments.length) {
			let cls: ts.ClassLikeDeclaration | undefined;
			const d = checker.getTypeAtLocation(n.arguments[0]).getSymbol()?.valueDeclaration;
			if (d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile) cls = d;
			for (let b = cls && baseOf(cls); b; b = baseOf(b)) cls = b;
			if (cls) roots.add(cls);
		}
		ts.forEachChild(n, visit);
	};
	for (const sf of files) if (!sf.isDeclarationFile) visit(sf);
	return roots;
}

/**
 * A type parameter joined with members (`T & { at: number }`): no one shape holds every instantiation's keys, so the
 * value is held untyped and a call instantiating it converts its result to the caller's type.
 */
export function membersOverTypeParameter(t: ts.Type, checker: ts.TypeChecker): boolean {
	const param = (u: ts.Type) => !!(u.flags & ts.TypeFlags.TypeParameter) && !(u as ts.TypeParameter & { isThisType?: boolean }).isThisType;
	if (!t.isIntersection() || !t.types.some(param)) return false;
	const members = t.types.filter((u) => !param(u));
	return members.length > 0 && members.every((u) => !!(u.flags & ts.TypeFlags.Object) && !u.getCallSignatures().length && !u.getConstructSignatures().length && u.getProperties().length > 0) && members.some((u) => u.getProperties().some((p) => !(checker.getTypeOfSymbol(p).flags & ts.TypeFlags.Unknown)));
}
