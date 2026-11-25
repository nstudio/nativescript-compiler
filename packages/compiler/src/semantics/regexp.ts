// Regular expressions known when compiling: their groups, and whether a match may leave one unset.
import ts from 'typescript';

/**
 * A pattern's capture groups: how many, which (by number) can take no part in a match (inside an alternative, under a
 * quantifier that allows none, or in a negative lookaround), and whether any is named.
 */
export function patternGroups(source: string): { count: number; unset: Set<number>; named: boolean } {
	type Frame = { capturing: boolean; alternates: boolean; optional: boolean; negative: boolean; parent: Frame | null };
	const top: Frame = { capturing: false, alternates: false, optional: false, negative: false, parent: null };
	const groups: Frame[] = [];
	let frame = top,
		named = false;
	let closed: Frame | null = null;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '\\') {
			i++;
			closed = null;
			continue;
		}
		if (c === '[') {
			for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
			closed = null;
			continue;
		}
		if (c === '(') {
			const name = source[i + 1] === '?' && source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!';
			const capturing = source[i + 1] !== '?' || name;
			const negative = source.startsWith('?!', i + 1) || source.startsWith('?<!', i + 1);
			frame = { capturing, alternates: false, optional: false, negative, parent: frame };
			if (capturing) groups.push(frame);
			named ||= name;
			closed = null;
			continue;
		}
		if (c === ')' && frame.parent) {
			closed = frame;
			frame = frame.parent;
			continue;
		}
		if (c === '|') frame.alternates = true;
		else if (closed && (c === '?' || c === '*' || (c === '{' && /^\{0+(,\d*)?\}/.test(source.slice(i, i + 24))))) closed.optional = true;
		closed = null;
	}
	const unset = new Set<number>();
	groups.forEach((g, k) => {
		let may = g.optional || g.negative;
		for (let f = g.parent; f && !may; f = f.parent) may = f.alternates || f.optional || f.negative;
		if (may) unset.add(k + 1);
	});
	return { count: groups.length, unset, named };
}

export function patternMayLeaveGroupUnset(source: string): boolean {
	return patternGroups(source).unset.size > 0;
}

/** The flags of a pattern argument known when compiling (`/x/g`, `new RegExp(source, 'g')`, or a constant holding one). */
export function literalFlags(e: ts.Expression, checker: ts.TypeChecker): string | null {
	e = ts.skipOuterExpressions(e);
	if (ts.isRegularExpressionLiteral(e)) return e.text.slice(e.text.lastIndexOf('/') + 1);
	if ((ts.isNewExpression(e) || ts.isCallExpression(e)) && ts.isIdentifier(e.expression) && e.expression.text === 'RegExp') {
		const flags = e.arguments?.[1];
		return flags && ts.isStringLiteralLike(flags) ? flags.text : null;
	}
	if (ts.isIdentifier(e)) {
		const d = checker.getSymbolAtLocation(e)?.valueDeclaration;
		if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) return literalFlags(d.initializer, checker);
	}
	return null;
}

/** The source of a pattern argument known when compiling: a literal, `new RegExp('…')`, or a constant holding one. */
export function literalPattern(e: ts.Expression, checker: ts.TypeChecker): string | null {
	e = ts.skipOuterExpressions(e);
	if (ts.isRegularExpressionLiteral(e)) return e.text.slice(1, e.text.lastIndexOf('/'));
	if ((ts.isNewExpression(e) || ts.isCallExpression(e)) && ts.isIdentifier(e.expression) && e.expression.text === 'RegExp') {
		const [p] = e.arguments ?? [];
		if (p && ts.isStringLiteralLike(p)) return p.text;
		if (p && ts.isRegularExpressionLiteral(ts.skipOuterExpressions(p))) return literalPattern(p, checker);
		return null;
	}
	if (ts.isIdentifier(e)) {
		const d = checker.getSymbolAtLocation(e)?.valueDeclaration;
		if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) return literalPattern(d.initializer, checker);
	}
	return null;
}

/**
 * Whether a split, match or exec over this pattern argument can give a group that took no part (undefined): a literal
 * pattern (or a constant holding one) by its source; any other RegExp, made at run time, is taken to.
 */
export function regexpMayLeaveGroupUnset(e: ts.Expression, checker: ts.TypeChecker): boolean {
	const source = literalPattern(e, checker);
	if (source !== null) return patternMayLeaveGroupUnset(source);
	const t = checker.getTypeAtLocation(e);
	return !(t.flags & ts.TypeFlags.StringLike) && !(t.isUnion() && t.types.every((p) => p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
}

export interface UnsetGroupTyping {
	/**
	 * A string array a group that took no part in a match may have put undefined in, though TypeScript types it `string[]`:
	 * a split over a pattern that can leave a group unset, a match of one copied (spread, `Array.from`, slice, filter…),
	 * and a variable initialized with one.
	 */
	groups(n: ts.Node): boolean;
	/** A match whose groups may include one that took no part: from a pattern that can leave one unset, or of unknown origin. */
	match(e: ts.Expression): boolean;
	/** An element-visiting callback's element parameter (`m.map((v) => …)`), or a loop's variable, over such strings. */
	element(n: ts.Node): boolean;
	/** A map callback over such elements that may give one back (`(v) => v`). */
	returnsElement(f: ts.ArrowFunction | ts.FunctionExpression): boolean;
	/** A function value (no literal) given to visit such elements, whose element parameter is declared to hold no undefined. */
	typedCallback(call: ts.CallExpression): ts.Expression | undefined;
}

/** `isMatch`: whether the backend holds a value as a match (RegExpMatchArray, RegExpExecArray). */
export function unsetGroupTyping(checker: ts.TypeChecker, resolve: (n: ts.Node) => ts.Symbol | undefined, isMatch: (e: ts.Expression) => boolean): UnsetGroupTyping {
	const memo = new Map<ts.Node, boolean>();
	const outer = ts.OuterExpressionKinds.Parentheses | ts.OuterExpressionKinds.NonNullAssertions;
	const groups = (n: ts.Node): boolean => {
		let found = memo.get(n);
		if (found !== undefined) return found;
		memo.set(n, false);
		found = findGroups(n);
		memo.set(n, found);
		return found;
	};
	const copied = (x: ts.Expression) => groups(x) || match(x);
	const findGroups = (n: ts.Node): boolean => {
		if (ts.isIdentifier(n) && n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n) n = n.parent;
		if (ts.isIdentifier(n)) {
			const d = resolve(n)?.valueDeclaration;
			return !!d && ts.isVariableDeclaration(d) && groups(d);
		}
		if (ts.isVariableDeclaration(n)) return ts.isIdentifier(n.name) && !!n.initializer && !ts.isForInOrOfStatement(n.parent.parent) && copied(n.initializer);
		if (!ts.isExpression(n)) return false;
		const e = ts.skipOuterExpressions(n, outer);
		if (ts.isArrayLiteralExpression(e)) return e.elements.some((x) => ts.isSpreadElement(x) && copied(x.expression));
		if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
		const name = e.expression.name.text,
			receiver = e.expression.expression;
		if (name === 'split') return !!e.arguments[0] && !!(checker.getNonNullableType(checker.getTypeAtLocation(receiver)).flags & ts.TypeFlags.StringLike) && regexpMayLeaveGroupUnset(e.arguments[0], checker);
		if (name === 'from' && ts.isIdentifier(receiver) && receiver.text === 'Array') return e.arguments.length === 1 && copied(e.arguments[0]);
		if (['slice', 'filter', 'concat', 'reverse', 'sort', 'splice', 'toReversed', 'toSorted', 'toSpliced'].includes(name)) return copied(receiver);
		if (name === 'map') {
			const f = e.arguments[0] && ts.skipOuterExpressions(e.arguments[0]);
			return !!f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && returnsElement(f);
		}
		return false;
	};
	const match = (e: ts.Expression): boolean => {
		if (!isMatch(e)) return false;
		let x = ts.skipOuterExpressions(e, outer);
		if (ts.isIdentifier(x)) {
			const d = resolve(x)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && ts.isForOfStatement(d.parent.parent) && d.parent.parent.initializer === d.parent) x = d.parent.parent.expression;
			else if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) x = d.initializer;
			x = ts.skipOuterExpressions(x, outer);
		}
		if (!ts.isCallExpression(x) || !ts.isPropertyAccessExpression(x.expression)) return true;
		const name = x.expression.name.text;
		const re = name === 'exec' ? x.expression.expression : ['match', 'matchAll'].includes(name) ? x.arguments[0] : undefined;
		if (!re) return true;
		// A global match lists whole matches only.
		if (name === 'match' && literalFlags(re, checker)?.includes('g')) return false;
		return regexpMayLeaveGroupUnset(re, checker);
	};
	const ELEMENT_METHODS = ['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap'];
	const typedCallback = (call: ts.CallExpression): ts.Expression | undefined => {
		const f = call.arguments[0];
		if (!f || !ts.isPropertyAccessExpression(call.expression) || !ELEMENT_METHODS.includes(call.expression.name.text)) return undefined;
		const bare = ts.skipOuterExpressions(f);
		if (ts.isArrowFunction(bare) || ts.isFunctionExpression(bare) || !copied(call.expression.expression)) return undefined;
		const param = checker.getTypeAtLocation(f).getNonNullableType().getCallSignatures()[0]?.getParameters()[0];
		if (!param) return undefined;
		const t = checker.getTypeOfSymbolAtLocation(param, f);
		const holds = (x: ts.Type) => !!(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
		return holds(t) || (t.isUnion() && t.types.some(holds)) ? undefined : f;
	};
	const elementCallback = (f: ts.Node): boolean => {
		if (!(ts.isArrowFunction(f) || ts.isFunctionExpression(f)) || !f.parameters.length) return false;
		const call = ts.walkUpParenthesizedExpressions(f.parent);
		if (!ts.isCallExpression(call) || call.arguments[0] !== ts.walkUpParenthesizedExpressions(f) || !ts.isPropertyAccessExpression(call.expression)) return false;
		if (!ELEMENT_METHODS.includes(call.expression.name.text)) return false;
		return copied(call.expression.expression);
	};
	const element = (n: ts.Node): boolean => {
		const p = ts.isParameter(n) || ts.isVariableDeclaration(n) ? n : ts.isIdentifier(n) ? ((ts.isParameter(n.parent) || ts.isVariableDeclaration(n.parent)) && n.parent.name === n ? n.parent : resolve(n)?.valueDeclaration) : undefined;
		if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && ts.isForOfStatement(p.parent.parent) && p.parent.parent.initializer === p.parent) return copied(p.parent.parent.expression);
		return !!p && ts.isParameter(p) && p.parent.parameters[0] === p && ts.isIdentifier(p.name) && elementCallback(p.parent);
	};
	const returnsElement = (f: ts.ArrowFunction | ts.FunctionExpression): boolean => {
		if (!elementCallback(f) || !ts.isIdentifier(f.parameters[0].name)) return false;
		const sym = resolve(f.parameters[0].name);
		const gives = (x: ts.Expression) => {
			x = ts.skipOuterExpressions(x);
			return ts.isIdentifier(x) && resolve(x) === sym;
		};
		if (!ts.isBlock(f.body)) return gives(f.body);
		const visit = (x: ts.Node): boolean => (ts.isReturnStatement(x) && !!x.expression && gives(x.expression)) || (!ts.isFunctionLike(x) && !!ts.forEachChild(x, visit));
		return visit(f.body);
	};
	return { groups, match, element, returnsElement, typedCallback };
}
