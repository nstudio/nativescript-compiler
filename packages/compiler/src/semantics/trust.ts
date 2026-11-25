// The trust rule: a TypeScript type is a contract only where TypeScript proves it. A value whose type it cannot prove
// may be anything JavaScript allows there, so the slot it is placed in holds whatever it is, converted where it is used;
// the compiled code checks only where JavaScript itself throws (a member of undefined, a call of a non-function).
import ts from 'typescript';
import { accessedDeclaration, hasStatic, literalKey, slotType } from './lang.ts';
import { regexpMayLeaveGroupUnset } from './regexp.ts';
import { traceAnalysis } from './decision-trace.ts';
import type { Ledger } from './ledger.ts';

/** Where an unproven type comes from. */
export type Origin =
	| 'any' // any or unknown
	| 'asserted' // `x as T`, `<T>x` or `x!` that narrows what x is
	| 'lenient' // declared in code checked without strictNullChecks (core, most plugins, a non-strict app)
	| 'native' // a platform declaration's result or field
	| 'dynamic' // an element or index read
	| 'callback' // a parameter of a function that code not checked strictly calls
	| 'loose'; // a read of a slot an untrusted value was placed in

/** What the trust rule asks of a translator. */
export interface TrustScope {
	readonly checker: ts.TypeChecker;
	/** Whether a program file is checked with strictNullChecks. */
	strictFile(file: ts.SourceFile): boolean;
	/** Whether a declaration is a platform's (an iOS or Android typing). */
	nativeDeclaration(d: ts.Declaration): boolean;
	/** Whether an untrusted value was placed in this declaration somewhere in the program (see `LooseSlots`). */
	looseSlot?(d: ts.Declaration): boolean;
}

/**
 * Whether a program file is strict code (checked with strictNullChecks, its types trusted): not in library mode or a
 * non-strict app's own files; a plugin's as the ledger's `pluginsWrittenStrict` says.
 */
export function strictFile(file: string, c: { readonly lenient: boolean; readonly lenientApp: boolean; readonly pluginFiles: ReadonlySet<string>; readonly lenientFiles: ReadonlySet<string>; readonly ledger: Ledger }): boolean {
	if (c.lenient || c.lenientFiles.has(file)) return false;
	return c.pluginFiles.has(file) ? c.ledger.pluginsWrittenStrict : !c.lenientApp;
}

/** TypeScript's own declarations of JavaScript's built-ins. */
export const LIB_FILE = /[\\/]typescript[\\/]lib[\\/]|[\\/]lib\.[\w.]*\.d\.ts$/;

/** A method a front end adds to a component for its template: a binding's value (`$b3`) or a handler (`$e4`). */
export function isTemplateMethod(m: ts.Node): boolean {
	return ts.isMethodDeclaration(m) && /^\$[be]\d+$/.test(m.name.getText());
}

/** Where a value's type comes from when TypeScript cannot prove it; null when it can. */
export function originOf(e: ts.Expression, scope: TrustScope): Origin | null {
	const { checker } = scope;
	e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	const untyped = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	if (untyped(checker.getTypeAtLocation(e))) return 'any';
	if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) {
		const from = checker.getTypeAtLocation(e.expression),
			to = checker.getTypeAtLocation(e);
		if (untyped(from)) return 'asserted';
		// An upcast (`label as View`) proves itself; anything narrower is the assertion's word only.
		return checker.isTypeAssignableTo(from, to) ? originOf(e.expression, scope) : 'asserted';
	}
	if (ts.isNonNullExpression(e)) return 'asserted';
	if (ts.isElementAccessExpression(e)) {
		const target = checker.getNonNullableType(checker.getTypeAtLocation(e.expression));
		// A tuple's element at a literal index is what the tuple declares.
		if (checker.isTupleType(target) && ts.isNumericLiteral(e.argumentExpression)) return originOf(e.expression, scope);
		return 'dynamic';
	}
	if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
		if (ts.isNewExpression(e)) return null;
		const decl = checker.getResolvedSignature(e)?.getDeclaration();
		return decl && !ts.isJSDocSignature(decl) ? declarationOrigin(decl, scope) : null;
	}
	if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
		let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
		const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
		if (!decl) return ts.isPropertyAccessExpression(e) ? 'dynamic' : null;
		if (ts.isParameter(decl) && calledByUntrusted(decl, scope)) return 'callback';
		return declarationOrigin(decl, scope);
	}
	return null;
}

/** Where a declaration's type comes from, as `originOf` reads a value it declares. */
export function declarationOrigin(d: ts.Declaration, scope: TrustScope): Origin | null {
	const file = d.getSourceFile();
	if (file.isDeclarationFile) {
		if (LIB_FILE.test(file.fileName)) return null;
		return scope.nativeDeclaration(d) ? 'native' : 'lenient';
	}
	if (!scope.strictFile(file)) return 'lenient';
	return scope.looseSlot?.(d) ? 'loose' : null;
}

/**
 * A parameter of a function that is passed as a value to a callee code not checked strictly declares (`view.on('tap',
 * (args: GestureEventData) => …)`, a delegate's method): what it is given is that code's choice, whatever the type says.
 */
function calledByUntrusted(p: ts.ParameterDeclaration, scope: TrustScope): boolean {
	const fn = p.parent;
	if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
	let x: ts.Node = fn;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const call = x.parent;
	if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || !call.arguments?.includes(x as ts.Expression)) return false;
	const callee = scope.checker.getResolvedSignature(call)?.getDeclaration();
	return !!callee && !ts.isJSDocSignature(callee) && declarationOrigin(callee, scope) !== null && declarationOrigin(callee, scope) !== 'loose';
}

/**
 * Strict code's functions whose value reaches an untyped slot (`callbacks.push(cb)` for `cb: (v: string) => void`), itself
 * or through function-typed slots it is placed in: script calls them with whatever it passes. Given a function type node,
 * an arrow function, a function expression or a function declaration.
 */
export function scriptCalledFunction(trust: TrustScope): (sig: ts.Node) => boolean {
	const checker = trust.checker;
	const known = new Map<ts.Node, boolean>();
	const untyped = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	/** Whether a function value is placed in an untyped slot, or in a function-typed one whose value reaches one. */
	const reachesScript = (x: ts.Expression, own: ts.Node): boolean => {
		let slot: ts.Type | undefined;
		const field = (ts.isShorthandPropertyAssignment(x.parent) && x.parent.name === x) || (ts.isPropertyAssignment(x.parent) && x.parent.initializer === x) ? x.parent : null;
		if (field) {
			const obj = checker.getContextualType(field.parent);
			const key = field.name && literalKey(field.name, checker);
			const prop = obj && !untyped(obj) && key ? obj.getProperty(key) : undefined;
			slot = obj && untyped(obj) ? obj : prop && checker.getTypeOfSymbolAtLocation(prop, x);
		} else slot = checker.getContextualType(x);
		if (!slot) return false;
		if (untyped(slot)) return true;
		// A replacer given a pattern's groups, any of which may be undefined.
		const call = ts.walkUpParenthesizedExpressions(x.parent);
		if (ts.isCallExpression(call) && call.arguments[1] === ts.walkUpParenthesizedExpressions(x) && ts.isPropertyAccessExpression(call.expression) && ['replace', 'replaceAll'].includes(call.expression.name.text) && checker.getNonNullableType(checker.getTypeAtLocation(call.expression.expression)).flags & ts.TypeFlags.StringLike && regexpMayLeaveGroupUnset(call.arguments[0], checker)) return true;
		const decl = checker.getNonNullableType(slot).getCallSignatures()[0]?.getDeclaration();
		return !!decl && !ts.isJSDocSignature(decl) && decl !== own && scriptCalled(decl);
	};
	const scriptCalled = (sig: ts.Node): boolean => {
		if (sig.getSourceFile().isDeclarationFile || !trust.strictFile(sig.getSourceFile())) return false;
		if (!(ts.isFunctionTypeNode(sig) || ts.isArrowFunction(sig) || ts.isFunctionExpression(sig) || (ts.isFunctionDeclaration(sig) && sig.body && sig.name))) return false;
		let found = known.get(sig);
		if (found !== undefined) return found;
		known.set(sig, false);
		const refs = (d: ts.Node, name: ts.Identifier, scope: ts.Node | undefined): boolean => {
			const sym = checker.getSymbolAtLocation(name);
			const named = (x: ts.Identifier) => (ts.isShorthandPropertyAssignment(x.parent) && x.parent.name === x ? checker.getShorthandAssignmentValueSymbol(x.parent) : checker.getSymbolAtLocation(x)) === sym;
			const visit = (x: ts.Node): boolean => (ts.isIdentifier(x) && x !== name && named(x) && reachesScript(x, d)) || !!ts.forEachChild(x, visit);
			return !!sym && !!scope && visit(scope);
		};
		found = false;
		if (ts.isFunctionTypeNode(sig)) {
			const d = sig.parent;
			if ((ts.isParameter(d) || ts.isVariableDeclaration(d)) && d.type === sig && ts.isIdentifier(d.name)) found = refs(sig, d.name, ts.isParameter(d) ? d.parent : ts.findAncestor(d.parent, (x) => ts.isFunctionLike(x) || ts.isSourceFile(x)));
		} else if (ts.isFunctionDeclaration(sig)) {
			found = refs(sig, sig.name!, sig.getSourceFile());
		} else {
			let x: ts.Expression = sig as ts.Expression;
			while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
			found = reachesScript(x, sig);
			// A constant holding the function (`const f = (s: string) => …`): wherever the constant is given.
			const d = x.parent;
			if (!found && ts.isVariableDeclaration(d) && d.initializer === x && !d.type && ts.isIdentifier(d.name) && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) {
				found = refs(
					sig,
					d.name,
					ts.findAncestor(d.parent, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n)),
				);
			}
		}
		known.set(sig, found);
		return found;
	};
	return scriptCalled;
}

/** The slot a value is placed in: a variable, field, parameter, literal field or a function's result. */
export function slotOf(e: ts.Expression, checker: ts.TypeChecker): ts.Declaration | null {
	let x: ts.Node = e;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	const p = x.parent;
	if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p)) && p.initializer === x && ts.isIdentifier(p.name)) return p;
	if (ts.isBinaryExpression(p) && p.right === x && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isIdentifier(p.left) || ts.isPropertyAccessExpression(p.left))) {
		const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(p.left) ? p.left.name : p.left);
		return sym?.valueDeclaration ?? null;
	}
	if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(x as ts.Expression)) {
		const sig = checker.getResolvedSignature(p)?.getDeclaration();
		if (!sig || ts.isJSDocSignature(sig)) return null;
		const k = p.arguments.indexOf(x as ts.Expression);
		const param = sig.parameters[Math.min(k, sig.parameters.length - 1)];
		return param && !(param.dotDotDotToken && k >= sig.parameters.length - 1 && param !== sig.parameters[k]) ? param : null;
	}
	if (ts.isPropertyAssignment(p) && p.initializer === x) {
		const sym = checker.getContextualType(p.parent)?.getProperty(literalKey(p.name, checker) ?? '');
		return accessedDeclaration(sym) ?? sym?.declarations?.[0] ?? null;
	}
	if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === x)) {
		const fn = ts.isArrowFunction(p) ? p : ts.findAncestor(p, ts.isFunctionLike);
		return fn && (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isGetAccessorDeclaration(fn)) ? fn : null;
	}
	return null;
}

/**
 * The declarations (variables, fields, parameters, literal fields, functions' results) of the program's own code that
 * an untrusted value is placed in anywhere, closed over reads of them: a slot holds what JavaScript can put there, so a
 * translator holds these in a form that takes undefined and null as well. `untrusted` is the translator's own reading
 * of `originOf`: whether the value, as it holds it, may be what the slot's own form cannot hold.
 */
export class LooseSlots {
	private loose = new Set<ts.Declaration>();
	private built = false;
	private files: readonly ts.SourceFile[];
	private checker: ts.TypeChecker;
	private untrusted: (e: ts.Expression) => boolean;
	private holds: (d: ts.Declaration) => boolean;
	private given: () => readonly ts.Declaration[];

	/** `given`: slots loose whatever is placed in them, before untrusted values loosen others. */
	constructor(files: readonly ts.SourceFile[], checker: ts.TypeChecker, untrusted: (e: ts.Expression) => boolean, holds: (d: ts.Declaration) => boolean, given: () => readonly ts.Declaration[] = () => []) {
		this.files = files;
		this.checker = checker;
		this.untrusted = untrusted;
		this.holds = holds;
		this.given = given;
	}

	has(d: ts.Declaration): boolean {
		if (!this.built) this.build();
		return this.loose.has(d);
	}

	/** The fields of the program's interfaces a type (or its array's elements) names. */
	private fieldsOf(t: ts.Type | null): ts.Declaration[] {
		if (!t) return [];
		const parts = t.isUnion() ? t.types : [t];
		const out: ts.Declaration[] = [];
		for (const p of parts) {
			const el = this.checker.isArrayType(p) ? this.checker.getTypeArguments(p as ts.TypeReference)[0] : p;
			const sym = el?.getSymbol();
			if (!sym || !(sym.flags & ts.SymbolFlags.Interface) || !sym.declarations?.some((d) => ts.isInterfaceDeclaration(d) && !d.getSourceFile().isDeclarationFile)) continue;
			for (const prop of el.getProperties()) if (prop.valueDeclaration) out.push(prop.valueDeclaration);
		}
		return out;
	}

	private build() {
		this.built = true;
		for (const d of this.given()) this.loose.add(d);
		const placements: [ts.Expression, ts.Declaration][] = [];
		const destructured: [ts.Declaration, ts.Declaration][] = [];
		const visit = (n: ts.Node) => {
			if (ts.isExpression(n) && !ts.isParenthesizedExpression(n)) {
				const slot = slotOf(n, this.checker);
				let value = n;
				while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) value = ts.skipOuterExpressions(value.right, ts.OuterExpressionKinds.Parentheses);
				if (slot && !slot.getSourceFile().isDeclarationFile) placements.push([value, slot]);
			} else if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && ts.isObjectBindingPattern(n.parent)) {
				if (n.initializer) placements.push([n.initializer, n]);
				const prop = this.checker.getTypeAtLocation(n.parent).getProperty((n.propertyName ?? n.name).getText())?.valueDeclaration;
				if (prop && !prop.getSourceFile().isDeclarationFile) destructured.push([prop, n]);
			}
			ts.forEachChild(n, visit);
		};
		for (const f of this.files) if (!f.isDeclarationFile) visit(f);
		// A slot read is untrusted once it is loose, which may loosen the slots its value goes to.
		const opened = new Set<ts.Declaration>();
		for (let changed = true; changed;) {
			changed = false;
			for (const [value, slot] of placements) {
				const own = this.holds(slot) && !this.loose.has(slot);
				if ((!own && opened.has(slot)) || !this.untrusted(value)) continue;
				if (own) this.loose.add(slot);
				// An untrusted object where an interface is declared (`const p: Point = JSON.parse(s)`): its fields are untrusted too.
				if (!opened.has(slot)) {
					opened.add(slot);
					for (const field of this.fieldsOf(slotType(slot, this.checker))) if (this.holds(field)) this.loose.add(field);
				}
				changed = true;
			}
			for (const [prop, binding] of destructured) {
				if (!this.loose.has(binding) && this.holds(binding) && this.loose.has(prop)) {
					this.loose.add(binding);
					changed = true;
				}
			}
		}
	}
}
traceAnalysis(LooseSlots.prototype, 'loose');

/**
 * A declaration whose form a translator may choose alone: a variable, a field, a parameter or a function's result that
 * no other declaration must match. Not a method's parameter or result (overrides share one signature), a rest
 * parameter, a parameter property, an async or generator function's result, or the field of an interface a class
 * implements (its implementations declare it too).
 */
export function ownSlot(d: ts.Declaration, implemented: Set<ts.Declaration>): boolean {
	if (d.getSourceFile().isDeclarationFile) return false;
	if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) {
		if (ts.isMethodDeclaration(d) && !hasStatic(d)) return false;
		return !d.asteriskToken && !ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
	}
	if (ts.isPropertySignature(d)) return ts.isInterfaceDeclaration(d.parent) && !implemented.has(d.parent) && ts.isIdentifier(d.name);
	if (ts.isParameter(d)) {
		const fn = d.parent;
		if (d.dotDotDotToken || !ts.isIdentifier(d.name) || (ts.isMethodDeclaration(fn) && !hasStatic(fn))) return false;
		if (ts.isConstructorDeclaration(fn) && ts.getModifiers(d)?.length) return false;
		return ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn);
	}
	return (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isBindingElement(d)) && ts.isIdentifier(d.name);
}
