// The shapes of what functions return: held generic results, literal results and exported results' fields.
import ts from 'typescript';
import { isUntyped, parseNativeType } from './types.ts';
import type { StateBackend, ValueStates } from './states/value-states.ts';
import { membersOverTypeParameter } from './shape-instance-keys.ts';
import type { ShapeFacts } from './shapes.ts';
import { definedFieldOf, definedKeysIn, definedNamesOf } from './shape-defined-keys.ts';

/**
 * A function or method whose result is a `T & { … }` (see membersOverTypeParameter): held untyped, its calls convert it.
 * A function value's call (a signature of a type) gives an untyped result its call converts already.
 */
export function holdsGenericResult(fn: ts.SignatureDeclaration, checker: ts.TypeChecker): boolean {
	if (!ts.isFunctionDeclaration(fn) && !ts.isMethodDeclaration(fn)) return false;
	const sig = checker.getSignatureFromDeclaration(fn);
	return !!sig && membersOverTypeParameter(checker.getReturnTypeOfSignature(sig), checker);
}

/**
 * A call of such a function instantiating its type parameter with a class (`stamp(new Pos(1, 2))`) whose every return
 * is an object literal: the class's name. The call's type is the class, which a literal's copy is no instance of; a
 * function giving back its argument (`Object.assign(t, { at })`) gives the instance, which the class reads as it is.
 */
export function classOverHeldResult(e: ts.CallExpression, checker: ts.TypeChecker): string | null {
	const decl = checker.getResolvedSignature(e)?.getDeclaration();
	if (!decl || ts.isJSDocSignature(decl) || !holdsGenericResult(decl, checker) || !returnsOnlyLiterals(decl)) return null;
	const t = checker.getTypeAtLocation(e);
	const cls = t.isIntersection() ? t.types.find((u) => (u.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) : undefined;
	return cls ? cls.getSymbol()!.name : null;
}

function returnsOnlyLiterals(fn: ts.SignatureDeclaration): boolean {
	const body = (fn as ts.FunctionLikeDeclaration).body;
	if (!body) return false;
	const literal = (x: ts.Expression | undefined) => !!x && ts.isObjectLiteralExpression(ts.skipOuterExpressions(x));
	if (!ts.isBlock(body)) return literal(body);
	const returns: (ts.Expression | undefined)[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
		if (ts.isReturnStatement(n)) returns.push(n.expression);
		else ts.forEachChild(n, visit);
	};
	ts.forEachChild(body, visit);
	return returns.length > 0 && returns.every(literal);
}

export const classOverHeldResultMessage = (cls: string) => `a generic call's \`T & { … }\` result instantiated with the class \`${cls}\`, which the result is no instance of and which holds none of the members it adds (give the call an interface type argument)`;

/**
 * Library mode: the interfaces `files` declare that are only ever results an app gets back (`PromptResult`, `Size`): of
 * data fields alone, named by a function's or method's result type and by no parameter, field, alias or heritage clause,
 * and a result of what `entry` exports. The library makes the objects, so a class of the interface types them for the
 * code that reads them; every other interface of a library stays an untyped object, as the code it is given to may be
 * handed any object. Each maps to its fields some literal of the library gives an untyped value (`{ result: r }` of an
 * `any` r, which may be undefined where the interface says boolean): those hold any value, as the object would.
 */
export function resultShapesOf(files: readonly ts.SourceFile[], checker: ts.TypeChecker, entry: ts.SourceFile): Map<ts.Symbol, ReadonlySet<string>> {
	const results = new Set<ts.Symbol>(),
		refused = new Set<ts.Symbol>();
	const literals: ts.ObjectLiteralExpression[] = [];
	const own = new Set(files);
	const interfaceOf = (name: ts.EntityName | ts.Expression): ts.Symbol | undefined => {
		let s = checker.getSymbolAtLocation(ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name);
		if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
		return s && s.flags & ts.SymbolFlags.Interface ? s : undefined;
	};
	const role = (ref: ts.Node): 'result' | 'held' | 'other' => {
		let n = ref;
		while (ts.isTypeNode(n.parent) && !ts.isFunctionTypeNode(n.parent) && !ts.isConstructorTypeNode(n.parent)) n = n.parent;
		const p = n.parent;
		if ((ts.isFunctionLike(p) || ts.isFunctionTypeNode(p)) && !ts.isIndexSignatureDeclaration(p) && p.type === n) return 'result';
		if (ts.isVariableDeclaration(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p) || ts.isCallExpression(p) || ts.isNewExpression(p)) return 'other';
		return 'held';
	};
	const visit = (n: ts.Node) => {
		const named = ts.isTypeReferenceNode(n) ? n.typeName : ts.isExpressionWithTypeArguments(n) ? n.expression : undefined;
		const sym = named && interfaceOf(named);
		if (sym) {
			const r = ts.isExpressionWithTypeArguments(n) ? 'held' : role(n);
			if (r === 'result') results.add(sym);
			else if (r === 'held') refused.add(sym);
		}
		if (ts.isObjectLiteralExpression(n)) literals.push(n);
		ts.forEachChild(n, visit);
	};
	for (const f of files) visit(f);
	const data = (sym: ts.Symbol) => !!sym.declarations?.length && sym.declarations.every((d) => ts.isInterfaceDeclaration(d) && own.has(d.getSourceFile()) && !d.typeParameters && !d.heritageClauses && d.members.length > 0 && d.members.every((m) => ts.isPropertySignature(m) && !!m.type && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))));
	const exported = exportedResults(entry, checker);
	const shapes = new Map<ts.Symbol, Set<string>>();
	for (const s of results) if (!refused.has(s) && data(s) && exported.has(s.name)) shapes.set(s, new Set());
	const untyped = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	for (const e of literals) {
		const contextual = checker.getContextualType(e);
		const of = contextual && (contextual.isUnion() ? contextual.types : [contextual]).map((u) => u.getSymbol()).find((s) => !!s && shapes.has(s));
		if (!of) continue;
		const fields = shapes.get(of)!;
		for (const p of e.properties) {
			if (ts.isSpreadAssignment(p) && untyped(checker.getTypeAtLocation(p.expression))) for (const m of of.declarations!.flatMap((d) => (d as ts.InterfaceDeclaration).members)) fields.add(m.name!.getText().replace(/^['"]|['"]$/g, ''));
			const value = ts.isPropertyAssignment(p) ? checker.getTypeAtLocation(p.initializer) : ts.isShorthandPropertyAssignment(p) ? checker.getTypeAtLocation(p.name) : undefined;
			const key = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
			if (value && key && untyped(value)) fields.add(key);
		}
	}
	return shapes;
}

/**
 * The names of the interfaces the API a module exports gives back: what its functions, its classes' members and its
 * objects' functions return (through promises, arrays and unions), its namespaces' included. By name, as the module's
 * declarations may declare an interface apart from the source that makes its objects (`ui/dialogs/index.d.ts`).
 */
function exportedResults(entry: ts.SourceFile, checker: ts.TypeChecker): Set<string> {
	const names = new Set<string>();
	const seen = new Set<ts.Symbol>();
	const result = (t: ts.Type): void => {
		if (t.isUnion()) {
			t.types.forEach(result);
			return;
		}
		const s = t.getSymbol();
		if (s?.name === 'Promise' || checker.isArrayType(t)) {
			checker.getTypeArguments(t as ts.TypeReference).forEach(result);
			return;
		}
		if (s && s.flags & ts.SymbolFlags.Interface && !(s.flags & ts.SymbolFlags.Class)) names.add(s.name);
	};
	const returns = (t: ts.Type) => {
		for (const sig of t.getCallSignatures()) result(sig.getReturnType());
	};
	const members = (t: ts.Type, at: ts.Node) => {
		for (const p of t.getProperties()) {
			if (p.declarations?.every((d) => ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected))) continue;
			const pt = checker.getTypeOfSymbolAtLocation(p, at);
			result(pt);
			returns(pt);
		}
	};
	const visit = (sym: ts.Symbol, at: ts.Node) => {
		if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
		if (seen.has(sym)) return;
		seen.add(sym);
		if (sym.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) for (const x of checker.getExportsOfModule(sym)) visit(x, at);
		if (sym.flags & ts.SymbolFlags.Class) {
			members(checker.getDeclaredTypeOfSymbol(sym), at);
			members(checker.getTypeOfSymbolAtLocation(sym, at), at);
		} else if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) {
			const t = checker.getTypeOfSymbolAtLocation(sym, at);
			returns(t);
			members(t, at);
		}
	};
	const module = checker.getSymbolAtLocation(entry);
	if (module) for (const x of checker.getExportsOfModule(module)) visit(x, entry);
	return names;
}

/** The field `definedNamesOf` lists that `key` of the object names, if any (`const { field } = obj`, `obj['field']`); none in a library. */
export function definedField(states: ValueStates, facts: () => ShapeFacts, object: ts.Node, key: string): ts.NamedDeclaration | undefined {
	return states.backend.library ? undefined : definedFieldOf(object, key, states.backend.checker, definedKeysIn(states), (c) => definedNamesOf(c, states, facts()));
}

/** What the result-interface questions read from a translator: library mode's result shapes, and the type the backend gives a member of a core result interface. */
export interface ResultFields extends Pick<StateBackend, 'checker' | 'resolve'> {
	readonly library: { readonly resultShapes?: ReadonlyMap<ts.Symbol, ReadonlySet<string>> } | null;
	resultFieldType(m: ts.TypeElement): string | null;
}

/** A member of a result interface of core's that the kit's class holds untyped (`PromptResult.result`), read as it holds it. */
export function untypedResultField(b: ResultFields, sym: ts.Symbol | undefined): boolean {
	if (b.library) return false;
	const decl = sym?.declarations?.[0];
	const held = !!decl && ts.isPropertySignature(decl) ? b.resultFieldType(decl) : null;
	return held !== null && isUntyped(parseNativeType(held));
}

/** A variable a pattern binds from such a member (`const { result } = await Dialogs.prompt(…)`). */
export function untypedResultBinding(b: ResultFields, n: ts.Node): boolean {
	if (b.library) return false;
	const d = ts.isBindingElement(n) ? n : ts.isIdentifier(n) ? (ts.isBindingElement(n.parent) && n.parent.name === n ? n.parent : b.resolve(n)?.valueDeclaration) : undefined;
	if (!d || !ts.isBindingElement(d) || !ts.isObjectBindingPattern(d.parent) || d.dotDotDotToken) return false;
	const key = d.propertyName ?? d.name;
	return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && untypedResultField(b, b.checker.getTypeAtLocation(d.parent).getProperty(key.text));
}

/** Library mode: whether `name` is the class of a result interface of core's (`resultShapesOf`). */
export function resultShapeNamed(b: Pick<ResultFields, 'library'>, name: string): boolean {
	return [...(b.library?.resultShapes?.keys() ?? [])].some((s) => s.name === name);
}
