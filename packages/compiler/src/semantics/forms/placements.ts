// Every place the program puts a value into a slot, and the states each brings.
import ts from 'typescript';
import { A, F, G, H, M, N, O, U, declarationFile, isGeneric, mask, merge, shapes, typeStates, untyped, valueParameters, withAbsent, type Flow, type Slot } from './flow.ts';
import type { Forms } from './forms.ts';

export const placementsMethods = {
	place(this: Forms, value: ts.Expression, target: Slot): void {
		const f = this.parts.has(target) ? this.storedFlow(value) : this.flow(value);
		const t = this.find(target);
		if (!t.fixed && !t.generic) t.give(f.states);
		else if (!t.fixed) {
			const states = f.states & this.instantiated(value),
				at = this.checker.getContextualType(value);
			t.states |= states;
			// The generic code's own value (placed at a `T`), not one an instantiation gives.
			if (!at || isGeneric(at)) t.local |= states;
		}
		const x = ts.skipOuterExpressions(value, ts.OuterExpressionKinds.Parentheses);
		const into = this.placed.get(x);
		if (into) into.push(target);
		else this.placed.set(x, [target]);
		if (!t.fixed && t.type && untyped(t.type)) this.placedUntyped.add(x);
		const d = target.decl;
		if (d && declarationFile(d) && !ts.isParameter(d) && !ts.isFunctionLike(d) && this.unseenReader(d)) this.observe(value);
		for (const [s, keep] of f.from) {
			this.edges.push([s, target, keep]);
			this.aliases.push([s, target]);
		}
	},

	/** What a value stored as an element or value gives: `!` asserts nothing at run time, so the undefined it may be is stored. */
	storedFlow(this: Forms, value: ts.Expression): Flow {
		const x = ts.skipOuterExpressions(value, ts.OuterExpressionKinds.Parentheses);
		if (ts.isNonNullExpression(x)) return mask(this.flow(x.expression), ~(N | H));
		if (ts.isConditionalExpression(x)) return merge(this.storedFlow(x.whenTrue), this.storedFlow(x.whenFalse));
		const def = ts.isIdentifier(x) ? this.reachingValue(x) : null;
		return def ? this.storedFlow(def) : this.flow(value);
	},

	/**
	 * The value a local variable's read is sure to hold: the last `x = v` (or its initializer) before it in its own or an
	 * enclosing block, with nothing between that may assign it, and no loop or function between whose body assigns it.
	 * Its declared type may leave out an empty value an earlier write gave it, which the checker then can't narrow away.
	 */
	reachingValue(this: Forms, e: ts.Identifier): ts.Expression | null {
		const sym = this.checker.getSymbolAtLocation(e);
		const d = sym?.valueDeclaration;
		if (!sym || !d || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || sym.declarations!.length > 1) return null;
		const assigns = (n: ts.Node): boolean =>
			(ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(ts.skipOuterExpressions(n.left)) && this.checker.getSymbolAtLocation(ts.skipOuterExpressions(n.left)) === sym) ||
			((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(n.operand) && this.checker.getSymbolAtLocation(n.operand) === sym) ||
			((ts.isForInStatement(n) || ts.isForOfStatement(n)) && ts.isIdentifier(n.initializer) && this.checker.getSymbolAtLocation(n.initializer) === sym) ||
			!!ts.forEachChild(n, assigns);
		for (let x: ts.Node = e; x.parent; x = x.parent) {
			const p = x.parent;
			if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return null;
			if (ts.isIterationStatement(p, false) && p.statement === x && assigns(p)) return null;
			if (!ts.isBlock(p) && !ts.isCaseClause(p) && !ts.isDefaultClause(p)) continue;
			const k = p.statements.indexOf(x as ts.Statement);
			for (let j = k - 1; j >= 0; j--) {
				const st = p.statements[j];
				if (ts.isVariableStatement(st) && st.declarationList.declarations.includes(d)) return d.initializer ?? null;
				const ex = ts.isExpressionStatement(st) ? ts.skipOuterExpressions(st.expression) : null;
				if (ex && ts.isBinaryExpression(ex) && ex.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(ex.left) && this.checker.getSymbolAtLocation(ex.left) === sym && !assigns(ex.right)) return ex.right;
				if (assigns(st)) return null;
			}
		}
		return null;
	},

	/** What the instantiation a value is placed at admits, into a slot typed by a type parameter. */
	instantiated(this: Forms, value: ts.Expression): number {
		const at = this.checker.getContextualType(value);
		if (!at || !this.strict(value) || isGeneric(at)) return ~F;
		return ~F & ~((U | M | O | N | A | G) & ~withAbsent(typeStates(at)));
	},

	seed(this: Forms, target: Slot, states: number): void {
		const t = this.find(target);
		if (t.generic) states &= ~F;
		if (!t.fixed) t.give(states);
	},

	/** Every function value `fn` takes `sig`'s parameters and result: they share one form. */
	unionSignature(this: Forms, fn: ts.SignatureDeclaration, sig: ts.SignatureDeclaration): void {
		if (fn === sig) return;
		// Callers of `sig` give `fn`'s arguments; `fn`'s result is `sig`'s.
		const theirs = valueParameters(sig);
		valueParameters(fn).forEach((p, k) => {
			const q = theirs[k];
			if (!q || !q.dotDotDotToken !== !p.dotDotDotToken) return;
			this.share(this.slotFor(q), this.slotFor(p), true);
			// Parameters of function type share their signatures too: a function given for one is called through the other.
			if (p.type && q.type && ts.isFunctionTypeNode(p.type) && ts.isFunctionTypeNode(q.type)) this.unionSignature(p.type, q.type);
		});
		if (!(fn as ts.FunctionLikeDeclaration).asteriskToken && !(sig as ts.FunctionLikeDeclaration).asteriskToken && !ts.isConstructorDeclaration(fn)) this.share(this.slotFor(fn), this.slotFor(sig), true);
	},
	giveElementsOf(this: Forms, fn: ts.SignatureDeclaration | null, k: number, container: ts.Expression): void {
		const p = fn && valueParameters(fn)[k];
		if (p && !p.dotDotDotToken && !declarationFile(p)) this.elementSourceOf.set(p, [...(this.elementSourceOf.get(p) ?? []), container]);
	},
	/** The containers whose elements `p` is given as an array method's callback parameter. */
	elementSources(this: Forms, p: ts.ParameterDeclaration): readonly ts.Expression[] {
		this.build();
		return this.elementSourceOf.get(p) ?? [];
	},

	/** The functions a callback argument may be: its own, or each branch's of a choice. */
	chosenFunctions(this: Forms, e: ts.Expression | undefined): ts.SignatureDeclaration[] {
		if (!e) return [];
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (ts.isConditionalExpression(x)) return [...this.chosenFunctions(x.whenTrue), ...this.chosenFunctions(x.whenFalse)];
		const fn = this.functionDeclarationOf(x);
		return fn ? [fn] : [];
	},

	functionDeclarationOf(this: Forms, e: ts.Expression): ts.SignatureDeclaration | null {
		const x = ts.skipOuterExpressions(e);
		if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return x;
		// `f.bind(thisArg)` is `f` with its parameters as they were.
		if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'bind' && x.arguments.length <= 1) return this.functionDeclarationOf(x.expression.expression);
		if (!ts.isIdentifier(x) && !ts.isPropertyAccessExpression(x)) return null;
		const d = this.declarationOf(ts.isPropertyAccessExpression(x) ? x.name : x);
		if (d && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body) return d;
		if (d && (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) && d.initializer && !d.type) return this.functionDeclarationOf(d.initializer);
		return null;
	},

	/** The program's own function type a variable, parameter or field holding a function is declared with. */
	functionTypeOf(this: Forms, e: ts.Expression): ts.SignatureDeclaration | null {
		if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return null;
		const d = this.declarationOf(ts.isPropertyAccessExpression(e) ? e.name : e);
		if (!d || !(ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) || !d.type || declarationFile(d)) return null;
		const sigs = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e)).getCallSignatures();
		const sig = sigs.length === 1 ? sigs[0].getDeclaration() : undefined;
		return sig && !ts.isJSDocSignature(sig) && (ts.isFunctionTypeNode(sig) || ts.isCallSignatureDeclaration(sig)) && !declarationFile(sig) ? sig : null;
	},

	declarationOf(this: Forms, name: ts.Node): ts.Declaration | undefined {
		let sym = ts.isShorthandPropertyAssignment(name.parent) && name.parent.name === name ? this.checker.getShorthandAssignmentValueSymbol(name.parent) : this.checker.getSymbolAtLocation(name);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
		return sym?.valueDeclaration ?? sym?.declarations?.[0];
	},

	/** Builds the placement graph and runs the fixpoint, once; `formOf` and `formOfSlot` do it when first asked. */
	build(this: Forms): void {
		if (this.built) return;
		this.built = true;
		const start = performance.now();
		for (const f of this.files) if (!f.isDeclarationFile) this.visit(f);
		for (const d of this.unwritten) if (!this.written.has(d)) this.seed(this.slotFor(d), U | this.given(d));
		if (this.library) this.openLibrarySurface();
		this.openCalledByName();
		// Arrays, Maps and Promises are shared storage: wherever one flows, its elements are the same slot.
		for (let changed = true; changed;) {
			changed = false;
			for (const [a, b] of this.aliases) {
				const x = this.find(a),
					y = this.find(b);
				if (x !== y && x.fixed !== y.fixed && this.holdsElements(x.fixed ? x : y)) this.pinned.add(x.fixed ? y : x);
				// A container read from or stored as another's element or value: its storage is that element's.
				if (x !== y && this.parts.has(a) !== this.parts.has(b)) this.pinned.add(this.parts.has(a) ? y : x);
				// An untyped slot holds whatever it is given: the typed containers read from one share nothing through it.
				if (x === y || x.fixed || y.fixed || [x, y].some((s) => s.type && s.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) continue;
				for (const p of new Set([...x.children.keys(), ...y.children.keys()])) {
					const cx = this.child(x, p),
						cy = this.child(y, p);
					if (cx !== cy && this.share(cx, cy)) changed = true;
				}
			}
		}
		this.findByName();
		this.openEscaped();
		const out = new Map<Slot, [Slot, number][]>();
		for (const [from, to, keep] of this.edges) {
			const x = this.find(from),
				y = this.find(to);
			if (x === y || y.fixed) continue;
			const list = out.get(x);
			if (list) list.push([y, keep]);
			else out.set(x, [[y, keep]]);
		}
		this.propagate(out, [...out.keys()]);
		for (let opened = this.openForeignShapes(); opened.length; opened = this.openForeignShapes()) this.propagate(out, opened);
		this.propagateObserved();
		this.propagateTypeObserved();
		this.solved = true;
		this.buildMs = performance.now() - start;
	},

	propagate(this: Forms, out: Map<Slot, [Slot, number][]>, work: Slot[]): void {
		while (work.length) {
			const x = work.pop()!;
			for (const [y, keep] of out.get(x) ?? []) {
				const r = this.find(y);
				if (r.fixed) continue;
				let more = x.states & keep & ~r.states;
				if (x.generic !== r.generic) more &= this.crossing(x.generic ? r : x, r.generic);
				// What crosses into a `T` from a concrete slot is an instantiation's.
				const local = x.generic && r.generic ? x.local & keep & ~r.local : 0;
				if (more || local) {
					r.states |= more;
					r.local |= local;
					work.push(r);
				}
			}
		}
	},

	/**
	 * A foreign value held as an interface or object literal type has its keys, not the type's: each field of the
	 * type may be missing, null or another type, and so may a foreign array's or Map's elements, and a foreign function's
	 * (or a shape's method's) parameters and result. A class's instance is its class's or fails the cast. Returns the
	 * slots this widened.
	 */
	openForeignShapes(this: Forms): Slot[] {
		const widened: Slot[] = [];
		const open = (s: Slot) => {
			const r = this.find(s);
			if (r.fixed || r.generic) return;
			// The untyped code that shares the object reads its fields where the program can't see.
			r.observed = true;
			if ((r.states & (U | N | F)) === (U | N | F)) return;
			r.give(U | N | F);
			widened.push(r);
		};
		const openSignature = (sig: ts.Signature | ts.Declaration | undefined) => {
			const d = sig && 'getDeclaration' in sig ? sig.getDeclaration() : (sig as ts.Declaration | undefined);
			if (!d || ts.isJSDocSignature(d) || !ts.isFunctionLike(d) || declarationFile(d) || this.openedSignatures.has(d)) return;
			this.openedSignatures.add(d);
			for (const p of d.parameters) if (!p.dotDotDotToken) open(this.slotFor(p));
			const result = ts.isConstructorDeclaration(d) || ts.isSetAccessorDeclaration(d) ? null : this.resultOf(d);
			if (result) open(result);
		};
		for (const s of [...this.made]) {
			const r = this.find(s);
			if (!(r.states & F) || r.generic || !r.type) continue;
			for (const c of r.children.values()) open(c);
			const whole = this.checker.getNonNullableType(r.type);
			for (const m of whole.isUnion() ? whole.types : [whole]) if (!m.isClass()) m.getCallSignatures().forEach(openSignature);
			for (const t of shapes(this.checker, r.type)) {
				if (this.openedShapes.has(t)) continue;
				this.openedShapes.add(t);
				for (const p of this.checker.getPropertiesOfType(t)) {
					const d = p.valueDeclaration;
					if (d && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && !declarationFile(d)) open(this.slotFor(d));
					if (d && ts.isMethodSignature(d)) openSignature(d);
				}
			}
		}
		return widened;
	},
};

export type PlacementsMethods = typeof placementsMethods;
