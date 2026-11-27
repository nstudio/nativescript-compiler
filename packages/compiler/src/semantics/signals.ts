// Signals as a framework model declares them (`SignalKind`): the value a signal holds, and the equality its writes use.
import ts from 'typescript';
import type { FrameworkModel, SignalKind } from '../api/adapter-api.ts';
import type { Framework } from '../adapters/hooks.ts';

/** A signal of this kind read by calling it with no arguments (`count()`, an input, a model, a computed field). */
export const callableSignal = (kind: SignalKind | undefined): boolean => kind === 'writable' || kind === 'input' || kind === 'model' || kind === 'computed';

/**
 * The value type of a writable, input or model signal (`SignalKind`) that holds null and undefined both, as a binding
 * hands an input either one: held as `JSNullish<T>`. One kind of present value, not a function (`T | null | undefined`).
 */
export function nullishSignalType(checker: ts.TypeChecker, signal: ts.Type, signalKind: (name: string) => SignalKind | undefined): boolean {
	const sym = signal.aliasSymbol ?? signal.getSymbol();
	const k = sym && signalKind(sym.name);
	if (!sym || !(k === 'writable' || k === 'input' || k === 'model') || !sym.declarations?.[0]?.getSourceFile().fileName.startsWith('/__shims__/')) return false;
	const t = (signal.aliasSymbol ? signal.aliasTypeArguments : checker.getTypeArguments(signal as ts.TypeReference))?.[0];
	if (!t) return false;
	const parts = t.isUnion() ? t.types : [t];
	if (parts.some((x) => x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return false;
	if (!parts.some((x) => x.flags & ts.TypeFlags.Null) || !parts.some((x) => x.flags & ts.TypeFlags.Undefined)) return false;
	const present = parts.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
	if (!present.length || present.some((x) => x.getCallSignatures().length)) return false;
	const kind = (x: ts.Type) => (x.flags & ts.TypeFlags.StringLike ? 's' : x.flags & ts.TypeFlags.NumberLike ? 'n' : x.flags & ts.TypeFlags.BooleanLike ? 'b' : x.flags & ts.TypeFlags.BigIntLike ? 'g' : (x.getSymbol() ?? x));
	return new Set(present.map(kind)).size === 1;
}

/**
 * The function a signal's options give as `equal` (`signal(v, { equal })`, `computed(fn, { equal })`): an
 * expression, `undefined` for none, or the options themselves when only running them could tell.
 */
export function equalOption(options: ts.Expression | undefined): { equal?: ts.Expression; opaque?: ts.Expression } {
	if (!options) return {};
	const literal = ts.skipOuterExpressions(options);
	if (!ts.isObjectLiteralExpression(literal)) return { opaque: options };
	for (const p of literal.properties) {
		if (ts.isSpreadAssignment(p)) return { opaque: options };
		if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) || p.name.text !== 'equal') continue;
		if (ts.isPropertyAssignment(p)) return { equal: p.initializer };
		if (ts.isShorthandPropertyAssignment(p)) return { equal: p.name };
		return { opaque: options };
	}
	return {};
}

/**
 * The `equal` a write to a signal the framework's call made (`FrameworkModel.signalOptions`) calls: the expression a
 * literal gives, `true` when the options are not a literal and their type has an `equal`, `undefined` for none.
 */
export function signalEqual(made: ts.Expression | undefined, checker: ts.TypeChecker, signalOptions: FrameworkModel['signalOptions']): ts.Expression | true | undefined {
	const call = made && ts.skipOuterExpressions(made);
	const given = signalOptions?.(call, checker);
	if (!given) return undefined;
	const { equal, opaque } = equalOption(given.options);
	if (equal) return equal;
	return opaque && checker.getNonNullableType(checker.getTypeAtLocation(opaque)).getProperty('equal') ? true : undefined;
}

/**
 * The `equal` (as `signalEqual`) of the signal a `set(v)` or `update(fn)` call writes, when the receiver names the
 * variable or field holding the signal as made. A write through any other reference is not seen.
 */
export function signalWriteEqual(call: ts.CallExpression, checker: ts.TypeChecker, signalOptions: FrameworkModel['signalOptions']): ts.Expression | true | undefined {
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee) || (callee.name.text !== 'set' && callee.name.text !== 'update')) return undefined;
	const receiver = ts.skipOuterExpressions(callee.expression);
	let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(receiver) ? receiver.name : receiver);
	if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
	const d = sym?.valueDeclaration;
	if (!d || !(ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d))) return undefined;
	return signalEqual(d.initializer, checker, signalOptions);
}

/**
 * Whether reading the signal `e` (`e()`), or updating it (`e.update(fn)`), may find it unset and throw its framework's
 * error (`FrameworkModel.unsetError`): a required prop field, or an input, model or read-only signal held as a value (a
 * local, a parameter, a field given another's signal), which may be a required one its parent has not set yet.
 */
export function mayBeUnset(e: ts.Expression, checker: ts.TypeChecker, framework: Framework, seen = new Set<ts.Node>()): boolean {
	const x = ts.skipOuterExpressions(e);
	let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x);
	if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
	const holder = sym?.valueDeclaration;
	if (holder) {
		if (seen.has(holder)) return true;
		seen.add(holder);
	}
	if (framework.unsetError(holder) !== undefined) return true;
	if (!framework.hooks.unsetError) return false;
	const t = checker.getTypeAtLocation(x);
	const name = (t.aliasSymbol ?? t.getSymbol())?.getName();
	const kind = name === undefined ? undefined : framework.signalKind(name);
	// A read-only signal type (`Signal<T>`) is one an input or model signal widens to.
	if (kind !== 'input' && kind !== 'model' && kind !== 'computed') return false;
	const init = holder && (ts.isPropertyDeclaration(holder) || (ts.isVariableDeclaration(holder) && ts.getCombinedNodeFlags(holder) & ts.NodeFlags.Const)) ? holder.initializer : undefined;
	const given = init && ts.skipOuterExpressions(init);
	// A field or constant given another's signal (`alias = squared`, `held = this.item`) holds what that one does.
	if (given && (ts.isIdentifier(given) || ts.isPropertyAccessExpression(given))) return mayBeUnset(given, checker, framework, seen);
	if (!given || !ts.isCallExpression(given)) return true;
	// One a call of the framework's own makes (`input()`, `model(0)`, `computed(fn)`, `toSignal(o)`) holds a value from the start.
	const callee = ts.isPropertyAccessExpression(given.expression) ? given.expression.name.text : given.expression.getText();
	if (framework.memoCall(given, checker) || framework.heldSignal(callee) || framework.signalConstructor(callee)) return false;
	return !checker.getResolvedSignature(given)?.getDeclaration()?.getSourceFile().isDeclarationFile;
}

/**
 * The call making the linked signal (`SignalConstructor.linked`) `e` names, a variable or field holding it as made or
 * given another's that does (`alias = linked`); undefined for any other signal.
 */
export function linkedSignalCall(e: ts.Expression, checker: ts.TypeChecker, framework: Framework, seen = new Set<ts.Node>()): ts.CallExpression | undefined {
	const x = ts.skipOuterExpressions(e);
	let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x);
	if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
	const holder = sym?.valueDeclaration;
	if (!holder || seen.has(holder) || !(ts.isPropertyDeclaration(holder) || (ts.isVariableDeclaration(holder) && ts.getCombinedNodeFlags(holder) & ts.NodeFlags.Const))) return undefined;
	seen.add(holder);
	const given = holder.initializer && ts.skipOuterExpressions(holder.initializer);
	if (given && (ts.isIdentifier(given) || ts.isPropertyAccessExpression(given))) return linkedSignalCall(given, checker, framework, seen);
	if (!given || !ts.isCallExpression(given) || !ts.isIdentifier(given.expression) || !framework.signalConstructor(given.expression.text)?.linked) return undefined;
	return checker.getResolvedSignature(given)?.getDeclaration()?.getSourceFile().isDeclarationFile ? given : undefined;
}

/**
 * What a linked signal's call (`linkedSignalCall`) runs as it computes: an options literal's `computation` and `source`
 * (or a member of it it cannot name), else its first argument (the function, or options read as it runs).
 */
export function linkedSignalRuns(call: ts.CallExpression): ts.Node[] {
	const first = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
	if (!first) return [];
	if (!ts.isObjectLiteralExpression(first)) return [first];
	return first.properties.flatMap((p): ts.Node[] => {
		const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
		if (name === undefined || ts.isSpreadAssignment(p) || ts.isAccessor(p)) return [p];
		if (name !== 'computation' && name !== 'source') return [];
		return [ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : p];
	});
}

/** Whether `e`, a component's prop field named without a call (`this.item`), is the signal itself: its type is an input or model signal. */
export function propSignal(e: ts.Expression, checker: ts.TypeChecker, framework: Framework): boolean {
	const t = checker.getTypeAtLocation(e);
	const name = (t.aliasSymbol ?? t.getSymbol())?.getName();
	const kind = name === undefined ? undefined : framework.signalKind(name);
	return kind === 'input' || kind === 'model';
}

/** Whether `n` declares or references an untyped variable initialized from a read of a signal holding null (`const card = this.morning()`). */
export function isGivenNullSignalValue(n: ts.Node, resolve: (id: ts.Node) => ts.Symbol | undefined, isNullSignalRead: (init: ts.Expression) => boolean): boolean {
	const d = (ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent : ts.isIdentifier(n) ? resolve(n)?.valueDeclaration : undefined) as ts.VariableDeclaration | undefined;
	if (!d || !ts.isVariableDeclaration(d) || d.type || !d.initializer) return false;
	return isNullSignalRead(d.initializer);
}

/** Whether a class property declaration initializes a read-only signal via memoization or `.asReadonly()`. */
export function isReadonlySignalProperty(decl: ts.PropertyDeclaration, checker: ts.TypeChecker, framework: Framework, callee: string): boolean {
	return !!framework.memoized(decl, checker) || /\.asReadonly$/.test(callee);
}
