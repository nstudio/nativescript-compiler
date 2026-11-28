import ts from 'typescript';
import { isLibDeclaration, isSymbolAsyncIterator, isSymbolIterator } from './ast.ts';
import { SHIM_GLOBAL_OBJECT_VARS } from './globals.ts';
import { implementedInterfaces } from './lang/members.ts';
export { evolvingArrayRead, evolvingArrayType, evolvingElementContext, spreadOperand, openSpreadType, intersectionAliasMembers, iterationThrows, iteratedType, iteratesCheckedResult } from './lang/arrays.ts';
export { unsafeReceiver, uncheckedMatch, leadingNeverRead, redeclaredBeside, thisArgCall, withoutThisArg, thisArgBound, takesReceiver, ignoresThisArg } from './lang/this-args.ts';
export type { ThisArgUse } from './lang/this-args.ts';
export { isAmbientClass, ambientBase, ambientAddedMemberOf, implementedInterfaces, runtimeTypeName, mergedInterfaceMemberOf, augmentedPropertyRead, optionalBodilessMethod, undeclaredMemberOf, classesHeldUntyped, hasStatic, admitsUndefined, assertedOperand, undefinedLiteral, onlyUndefined, resultsAreUndefinedElements, implementedInterfaceDeclarations, accessedDeclaration, memberOwner, namesOwnTypeParameter } from './lang/members.ts';
export { slotType, nullSetFields, initializedNull, assignedValues, definitelyAssignedFields, containsThis, alwaysThrows, alwaysEnds, statementLevel } from './lang/fields.ts';
export { readWrite, compoundOperator, asOperation, assignmentOf, globalProxyUse, builtinPrototypeAlias, aliasedPrototypeMember, tokenClassBase, isArguments, escapesArguments, canReadArguments, inferredFunctionName, functionProperty, isConstant, isSelf, objectMethod, literalMethod, prototypeAlias, methodValues } from './lang/prototypes.ts';
export type { ReadWrite } from './lang/prototypes.ts';

// JavaScript semantics both translators share, decided from the syntax tree and the checker.

/** Whether `t`'s symbol has an explicit `interface` declaration (not a mapped/`Pick` type alias erased to `Any?`). */
export function isEmittedInterface(t: ts.Type): boolean {
	return (t.getSymbol()?.declarations ?? []).some(ts.isInterfaceDeclaration);
}

/** A type written with `| null` or `| undefined`, which code checked without strictNullChecks types without them. */
export function nullableTypeNode(t: ts.TypeNode | undefined): boolean {
	return !!t && ts.isUnionTypeNode(t) && t.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword));
}

/** The `Intl` constructors both runtimes have, each with the members its instances have. */
export const INTL_MODELLED = { NumberFormat: ['format', 'resolvedOptions'], DateTimeFormat: ['format', 'resolvedOptions'], Collator: ['compare', 'resolvedOptions'] } as const satisfies Record<string, readonly string[]>;

/** `Intl.NumberFormat` or `Intl.DateTimeFormat`, as the library declares `Intl`: which one. */
export function intlConstructor(e: ts.Expression, checker: ts.TypeChecker): keyof typeof INTL_MODELLED | null {
	if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'Intl') return null;
	if (!checker.getSymbolAtLocation(e.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return null;
	return Object.hasOwn(INTL_MODELLED, e.name.text) ? (e.name.text as keyof typeof INTL_MODELLED) : null;
}

/**
 * A `let` or `const`: a read before its declaration runs throws a ReferenceError (the temporal dead zone), so no read
 * sees it unset. A `var` reads undefined there.
 */
export function deadZoneBinding(d: ts.VariableDeclaration): boolean {
	return ts.isVariableDeclarationList(d.parent) && !!(d.parent.flags & ts.NodeFlags.BlockScoped);
}

/** One binding of a `classStaticsPattern`: the name it declares, the static's key, and the static. */
export interface StaticBinding {
	name: ts.Identifier;
	key: string;
	member: ts.Symbol;
}

/**
 * An object pattern of plain names and renames destructuring a class named directly (`const { A, B: b } = X`, `X` a
 * class or a namespace's class): JavaScript reads `X`'s static properties, each once, in order, exactly as
 * `const A = X.A, b = X.B` reads them. Its bindings; null for any other pattern, or one naming a static method.
 */
export function classStaticsPattern(d: ts.VariableDeclaration, checker: ts.TypeChecker): StaticBinding[] | null {
	if (!ts.isObjectBindingPattern(d.name) || !d.initializer) return null;
	const init = ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses);
	const plain = (e: ts.Expression): boolean => ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && !e.questionDotToken && plain(e.expression));
	if (!plain(init)) return null;
	let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(init) ? init.name : init);
	if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
	if (!sym || !(sym.flags & ts.SymbolFlags.Class)) return null;
	const statics = checker.getTypeAtLocation(init);
	const out: StaticBinding[] = [];
	for (const el of d.name.elements) {
		if (el.dotDotDotToken || el.initializer || !ts.isIdentifier(el.name)) return null;
		const key = el.propertyName ?? el.name;
		if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return null;
		const member = statics.getProperty(key.text);
		const decl = member?.declarations?.[0];
		if (!member || !decl || !(ts.isPropertyDeclaration(decl) || ts.isAccessor(decl)) || !ts.isClassLike(decl.parent) || !(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Static)) return null;
		out.push({ name: el.name, key: key.text, member });
	}
	return out;
}

/** A setter that only assigns its value to a member of `this`'s (`this.style.color = value`): that member. */
export function forwardedSetter(set: ts.FunctionLikeDeclaration): ts.PropertyAccessExpression | null {
	const params = set.parameters.filter((q) => !(ts.isIdentifier(q.name) && q.name.text === 'this'));
	const p = params.length === 1 ? params[0] : undefined;
	const only = set.body && ts.isBlock(set.body) && set.body.statements.length === 1 ? set.body.statements[0] : undefined;
	if (!p || !ts.isIdentifier(p.name) || !only || !ts.isExpressionStatement(only)) return null;
	const e = only.expression;
	if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(e.right) || e.right.text !== p.name.text || !ts.isPropertyAccessExpression(e.left)) return null;
	let base: ts.Expression = e.left.expression;
	while (ts.isPropertyAccessExpression(base) || ts.isParenthesizedExpression(base) || ts.isAsExpression(base)) base = base.expression;
	return base.kind === ts.SyntaxKind.ThisKeyword ? e.left : null;
}

/** `String.raw` as the library declares it. */
export function isStringRaw(tag: ts.Expression, checker: ts.TypeChecker): boolean {
	if (!ts.isPropertyAccessExpression(tag) || tag.name.text !== 'raw' || !ts.isIdentifier(tag.expression) || tag.expression.text !== 'String') return false;
	return !!checker.getSymbolAtLocation(tag.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * The target of `(m ??= new Map())` read as a collection: the checker types the untyped `new Map()` into the expression,
 * so the collection's entry types are the target's.
 */
export function nullishAssignTarget(e: ts.Expression): ts.Expression | undefined {
	const bare = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	return ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ? bare.left : undefined;
}

/** A spread argument every element of which is an array (`a.concat(...lists)`): `concat` adds each one's elements. */
export function spreadsArrays(e: ts.Expression, checker: ts.TypeChecker): boolean {
	const t = checker.getTypeAtLocation(e);
	const elements = checker.isTupleType(t) ? checker.getTypeArguments(t as ts.TypeReference) : [checker.getIndexTypeOfType(t, ts.IndexKind.Number)];
	return elements.length > 0 && elements.every((el) => !!el && (el.isUnion() ? el.types : [el]).every((u) => checker.isArrayType(u) || checker.isTupleType(u)));
}

/**
 * A name the app only declares (`declare const x`), outside the names a
 * bundler defines (`__DEV__`, `__IOS__`), or a member the language's library
 * does not declare on one of its globals (`Reflect.metadata`, which a shim
 * adds): nothing defines it at run time, so `typeof` reads it as undefined.
 */
export function neverDefined(e: ts.Expression, checker: ts.TypeChecker): boolean {
	if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
		const decls = checker.getSymbolAtLocation(e.expression)?.declarations;
		return !!decls?.length && decls.every((d) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(d.getSourceFile().fileName)) && !checker.getTypeAtLocation(e.expression).getProperty(e.name.text);
	}
	if (!ts.isIdentifier(e) || e.text.startsWith('__')) return false;
	const decls = checker.getSymbolAtLocation(e)?.declarations;
	return !!decls?.length && decls.every((d) => !d.getSourceFile().isDeclarationFile && !!(d.flags & ts.NodeFlags.Ambient));
}

/** A template's cooked and raw strings and its substitutions. */
export function templateParts(t: ts.TemplateLiteral): { cooked: string[]; raw: string[]; values: ts.Expression[] } {
	if (ts.isNoSubstitutionTemplateLiteral(t)) return { cooked: [t.text], raw: [t.rawText ?? t.text], values: [] };
	return {
		cooked: [t.head.text, ...t.templateSpans.map((s) => s.literal.text)],
		raw: [t.head.rawText ?? t.head.text, ...t.templateSpans.map((s) => s.literal.rawText ?? s.literal.text)],
		values: t.templateSpans.map((s) => s.expression),
	};
}

/** `Object.prototype.toString.call`, as the library declares `Object`. */
export function isObjectToStringCall(callee: ts.Expression, checker: ts.TypeChecker): boolean {
	if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'call') return false;
	const fn = callee.expression;
	if (!ts.isPropertyAccessExpression(fn) || fn.name.text !== 'toString' || !ts.isPropertyAccessExpression(fn.expression) || fn.expression.name.text !== 'prototype') return false;
	const owner = fn.expression.expression;
	return ts.isIdentifier(owner) && owner.text === 'Object' && !!checker.getSymbolAtLocation(owner)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile);
}

/** A property name as the key it makes: computed names only when the checker knows their literal value. */
export function literalKey(name: ts.PropertyName, checker: ts.TypeChecker): string | null {
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
	if (ts.isNumericLiteral(name)) return String(Number(name.text.replace(/_/g, '')));
	if (ts.isComputedPropertyName(name)) {
		const t = checker.getTypeAtLocation(name.expression);
		if (t.isStringLiteral()) return t.value;
		if (t.isNumberLiteral()) return String(t.value);
	}
	return null;
}

/** Keys in the order JavaScript enumerates an object's own keys: array indexes ascending, then the rest as written. */
export function jsKeyOrder(keys: string[]): string[] {
	const index = (k: string) => /^(0|[1-9]\d{0,9})$/.test(k) && Number(k) < 4294967295;
	return [...keys.filter(index).sort((a, b) => Number(a) - Number(b)), ...keys.filter((k) => !index(k))];
}

/** The kit's names for members a well-known symbol names (`[Symbol.iterator]`, `__@iterator@12` in the checker). */
export const WELL_KNOWN_MEMBERS: Record<string, string> = { iterator: 'jsSymbolIterator', asyncIterator: 'jsSymbolAsyncIterator', toPrimitive: 'jsToPrimitive', toStringTag: 'jsToStringTag', dispose: 'jsSymbolDispose', asyncDispose: 'jsSymbolAsyncDispose', hasInstance: 'jsHasInstance' };

/** A property's name as the checker spells a well-known symbol's (`__@iterator@12`): the kit's member name. */
export function wellKnownMember(name: string): string | null {
	const m = /^__@(\w+)@\d+$/.exec(name);
	return m ? (WELL_KNOWN_MEMBERS[m[1]] ?? null) : null;
}

/** An object type of only RegExp's protocol methods (the string methods' `{ [Symbol.replace](…) }` overloads): a RegExp, the one object the kits give them. */
export function isRegExpProtocol(t: ts.Type): boolean {
	if (!(t.flags & ts.TypeFlags.Object) || !((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous)) return false;
	const own = t.getProperties();
	return own.length > 0 && own.every((p) => /^__@(replace|split|match|matchAll|search)@\d+$/.test(p.name));
}

/** An assertion from untyped to RegExp's protocol methods (`x as any as { [Symbol.replace](…) }`), alone or as a `? :` branch: its value may be anything, not only a RegExp. */
export function assertedPattern(x: ts.Expression, checker: ts.TypeChecker): boolean {
	x = ts.skipParentheses(x);
	if (ts.isConditionalExpression(x)) return assertedPattern(x.whenTrue, checker) || assertedPattern(x.whenFalse, checker);
	return (ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)) && isRegExpProtocol(checker.getTypeAtLocation(x)) && !!(checker.getTypeAtLocation(x.expression).flags & ts.TypeFlags.Any);
}

/**
 * `replace`/`replaceAll` given a replacement known only when it runs: an untyped one, or one that may be a function for a
 * pattern that may be a string. Both go to the kit untyped, which dispatches on the replacement's `typeof`.
 */
export function boxedReplacement(name: string, call: ts.CallExpression, checker: ts.TypeChecker): boolean {
	const [pattern, replacement] = call.arguments;
	if ((name !== 'replace' && name !== 'replaceAll') || !pattern || !replacement) return false;
	const r = checker.getTypeAtLocation(replacement);
	if (r.flags & ts.TypeFlags.Any) return true;
	if (!r.getCallSignatures().length) return false;
	const t = checker.getTypeAtLocation(pattern);
	const regexp = (x: ts.Type) => x.getSymbol()?.name === 'RegExp' || isRegExpProtocol(x);
	return !(t.isUnion() ? t.types.every(regexp) : regexp(t)) || assertedPattern(pattern, checker);
}

/** Whether `decls` describe a browser/web global value whose runtime value lives on `jsGlobalThis`. */
export function isDomGlobalDeclaration(name: string, decls: readonly ts.Declaration[]): boolean {
	if (SHIM_GLOBAL_OBJECT_VARS.has(name) && decls.some((d) => d.getSourceFile().fileName === '/__shims__/globals.d.ts') && decls.every((d) => d.getSourceFile().isDeclarationFile)) return true;
	return decls.every((d) => /[\\/](?:lib\.(dom|webworker)[\w.]*\.d\.ts|@types[\\/]node[\\/]web-globals[\\/].*\.d\.ts)$/.test(d.getSourceFile().fileName) && (ts.isVariableDeclaration(d) || ts.isFunctionDeclaration(d)));
}

/** Whether a well-known symbol member is a disposer (`[Symbol.dispose]` / `[Symbol.asyncDispose]`). */
export function isDisposerMember(member: string): boolean {
	return member === 'jsSymbolDispose' || member === 'jsSymbolAsyncDispose';
}

/** Well-known symbol methods emitted directly on the class without a dynamic symbol dispatch table (`Symbol.dispose`, `Symbol.asyncDispose`, `Symbol.hasInstance`). */
export function isDirectSymbolMethod(member: string): boolean {
	return isDisposerMember(member) || member === 'jsHasInstance';
}

/** Framework-hooked dynamic `import('...')` call; null if unhandled. */
export function hookedDynamicImport(e: ts.CallExpression, hooks: { dynamicImport?(specifier: string): string | null | undefined }): string | null {
	return e.expression.kind === ts.SyntaxKind.ImportKeyword && e.arguments[0] && ts.isStringLiteral(e.arguments[0]) ? (hooks.dynamicImport?.(e.arguments[0].text) ?? null) : null;
}

/** Whether the non-nullable form of `t` is an uninstantiated type parameter (`{} as TContext`). */
export function isTypeParameterType(t: ts.Type, checker: ts.TypeChecker): boolean {
	return !!(checker.getNonNullableType(t).flags & ts.TypeFlags.TypeParameter);
}

/** A protocol/interface method's native name, mapping `[Symbol.iterator]` and `[Symbol.asyncIterator]` to their runtime names. */
export function protocolMethodName(name: ts.PropertyName, checker: ts.TypeChecker, escape: (raw: string) => string): string {
	if (ts.isComputedPropertyName(name)) {
		if (isSymbolIterator(name.expression, checker)) return 'jsSymbolIterator';
		if (isSymbolAsyncIterator(name.expression, checker)) return 'jsSymbolAsyncIterator';
	}
	return escape(name.getText());
}

/** Dollar-only JS identifiers (`$`, `$$`) mapped clear of Swift/Kotlin wildcard `_`. */
export function dollarIdent(name: string): string | null {
	return /^\$+$/.test(name) ? (name.length === 1 ? '__dollar' : `__dollar${name.length}`) : null;
}

/** Strips backtick keyword escaping so a name can be embedded in synthetic identifiers (`__get_<k>`, `__tdz_get_<k>`). */
export function unquoted(name: string): string {
	return name.replace(/`/g, '');
}

/** An expression already hoisted into `subst` (e.g. an `await`-bearing branch); null if not substituted. */
export function substitutedExpr(subst: ReadonlyMap<ts.Node, string>, e: ts.Expression, branchingOnly = false): { bare: ts.Expression; code: string } | null {
	const bare = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	const code = subst.get(bare);
	if (code === undefined) return null;
	if (branchingOnly && !ts.isConditionalExpression(bare) && !ts.isBinaryExpression(bare)) return null;
	return { bare, code };
}

/** Member names of declared TypeScript interfaces left out of a class's native conformances, so dynamic views (`fromJS` / `init(jsObject:)`) can read them by name. */
export function droppedProtocolMemberNames(
	checker: ts.TypeChecker,
	cls: ts.ClassLikeDeclaration,
	protocols: ReadonlySet<string>,
	implemented: readonly string[],
	ifaceName: (i: ts.ExpressionWithTypeArguments) => string,
	skipped: (i: ts.ExpressionWithTypeArguments, t: ts.Type, name: string) => boolean,
): Set<string> {
	const out = new Set<string>();
	for (const i of implementedInterfaces(checker, cls)) {
		const t = checker.getTypeAtLocation(i);
		if (!isEmittedInterface(t) || isLibDeclaration(t.getSymbol()?.declarations?.[0])) continue;
		const name = ifaceName(i);
		if (!protocols.has(name) || implemented.includes(name) || skipped(i, t, name)) continue;
		for (const p of t.getProperties()) out.add(p.name);
	}
	return out;
}

/** Whether dotted version `a` is newer than `b` (when `preferStable` is set, releases without `-` outrank prereleases). */
export function newerVersion(a: string, b: string, preferStable = false): boolean {
	if (preferStable) {
		const sa = !/-/.test(a),
			sb = !/-/.test(b);
		if (sa !== sb) return sa;
	}
	const key = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
	const ka = key(a),
		kb = key(b);
	for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (ka[i] ?? 0) > (kb[i] ?? 0);
	return false;
}

/** The unwrapped initializer of an untyped variable declaration reached from `n` (declaration or identifier), or null. */
export function untypedVariableInitializer(n: ts.Node, resolve: (id: ts.Identifier) => ts.Symbol | undefined): ts.Expression | null {
	const d = ts.isVariableDeclaration(n) ? n : ts.isIdentifier(n) ? (ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent : resolve(n)?.valueDeclaration) : undefined;
	return d && ts.isVariableDeclaration(d) && !d.type && d.initializer ? ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses) : null;
}

/** Whether a built-in primitive constructor value (`Number`, `String`, `Boolean`) is a singleton constructor reference (`jsNumberConstructor`) or a typed converter slot. */
export function builtinConstructorSlot(e: ts.Identifier, checker: ts.TypeChecker, isUntypedContext: (t: ts.Type) => boolean): { singleton?: string; slot?: ts.Signature } {
	const context = checker.getContextualType(e);
	const slot = context && checker.getNonNullableType(context).getCallSignatures()[0];
	if (slot) return { slot };
	const p = e.parent;
	const untyped = (!!context && isUntypedContext(context)) || (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind));
	return untyped ? { singleton: `js${e.text}Constructor` } : {};
}
