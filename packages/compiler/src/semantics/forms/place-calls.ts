// Where a call, an assignment's parts or a binding place their values: arguments into parameters, parts into the slots they fill, functions into the slots that hold them.
import ts from 'typescript';
import { ELEMENT_CALLBACKS, F, H, M, N, O, U, declarationFile, isCalleeOrName, untyped, valueParameters, type Part, type Slot } from './flow.ts';
import type { Forms } from './forms.ts';
import { LIB_FILE } from '../trust.ts';
import { literalKey } from '../lang.ts';
import { patternSource, patternTargets } from '../placement.ts';
import { regexpMayLeaveGroupUnset } from '../regexp.ts';

export const placeCallsMethods = {
	/** A literal placed where no type says what reads its fields or elements. */
	untypedContext(this: Forms, literal: ts.Expression): boolean {
		const t = this.checker.getContextualType(literal);
		return !!t && untyped(t);
	},

	/** Elements of `source` (an array, a Set, a Map's entries, a Promise's result for `for await`) placed in `target`. */
	placeElements(this: Forms, source: ts.Expression, target: Slot, part: Part | null, copy = false): void {
		const f = this.flow(source);
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(source));
		const p: Part = part ?? (t.getSymbol()?.name === 'Map' ? 'value' : 'element');
		for (const [s] of f.from) {
			const from = this.child(s, p);
			this.edges.push([from, target, ~0]);
			if (copy) this.copies.push([from, target]);
		}
		if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) this.seed(target, F | U | N);
	},

	/**
	 * The variables a destructuring assignment's pattern (or a `for…of`'s target) writes: from an untyped value whatever it
	 * holds there; from a typed one, what the value's member or element holds, as a declaration's pattern reads it.
	 */
	placeAssignedParts(this: Forms, pattern: ts.Expression, whole: ts.Expression, iterated: boolean): void {
		if (!(this.checker.getTypeAtLocation(whole).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
			if (!iterated) this.placeTypedParts(pattern, whole);
			return;
		}
		for (const t of iterated ? patternTargets(pattern) : patternTargets(pattern).filter((t) => t !== pattern)) {
			const short = ts.isShorthandPropertyAssignment(t.parent) && t.parent.name === t ? t.parent : null;
			const d = ts.isIdentifier(t) ? (short ? this.checker.getShorthandAssignmentValueSymbol(short) : this.checker.getSymbolAtLocation(t))?.valueDeclaration : undefined;
			if (d && (ts.isVariableDeclaration(d) || ts.isParameter(d)) && !declarationFile(d)) this.seed(this.slotFor(d), F);
		}
	},

	/** `placeAssignedParts` from a typed value: each variable or field a pattern's own member or element writes. */
	placeTypedParts(this: Forms, pattern: ts.Expression, whole: ts.Expression): void {
		const c = this.checker;
		const slotOfTarget = (t: ts.Expression): Slot | null => {
			const x = ts.skipOuterExpressions(t, ts.OuterExpressionKinds.Parentheses);
			const short = ts.isShorthandPropertyAssignment(x.parent) && x.parent.name === x ? x.parent : null;
			const named = ts.isIdentifier(x) ? x : ts.isPropertyAccessExpression(x) ? x.name : null;
			const d = named && (short ? c.getShorthandAssignmentValueSymbol(short) : c.getSymbolAtLocation(named))?.valueDeclaration;
			return d && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d)) && !declarationFile(d) ? this.slotFor(d) : null;
		};
		const assign = (target: ts.Expression, from: Slot[], dflt: ts.Expression | undefined, past: number) => {
			const slot = slotOfTarget(target);
			if (!slot) return;
			const keep = dflt ? ~(U | M | O) : ~0;
			for (const s of from) {
				this.edges.push([s, slot, keep]);
				if (dflt) this.observedSlots.push(s);
			}
			if (past) this.seed(slot, past & keep);
		};
		if (ts.isObjectLiteralExpression(pattern)) {
			const source = c.getTypeAtLocation(whole);
			for (const p of pattern.properties) {
				const key = ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) ? literalKey(p.name, c) : null;
				if (key === null) continue;
				const d = source.getProperty(key)?.valueDeclaration;
				const from = d && !declarationFile(d) ? [this.slotFor(d)] : [];
				if (ts.isShorthandPropertyAssignment(p)) assign(p.name, from, p.objectAssignmentInitializer, 0);
				else if (ts.isPropertyAssignment(p)) {
					const t = ts.skipOuterExpressions(p.initializer, ts.OuterExpressionKinds.Parentheses);
					const dflt = ts.isBinaryExpression(t) && t.operatorToken.kind === ts.SyntaxKind.EqualsToken ? t : null;
					assign(dflt ? dflt.left : t, from, dflt?.right, 0);
				}
			}
		} else if (ts.isArrayLiteralExpression(pattern) && !c.isTupleType(c.getNonNullableType(c.getTypeAtLocation(whole)))) {
			// An array may end before the pattern does; a literal long enough doesn't. A tuple's elements are each their own,
			// which no slot part keeps apart.
			const from = this.flow(whole).from.map(([s]) => this.child(s, 'element'));
			const literal = ts.skipOuterExpressions(whole, ts.OuterExpressionKinds.Parentheses);
			const past = ts.isArrayLiteralExpression(literal) && !literal.elements.some(ts.isSpreadElement) && literal.elements.length >= pattern.elements.length ? 0 : U | M;
			for (const e of pattern.elements) {
				if (ts.isOmittedExpression(e) || ts.isSpreadElement(e)) continue;
				const t = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
				const dflt = ts.isBinaryExpression(t) && t.operatorToken.kind === ts.SyntaxKind.EqualsToken ? t : null;
				assign(dflt ? dflt.left : t, from, dflt?.right, past);
			}
		}
	},

	placeBinding(this: Forms, b: ts.BindingElement): void {
		const slot = this.slotFor(b);
		if (b.initializer) this.place(b.initializer, slot);
		const keep = b.initializer ? ~(U | M | O) : ~0;
		const pattern = b.parent;
		// What a pattern reads from an untyped value is whatever that value holds there, whatever the pattern's type says.
		const whole = patternSource(b);
		if (whole && !whole.iterated && this.checker.getTypeAtLocation(whole.whole).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) this.seed(slot, F);
		if (ts.isObjectBindingPattern(pattern)) {
			if (b.dotDotDotToken) return;
			const key = b.propertyName ? literalKey(b.propertyName, this.checker) : (b.name as ts.Identifier).text;
			const prop = key !== null ? this.checker.getTypeAtLocation(pattern).getProperty(key) : undefined;
			const d = prop?.valueDeclaration ?? prop?.declarations?.[0];
			if (d) {
				this.edges.push([this.slotFor(d), slot, keep]);
				if (b.initializer) this.observedSlots.push(this.slotFor(d));
			} else this.seed(slot, this.unknownStates(b.name as ts.Identifier) & keep);
			return;
		}
		if (b.dotDotDotToken) return;
		const holder = pattern.parent;
		const source = ts.isVariableDeclaration(holder) ? holder.initializer : undefined;
		if (!source) {
			this.seed(slot, this.unknownStates(b.name as ts.Identifier) & keep);
			return;
		}
		for (const [s] of this.flow(source).from) {
			this.edges.push([this.child(s, 'element'), slot, keep]);
			if (b.initializer) this.observedSlots.push(this.child(s, 'element'));
		}
		this.seed(slot, (U | M) & keep);
	},

	/** Arguments a call gives beyond `slotOf`'s: missing ones, rest elements, pushes, callbacks of arrays, Maps and Promises. */
	placeCall(this: Forms, call: ts.CallExpression | ts.NewExpression): void {
		const c = this.checker;
		const args = call.arguments ?? ts.factory.createNodeArray<ts.Expression>();
		const sig = c.getResolvedSignature(call)?.getDeclaration();
		if (!sig || ts.isJSDocSignature(sig)) this.observeArguments(call, undefined, args);
		else if (declarationFile(sig)) this.observeArguments(call, sig, args);
		if (sig && !ts.isJSDocSignature(sig) && !declarationFile(sig)) {
			const spread = args.findIndex(ts.isSpreadElement);
			valueParameters(sig).forEach((p, k) => {
				if ((p.initializer || p.questionToken) && !p.dotDotDotToken && (spread < 0 || k < spread) && k < args.length) this.givenArguments.push([p, args[k]]);
				if (!p.initializer || p.dotDotDotToken) return;
				if (spread >= 0 && k >= spread) this.spreadDefaults.add(p);
				else if (k < args.length) this.defaultArguments.push([p, args[k]]);
			});
		}
		if (sig && !ts.isJSDocSignature(sig) && !declarationFile(sig) && !args.some(ts.isSpreadElement)) {
			valueParameters(sig).forEach((p, k) => {
				if (p.dotDotDotToken) {
					for (const a of args.slice(k)) this.place(a, this.child(this.slotFor(p), 'element'));
				} else if (k >= args.length) this.seed(this.slotFor(p), U | M | this.given(call));
			});
		}
		if (ts.isNewExpression(call)) {
			this.placeConstructed(call, args);
			return;
		}
		if (!ts.isPropertyAccessExpression(call.expression)) return;
		const name = call.expression.name.text,
			recv = call.expression.expression;
		// These calls' results share or copy their source's elements when their flow is computed, which must be in the build.
		if (name === 'values' || name === 'keys' || name === 'from' || name === 'concat' || name === 'split') this.flow(call);
		const invoked = this.invokedThrough(call);
		if (invoked && name === 'call')
			valueParameters(invoked).forEach((p, k) => {
				if (p.dotDotDotToken) {
					for (const a of args.slice(k + 1)) this.place(a, this.child(this.slotFor(p), 'element'));
				} else if (args[k + 1]) this.place(args[k + 1], this.slotFor(p));
				else this.seed(this.slotFor(p), U | M | this.given(call));
			});
		if (invoked && name === 'apply') {
			if (args[1]) for (const p of valueParameters(invoked)) this.placeElements(args[1], p.dotDotDotToken ? this.child(this.slotFor(p), 'element') : this.slotFor(p), null);
			const list = args[1] && ts.skipOuterExpressions(args[1]);
			const given = list && ts.isArrayLiteralExpression(list) && !list.elements.some(ts.isSpreadElement) ? list.elements.length : 0;
			valueParameters(invoked).forEach((p, k) => {
				if (!p.dotDotDotToken && k >= given) this.seed(this.slotFor(p), U | M | this.given(call));
			});
		}
		const t = c.getNonNullableType(c.getTypeAtLocation(recv));
		const kind = c.isArrayType(t) || c.isTupleType(t) ? 'Array' : t.getSymbol()?.name;
		const recvSlots = () => this.flow(recv).from.map(([s]) => s);
		const callback = (k: number) => (args[k] ? this.functionDeclarationOf(args[k]) : null);
		const giveParam = (fn: ts.SignatureDeclaration | null, k: number, from: Slot[], states = 0) => {
			const p = fn && valueParameters(fn)[k];
			if (!p) return;
			// The callback's parameter is typed by the elements it is given: one representation with them.
			for (const s of from) {
				this.edges.push([s, this.slotFor(p), ~0]);
				this.copies.push([s, this.slotFor(p)]);
			}
			if (states) this.seed(this.slotFor(p), states);
		};
		if (kind === 'Array') {
			if (name === 'push' || name === 'unshift') for (const s of recvSlots()) for (const a of args) this.place(a, this.child(s, 'element'));
			if (name === 'splice') for (const s of recvSlots()) for (const a of args.slice(2)) this.place(a, this.child(s, 'element'));
			if (name === 'fill' && args[0]) for (const s of recvSlots()) this.place(args[0], this.child(s, 'element'));
			if (name === 'concat')
				for (const a of args) {
					const into = this.child(this.slotFor(call), 'element'),
						at = c.getNonNullableType(c.getTypeAtLocation(a));
					if (c.isArrayType(at) || c.isTupleType(at)) this.placeElements(a, into, 'element', true);
					else this.place(a, into);
				}
			const elements = recvSlots().map((s) => this.child(s, 'element'));
			// Strict equality and SameValueZero tell a null element from an undefined one.
			if ((name === 'includes' || name === 'indexOf' || name === 'lastIndexOf') && args[0] && this.mayBeEmpty(args[0])) this.observedSlots.push(...elements);
			// The array a callback is given after the element and index is the receiver itself.
			const giveArray = (fn: ts.SignatureDeclaration | null, k: number) => {
				const p = fn && valueParameters(fn)[k];
				if (p && !p.dotDotDotToken) this.place(recv, this.slotFor(p));
			};
			// A choice of callbacks (`flag ? (v) => … : show`): each branch is given the elements.
			if (ELEMENT_CALLBACKS.has(name))
				for (const fn of this.chosenFunctions(args[0])) {
					giveParam(fn, 0, elements);
					giveArray(fn, 2);
					this.giveElementsOf(fn, 0, recv);
				}
			if (name === 'sort' || name === 'toSorted') {
				giveParam(callback(0), 0, elements);
				giveParam(callback(0), 1, elements);
			}
			if (name === 'reduce' || name === 'reduceRight')
				for (const fn of this.chosenFunctions(args[0])) {
					giveParam(fn, 1, elements);
					giveArray(fn, 3);
					this.giveElementsOf(fn, 1, recv);
					const acc = valueParameters(fn)[0];
					if (acc) {
						if (args[1]) this.place(args[1], this.slotFor(acc));
						else giveParam(fn, 0, elements);
						const r = this.resultOf(fn);
						if (r) this.edges.push([r, this.slotFor(acc), ~0]);
					}
				}
			return;
		}
		if (kind === 'Set' && name === 'add') for (const s of recvSlots()) this.place(args[0], this.child(s, 'element'));
		if (kind === 'Set' && name === 'forEach')
			for (const fn of this.chosenFunctions(args[0]))
				giveParam(
					fn,
					0,
					recvSlots().map((s) => this.child(s, 'element')),
				);
		if (kind === 'Map' && name === 'set' && args[1]) for (const s of recvSlots()) this.place(args[1], this.child(s, 'value'));
		if (kind === 'Map' && name === 'forEach')
			for (const fn of this.chosenFunctions(args[0]))
				giveParam(
					fn,
					0,
					recvSlots().map((s) => this.child(s, 'value')),
				);
		if (kind === 'Promise' && (name === 'then' || name === 'finally')) giveParam(callback(0), 0, name === 'then' ? recvSlots().map((s) => this.child(s, 'result')) : []);
		if (t.flags & ts.TypeFlags.StringLike && (name === 'replace' || name === 'replaceAll') && args[0] && regexpMayLeaveGroupUnset(args[0], c)) {
			const fn = callback(1);
			if (fn)
				valueParameters(fn).forEach((p, k) => {
					if (k > 0 && !p.dotDotDotToken) this.seed(this.slotFor(p), U);
				});
		}
	},

	/** What `new Array(…)`, `new Set(values)` and `new Map(entries)` start with. */
	placeConstructed(this: Forms, e: ts.NewExpression, args: ts.NodeArray<ts.Expression>): void {
		const part = this.partOf(this.checker.getTypeAtLocation(e));
		if (!part || part === 'result' || !args.length) return;
		const own = this.child(this.slotFor(e), part);
		const name = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e)).getSymbol()?.name;
		if (name === 'Map' || name === 'WeakMap') {
			const entries = ts.skipOuterExpressions(args[0]);
			if (ts.isArrayLiteralExpression(entries)) {
				for (const x of entries.elements) {
					const pair = ts.skipOuterExpressions(x);
					if (ts.isArrayLiteralExpression(pair) && pair.elements[1]) this.place(pair.elements[1], own);
					else if (!ts.isArrayLiteralExpression(pair)) this.seed(own, F | U | N);
				}
			} else for (const [s] of this.flow(args[0]).from) this.edges.push([this.child(this.child(s, 'element'), 'element'), own, ~0]);
		} else if (name === 'Set' || name === 'WeakSet') this.placeElements(args[0], own, 'element', true);
		else if (args.length === 1 && this.checker.getTypeAtLocation(args[0]).flags & ts.TypeFlags.NumberLike) this.seed(own, H | U | M);
		else for (const a of args) this.place(a, own);
	},

	/** The program's own function `f.call(thisArg, …)` or `f.apply(thisArg, args)` invokes. */
	invokedThrough(this: Forms, call: ts.CallExpression): ts.SignatureDeclaration | null {
		if (!ts.isPropertyAccessExpression(call.expression) || !['call', 'apply'].includes(call.expression.name.text)) return null;
		const recv = call.expression.expression,
			c = this.checker;
		const d = this.functionDeclarationOf(recv) ?? c.getNonNullableType(c.getTypeAtLocation(recv)).getCallSignatures()[0]?.getDeclaration();
		return d && !ts.isJSDocSignature(d) && !declarationFile(d) ? d : null;
	},

	unionFunctionValue(this: Forms, e: ts.Expression): void {
		if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && isCalleeOrName(e)) return;
		const fn = this.functionDeclarationOf(e) ?? this.functionTypeOf(e);
		if (!fn) return;
		this.placeFunction(fn, this.slotTypeOf(e));
	},

	/** The type of the slot a value is placed in; a field of an untyped literal is untyped, which the checker leaves out. */
	slotTypeOf(this: Forms, e: ts.Expression): ts.Type | undefined {
		const c = this.checker;
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const field = (ts.isPropertyAssignment(x.parent) && x.parent.initializer === x) || (ts.isShorthandPropertyAssignment(x.parent) && x.parent.name === x) ? x.parent : null;
		const literal = field && c.getContextualType(field.parent);
		return literal && untyped(literal) ? literal : c.getContextualType(e);
	},

	/**
	 * A function value placed where `slot` is declared. The program's own function type shares one form with it; an
	 * untyped slot or a declaration file's function type is called where the program can't see (an entry point).
	 */
	placeFunction(this: Forms, fn: ts.SignatureDeclaration, slot: ts.Type | undefined): void {
		if (!slot) return;
		const result = () => {
			const r = this.resultOf(fn);
			if (r) this.observedSlots.push(r);
		};
		if (untyped(slot)) {
			this.openParameters(fn, { script: true });
			result();
			return;
		}
		const sig = this.checker.getNonNullableType(slot).getCallSignatures()[0]?.getDeclaration();
		if (!sig || ts.isJSDocSignature(sig) || sig === fn) return;
		if (!declarationFile(sig)) {
			this.unionSignature(fn, sig);
			return;
		}
		this.openParameters(fn, LIB_FILE.test(sig.getSourceFile().fileName) ? { lib: sig } : { platform: sig });
		if (this.unseenReader(sig)) result();
	},
};

export type PlaceCallsMethods = typeof placeCallsMethods;
