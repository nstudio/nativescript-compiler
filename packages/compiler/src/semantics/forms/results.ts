// What an expression gives: the states of the values it may evaluate to.
import ts from 'typescript';
import { A, F, G, H, M, N, O, ONE_ELEMENT, PRESENT, SAME_ELEMENTS, Slot, U, declarationFile, dropsAbsent, guarded, isConstAssertion, isGroupsRead, isMatchArray, isTemplateDefault, mask, merge, objectValue, sourceOf, typeNodeStates, typeStates, withMissing, type Flow, type Part } from './flow.ts';
import type { Forms } from './forms.ts';
import { LIB_FILE } from '../trust.ts';
import { mergedInterfaceMemberOf, uncheckedMatch } from '../lang.ts';
import { nullishSignalType } from '../signals.ts';
import { regexpMayLeaveGroupUnset } from '../regexp.ts';
import { isWriteTarget } from '../ast.ts';

export const resultsMethods = {
	flow(this: Forms, e: ts.Expression): Flow {
		let f = this.flows.get(e);
		if (!f) {
			this.flows.set(e, PRESENT);
			f = this.compute(e);
			this.flows.set(e, f);
		}
		return f;
	},

	compute(this: Forms, e: ts.Expression): Flow {
		const c = this.checker,
			K = ts.SyntaxKind;
		if (ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isPartiallyEmittedExpression(e)) return this.flow(e.expression);
		if (e.kind === K.NullKeyword) return { states: N | this.given(e), from: [] };
		if (ts.isVoidExpression(e)) return { states: U | this.given(e), from: [] };
		if (ts.isIdentifier(e)) {
			if (e.text === 'undefined') {
				const d = this.declarationOf(e);
				if (!d || declarationFile(d)) return { states: U | this.given(e), from: [] };
			}
			const d = this.declarationOf(e);
			if (!d) return { states: this.unknownStates(e), from: [] };
			if (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)) return this.read(this.slotFor(d), e, d);
			if (ts.isFunctionDeclaration(d) || ts.isClassLike(d) || ts.isEnumDeclaration(d) || ts.isModuleDeclaration(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)) return PRESENT;
			return { states: this.unknownStates(e), from: [] };
		}
		if (ts.isPropertyAccessExpression(e) || (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))) return this.member(e);
		if (ts.isElementAccessExpression(e)) return this.element(e);
		if (ts.isCallExpression(e)) return this.call(e);
		if (ts.isAwaitExpression(e)) {
			const inner = this.flow(e.expression);
			if (!inner.from.length) return inner;
			return { states: inner.states, from: inner.from.map(([s]): [Slot, number] => [this.child(s, 'result'), ~0]) };
		}
		if (ts.isConditionalExpression(e)) return merge(this.flow(e.whenTrue), this.flow(e.whenFalse));
		if (ts.isBinaryExpression(e)) {
			const op = e.operatorToken.kind;
			if (op === K.QuestionQuestionToken || op === K.BarBarToken || op === K.QuestionQuestionEqualsToken || op === K.BarBarEqualsToken) return merge(mask(this.flow(e.left), ~(U | M | O | N | H | A | G)), this.flow(e.right));
			if (op === K.AmpersandAmpersandToken || op === K.AmpersandAmpersandEqualsToken) return merge(mask(this.flow(e.left), U | M | O | N | F | A | G), this.flow(e.right));
			if (op === K.EqualsToken || op === K.CommaToken) return this.flow(e.right);
			return PRESENT;
		}
		if (ts.isNonNullExpression(e)) return mask(this.flow(e.expression), ~(U | M | O | N | H | A | G));
		if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) {
			const inner = this.flow(e.expression);
			const from = c.getTypeAtLocation(e.expression),
				to = c.getTypeAtLocation(e);
			const upcast = !(from.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && c.isTypeAssignableTo(from, to);
			return upcast || isConstAssertion(e) ? inner : merge(inner, { states: F, from: [] });
		}
		if (ts.isArrayLiteralExpression(e)) {
			if (e.elements.some(ts.isOmittedExpression)) this.seed(this.child(this.slotFor(e), 'element'), H);
			return { states: 0, from: [[this.slotFor(e), ~0]] };
		}
		if (ts.isNewExpression(e) && this.partOf(c.getTypeAtLocation(e))) return { states: 0, from: [[this.slotFor(e), ~0]] };
		if (ts.isNewExpression(e) || ts.isLiteralExpression(e) || ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isObjectLiteralExpression(e) || ts.isFunctionLike(e) || ts.isClassExpression(e) || ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e) || ts.isTypeOfExpression(e) || ts.isDeleteExpression(e) || e.kind === K.ThisKeyword || e.kind === K.SuperKeyword || e.kind === K.TrueKeyword || e.kind === K.FalseKeyword) return PRESENT;
		return { states: this.unknownStates(e), from: [] };
	},

	member(this: Forms, e: ts.PropertyAccessExpression | ts.ElementAccessExpression): Flow {
		const c = this.checker;
		const recv = e.expression;
		const optional = e.questionDotToken ? U : 0;
		if (c.getTypeAtLocation(recv).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { states: F | U | N, from: [] };
		if (isGroupsRead(recv, c)) return { states: U | this.absent(e) | optional, from: [] };
		const name = ts.isPropertyAccessExpression(e) ? e.name : e.argumentExpression;
		const d = this.declarationOf(name);
		// A member only a merged interface declares: like an index signature's entry, missing until something sets it.
		if (d && ts.isPropertySignature(d) && ts.isPropertyAccessExpression(e) && (mergedInterfaceMemberOf(e, c) || this.augmented(e))) {
			const keep = ~this.narrowed(e, d);
			return mask({ states: U | this.absent(e) | optional, from: declarationFile(d) ? [] : [[this.slotFor(d), ~0]] }, keep);
		}
		if (d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d) || ts.isParameter(d) || ts.isGetAccessorDeclaration(d))) {
			if (declarationFile(d)) return { states: this.libraryStates(e, d) | optional, from: [] };
			const f = this.read(this.slotFor(d), e, d);
			return optional ? merge(f, { states: U, from: [] }) : f;
		}
		if (d && (ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isEnumMember(d) || ts.isClassLike(d) || ts.isFunctionDeclaration(d))) return { states: optional, from: [] };
		if (d && ts.isSetAccessorDeclaration(d)) return { states: U | optional, from: [] };
		// An index signature's entry: a Record's value, missing for a key never set.
		const value = c.getIndexInfosOfType(c.getNonNullableType(c.getTypeAtLocation(recv))).length > 0;
		if (value) {
			const keep = ts.isElementAccessExpression(e) && !this.strict(e) && !isWriteTarget(e) ? ~dropsAbsent(withMissing(guarded(e))) : ~0;
			return mask({ states: U | this.absent(e), from: this.flow(recv).from.map(([s]): [Slot, number] => [this.child(s, 'value'), ~0]) }, keep);
		}
		return { states: this.unknownStates(e) | optional, from: [] };
	},

	element(this: Forms, e: ts.ElementAccessExpression): Flow {
		const c = this.checker;
		const t = c.getNonNullableType(c.getTypeAtLocation(e.expression));
		const optional = e.questionDotToken ? U : 0;
		if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { states: F | U | N, from: [] };
		if (t.flags & ts.TypeFlags.StringLike) return { states: U | M | this.absent(e) | optional, from: [] };
		if (isMatchArray(t)) return { states: U | this.absent(e) | optional, from: [] };
		const tuple = c.isTupleType(t) && ts.isNumericLiteral(e.argumentExpression);
		const part: Part = c.isArrayType(t) || c.isTupleType(t) ? 'element' : 'value';
		// Past an array's end is a value left out (M); a key never set is not.
		const empty = tuple ? 0 : part === 'element' ? U | M | this.absent(e) : U | this.absent(e);
		return { states: empty | optional, from: this.flow(e.expression).from.map(([s]): [Slot, number] => [this.child(s, part), ~0]) };
	},

	call(this: Forms, e: ts.CallExpression): Flow {
		const c = this.checker;
		const optional = ts.isOptionalChain(e) && e.questionDotToken ? U : 0;
		if (e.expression.kind === ts.SyntaxKind.SuperKeyword || e.expression.kind === ts.SyntaxKind.ImportKeyword) return PRESENT;
		if (ts.isPropertyAccessExpression(e.expression)) {
			const name = e.expression.name.text,
				recv = e.expression.expression;
			const t = c.getNonNullableType(c.getTypeAtLocation(recv));
			const kind = c.isArrayType(t) || c.isTupleType(t) ? 'Array' : t.getSymbol()?.name;
			const own = () => this.slotFor(e);
			const recvParts = (p: Part) => this.flow(recv).from.map(([s]) => this.child(s, p));
			if (kind === 'Array' && ONE_ELEMENT.has(name)) return { states: U | M | this.absent(e) | optional, from: recvParts('element').map((s): [Slot, number] => [s, ~0]) };
			if (kind === 'Array' && SAME_ELEMENTS.has(name)) {
				for (const s of recvParts('element')) this.share(this.child(own(), 'element'), s);
				return { states: optional, from: [[own(), ~0]] };
			}
			if (kind === 'Array' && (name === 'map' || name === 'flatMap')) {
				const fn = e.arguments[0] && this.functionDeclarationOf(e.arguments[0]);
				const r = fn && this.resultOf(fn);
				if (r && name === 'map') this.share(this.child(own(), 'element'), r);
				return { states: optional, from: [[own(), ~0]] };
			}
			if (kind === 'Array' && name === 'reduce') {
				const fn = e.arguments[0] && this.functionDeclarationOf(e.arguments[0]);
				const r = fn && this.resultOf(fn);
				return r ? { states: optional, from: [[r, ~0]] } : { states: this.unknownStates(e) | optional, from: [] };
			}
			if (((kind === 'Map' || kind === 'ReadonlyMap') && name === 'values') || ((kind === 'Set' || kind === 'ReadonlySet') && (name === 'values' || name === 'keys'))) {
				for (const s of recvParts(kind === 'Map' || kind === 'ReadonlyMap' ? 'value' : 'element')) this.share(s, this.child(own(), 'element'));
				return { states: optional, from: [[own(), ~0]] };
			}
			if (ts.isIdentifier(recv) && recv.text === 'Array' && name === 'from' && e.arguments.length === 1 && !ts.isSpreadElement(e.arguments[0]) && this.partOf(c.getTypeAtLocation(e))) {
				const source = c.getNonNullableType(c.getTypeAtLocation(e.arguments[0])).getSymbol()?.name;
				if (source !== 'Map' && source !== 'ReadonlyMap') {
					this.placeElements(e.arguments[0], this.child(own(), 'element'), 'element', true);
					return { states: optional, from: [[own(), ~0]] };
				}
			}
			// `map.set(k, v)` and `set.add(v)` give the receiver itself.
			if ((kind === 'Map' && name === 'set') || (kind === 'Set' && name === 'add')) return { states: optional, from: this.flow(recv).from };
			if ((kind === 'Map' || kind === 'ReadonlyMap') && name === 'get') return { states: U | this.absent(e) | optional, from: recvParts('value').map((s): [Slot, number] => [s, ~0]) };
			if (kind === 'Promise' && name === 'then') {
				const fn = e.arguments[0] && this.functionDeclarationOf(e.arguments[0]);
				const r = fn && this.resultOf(fn);
				if (r) this.share(this.child(own(), 'result'), r);
				return { states: optional, from: [[own(), ~0]] };
			}
			if (t.flags & ts.TypeFlags.StringLike && name === 'split' && e.arguments[0] && regexpMayLeaveGroupUnset(e.arguments[0], c)) {
				this.seed(this.child(own(), 'element'), U | M | this.absent(e) | this.given(e));
				return { states: optional, from: [[own(), ~0]] };
			}
			if (ts.isIdentifier(recv) && recv.text === 'Object' && name === 'values' && e.arguments[0] && !ts.isSpreadElement(e.arguments[0])) {
				const arg0 = ts.skipOuterExpressions(e.arguments[0]);
				const ds: ts.Declaration[] = ts.isObjectLiteralExpression(arg0)
					? arg0.properties.filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
					: c
							.getNonNullableType(c.getTypeAtLocation(arg0))
							.getProperties()
							.map((p) => p.valueDeclaration ?? p.declarations?.[0])
							.filter((d): d is ts.Declaration => !!d && !declarationFile(d));
				if (ds.length) {
					const el = this.child(own(), 'element');
					for (const d of ds) {
						const dsSlot = this.slotFor(d);
						this.edges.push([dsSlot, el, ~0]);
						const dt = ts.isPropertyAssignment(d) ? c.getTypeAtLocation(d.initializer) : c.getTypeAtLocation(d);
						if (this.partOf(dt) === 'element') this.edges.push([this.child(dsSlot, 'element'), this.child(el, 'element'), ~0]);
					}
					return { states: optional, from: [[own(), ~0]] };
				}
			}
			if (ts.isIdentifier(recv) && recv.text === 'Promise' && name === 'resolve' && e.arguments[0]) {
				this.place(e.arguments[0], this.child(own(), 'result'));
				return { states: 0, from: [[own(), ~0]] };
			}
		}
		const signal = !e.arguments.length && this.signalValue(e);
		if (signal) return { states: optional, from: [[signal, ~0]] };
		const invoked = this.invokedThrough(e);
		if (invoked) return { states: optional, from: [[this.slotFor(invoked), ~0]] };
		const d = c.getResolvedSignature(e)?.getDeclaration();
		if (!d || ts.isJSDocSignature(d)) return { states: this.unknownStates(e) | optional, from: [] };
		if (declarationFile(d)) return { states: this.libraryStates(e, d) | optional, from: [] };
		if ((d as ts.FunctionLikeDeclaration).asteriskToken || ts.isConstructorDeclaration(d)) return { states: optional, from: [] };
		return { states: optional, from: [[this.slotFor(d), ~0]] };
	},

	/**
	 * The value a signal read (`this.note()`) gives where the signal is held as `JSNullish<T>`: null and undefined both,
	 * told apart, as a binding or `set` may hand it either.
	 */
	signalValue(this: Forms, e: ts.CallExpression): Slot | null {
		if (!nullishSignalType(this.checker, this.checker.getTypeAtLocation(e.expression), this.signalKind)) return null;
		const name = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
		const key = this.checker.getSymbolAtLocation(name)?.valueDeclaration ?? e;
		let s = this.signalValues.get(key);
		if (!s) {
			s = new Slot(this.checker.getTypeAtLocation(e));
			s.states = s.local = U | N;
			s.fixed = s.observed = true;
			this.made.push(s);
			this.signalValues.set(key, s);
		}
		return s;
	},

	/** A read of `slot` at `e`: less what narrowing proves absent there, and a default's value for a missing one. */
	read(this: Forms, slot: Slot, e: ts.Expression, d: ts.Declaration): Flow {
		const keep = ~this.narrowed(e, d);
		const init = (ts.isParameter(d) || ts.isBindingElement(d)) && !isTemplateDefault(d) && d.initializer;
		if (!init) return { states: 0, from: [[slot, keep]] };
		return merge({ states: 0, from: [[slot, keep & ~(U | M | O)]] }, mask(this.flow(init), keep));
	},

	/** The states a read at `e` is proved not to hold: by the checker's narrowing in strict code, by its guards in other code. */
	narrowed(this: Forms, e: ts.Expression, d: ts.Declaration): number {
		if (isWriteTarget(e)) return 0;
		if (this.strict(e)) {
			const declared = typeStates(this.declaredType(d) ?? undefined),
				here = typeStates(this.checker.getTypeAtLocation(e));
			return dropsAbsent(withMissing(declared & ~here & (U | N)));
		}
		return dropsAbsent(withMissing(guarded(e, d)));
	},

	/**
	 * A library's value: its declared type node, in strict code the checker's type there, and a platform binding's nil.
	 * Read by a non-strict app, a kit's or plugin's typed object (not JavaScript's or a platform's) may be empty: its
	 * typings, written without strictNullChecks, say nothing of null, and its binding holds nil for one.
	 */
	libraryStates(this: Forms, e: ts.Expression, d: ts.Declaration): number {
		let s = typeNodeStates((d as { type?: ts.TypeNode }).type) | (this.nativeNil(d) ? N : 0);
		if ((d as { questionToken?: ts.Node }).questionToken && !ts.isMethodDeclaration(d) && !ts.isMethodSignature(d)) s |= U;
		// No match, which code checked without strictNullChecks reads as one: a missing value it finds there.
		if (uncheckedMatch(e, this.checker)) s |= N | this.absent(e);
		if (this.strict(e)) s |= typeStates(this.checker.getTypeAtLocation(e));
		else if (!this.library && !LIB_FILE.test(d.getSourceFile().fileName) && !this.native(d) && objectValue(this.checker.getTypeAtLocation(e))) s |= U | N;
		return s;
	},

	/** `A` where the program's own code reads or returns a missing value. */
	absent(this: Forms, n: ts.Node): number {
		return this.ownCode(n) ? A : 0;
	},

	/** `G` where the program's own code gives an empty value. */
	given(this: Forms, n: ts.Node): number {
		return this.ownCode(n) ? G : 0;
	},

	/** Whether a node's file is checked with strictNullChecks; a node a transform made has none. */
	strict(this: Forms, n: ts.Node): boolean {
		const file = sourceOf(n);
		return !!file && this.strictFile(file);
	},

	unknownStates(this: Forms, e: ts.Node): number {
		const t = this.checker.getTypeAtLocation(e);
		if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return F | U | N;
		return this.strict(e) ? typeStates(t) : 0;
	},
};

export type ResultsMethods = typeof resultsMethods;
